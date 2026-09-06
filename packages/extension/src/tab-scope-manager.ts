import type { PublishedTarget } from '@dvcol/cdb/protocol';

import type { SelectedTab, SelectedTabPublisher } from './selected-tab-publisher.js';
import type { ChromeTabScopeLifecyclePort } from './tab-scope-lifecycle.js';
import type { TabScopeSelector } from './tab-scope.js';

import { matchesTabScope, parseTabScopeSelector } from './tab-scope.js';

export interface TabScopeManagerOptions {
  readonly chrome: ChromeTabScopeLifecyclePort;
  /** Creates an exact-tab publisher shared by every approved scope containing that tab. */
  readonly createPublisher: (tab: SelectedTab) => SelectedTabPublisher;
  readonly onError?: (error: unknown) => void;
  /** Reconcile this scope's bindings only. An empty list removes its authority without affecting other scopes. */
  readonly onTargetsChanged?: (scopeId: string, targets: readonly PublishedTarget[]) => Promise<void> | void;
}

export interface TabScopeManager {
  addScope: (scopeId: string, selector: TabScopeSelector) => Promise<readonly PublishedTarget[]>;
  dispose: () => Promise<void>;
  getTargets: (scopeId: string) => readonly PublishedTarget[];
  removeScope: (scopeId: string) => Promise<void>;
  /** Mirror publisher publication/update callbacks, and pass undefined when its target is revoked. */
  updateTarget: (tabId: number, target: PublishedTarget | undefined) => void;
}

interface ManagedScope {
  readonly selector: TabScopeSelector;
  readonly snapshotTabIds: Set<number>;
  readonly targets: Map<number, PublishedTarget>;
}

interface ManagedTab {
  closed?: boolean;
  identity?: Pick<PublishedTarget, 'generation' | 'id'>;
  nextTab?: SelectedTab;
  publisher?: SelectedTabPublisher;
  tab: SelectedTab;
  target?: PublishedTarget;
}

/** Shares physical debugger attachments while keeping independently approved scope membership separate. */
export function createTabScopeManager(options: TabScopeManagerOptions): TabScopeManager {
  const scopes = new Map<string, ManagedScope>();
  const tabs = new Map<number, ManagedTab>();
  const operations = new Map<number, Promise<void>>();
  const notifications = new Map<string, Promise<void>>();
  const tabRevisions = new Map<number, number>();
  let revision = 0;
  let disposed = false;

  function report(operation: Promise<unknown>): void {
    void operation.catch(error => options.onError?.(error));
  }

  async function serialize(tabId: number, operation: () => Promise<void>): Promise<void> {
    const pending = (operations.get(tabId) ?? Promise.resolve()).catch(() => {}).then(operation);
    operations.set(tabId, pending);
    void pending.finally(() => {
      if (operations.get(tabId) === pending) operations.delete(tabId);
    }).catch(() => {});
    return pending;
  }

  async function notify(scopeId: string, targets: readonly PublishedTarget[]): Promise<void> {
    const pending = (notifications.get(scopeId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => options.onTargetsChanged?.(scopeId, targets));
    notifications.set(scopeId, pending);
    void pending.finally(() => {
      if (notifications.get(scopeId) === pending) notifications.delete(scopeId);
    }).catch(() => {});
    return pending;
  }

  function matchingScopes(tab: SelectedTab): [string, ManagedScope][] {
    return [...scopes].filter(([, scope]) => scope.selector.kind === 'active-tab' || scope.selector.kind === 'explicit-tabs'
      ? scope.snapshotTabIds.has(tab.tabId)
      : matchesTabScope(scope.selector, tab));
  }

  async function revokePublication(tabId: number, managed: ManagedTab, reason: 'closed' | 'explicit' | 'policy-invalid'): Promise<void> {
    const publisher = managed.publisher;
    delete managed.publisher;
    delete managed.target;
    delete managed.identity;
    await publisher?.revoke(reason);
    if (!disposed && managed.nextTab !== undefined) {
      managed.tab = managed.nextTab;
      delete managed.nextTab;
      delete managed.closed;
      await reconcileTab(tabId);
    }
  }

  async function reconcileTab(tabId: number, revocationReason: 'explicit' | 'policy-invalid' = 'policy-invalid'): Promise<void> {
    const managed = tabs.get(tabId);
    if (managed === undefined) return;
    const matching = disposed || managed.closed ? [] : matchingScopes(managed.tab);
    const remaining = new Set(matching.map(([scopeId]) => scopeId));
    const removals: Promise<void>[] = [];
    for (const [scopeId, scope] of scopes) {
      if (remaining.has(scopeId) || !scope.targets.delete(tabId)) continue;
      removals.push(notify(scopeId, [...scope.targets.values()]));
    }
    const removalResults = await Promise.allSettled(removals);
    const failure = removalResults.find(result => result.status === 'rejected');
    if (matching.length === 0) {
      await revokePublication(tabId, managed, managed.closed ? 'closed' : revocationReason);
      if (failure?.status === 'rejected') throw failure.reason;
      return;
    }
    if (failure?.status === 'rejected') throw failure.reason;
    if (managed.publisher === undefined) {
      const publisher = options.createPublisher(managed.tab);
      managed.publisher = publisher;
      try {
        managed.target = await publisher.publish(managed.tab);
        managed.identity = managed.target;
      } catch (error) {
        delete managed.publisher;
        delete managed.target;
        throw error;
      }
    } else {
      await managed.publisher.refresh(managed.tab);
    }
    if (disposed || managed.closed || matchingScopes(managed.tab).length === 0) {
      await revokePublication(tabId, managed, managed.closed ? 'closed' : 'explicit');
      return;
    }
    if (managed.target === undefined) return;
    for (const [scopeId, scope] of matchingScopes(managed.tab)) {
      if (disposed || scopes.get(scopeId) !== scope || scope.targets.get(tabId) === managed.target) continue;
      scope.targets.set(tabId, managed.target);
      await notify(scopeId, [...scope.targets.values()]);
    }
  }

  function onCreated(tab: SelectedTab): void {
    if (disposed) return;
    tabRevisions.set(tab.tabId, ++revision);
    const managed = tabs.get(tab.tabId);
    if (managed === undefined) tabs.set(tab.tabId, { tab });
    else if (managed.closed) managed.nextTab = tab;
    else managed.tab = tab;
    report(serialize(tab.tabId, async () => reconcileTab(tab.tabId)));
  }

  function onUpdated(tabId: number, _changeInfo: unknown, tab: SelectedTab): void {
    if (tabs.get(tabId)?.closed) return;
    onCreated({ ...tab, tabId });
  }

  function onRemoved(tabId: number): void {
    if (disposed) return;
    tabRevisions.set(tabId, ++revision);
    const managed = tabs.get(tabId);
    if (managed === undefined) return;
    managed.closed = true;
    for (const scope of scopes.values()) scope.snapshotTabIds.delete(tabId);
    report(serialize(tabId, async () => reconcileTab(tabId)));
  }

  async function removeScope(scopeId: string): Promise<void> {
    if (!scopes.delete(scopeId)) return;
    await notify(scopeId, []).finally(async () => {
      await Promise.all(Array.from(tabs.keys(), async tabId => serialize(tabId, async () => reconcileTab(tabId, 'explicit'))));
    });
  }

  function onGroupRemoved(group: { readonly id: number }): void {
    for (const [scopeId, scope] of scopes) {
      if (scope.selector.kind === 'group' && scope.selector.groupId === group.id) report(removeScope(scopeId));
    }
  }

  function onGroupUpdated(): void {
    report((async () => {
      const queryRevision = revision;
      const currentTabs = await options.chrome.tabs.query({});
      if (disposed) return;
      const currentTabIds = new Set(currentTabs.map(tab => tab.tabId));
      for (const tab of currentTabs) if ((tabRevisions.get(tab.tabId) ?? 0) <= queryRevision) onCreated(tab);
      for (const tabId of tabs.keys()) if (!currentTabIds.has(tabId) && (tabRevisions.get(tabId) ?? 0) <= queryRevision) onRemoved(tabId);
    })());
  }

  function onWindowRemoved(windowId: number): void {
    for (const [tabId, managed] of tabs) if (managed.tab.windowId === windowId) onRemoved(tabId);
    for (const [scopeId, scope] of scopes) {
      if (scope.selector.kind === 'window' && scope.selector.windowId === windowId) report(removeScope(scopeId));
    }
  }

  options.chrome.tabs.onCreated.addListener(onCreated);
  options.chrome.tabs.onUpdated.addListener(onUpdated);
  options.chrome.tabs.onRemoved.addListener(onRemoved);
  options.chrome.tabGroups?.onRemoved?.addListener(onGroupRemoved);
  options.chrome.tabGroups?.onUpdated.addListener(onGroupUpdated);
  options.chrome.windows?.onRemoved.addListener(onWindowRemoved);

  return {
    async addScope(scopeId, selector) {
      if (disposed) throw new Error('The tab scope manager is disposed.');
      if (scopeId.length === 0 || scopes.has(scopeId)) throw new Error('A scope requires a unique nonempty ID.');
      const validatedSelector = parseTabScopeSelector(selector);
      if (validatedSelector === undefined) throw new TypeError('The tab scope selector is invalid.');
      const scope: ManagedScope = { selector: validatedSelector, snapshotTabIds: new Set(), targets: new Map() };
      scopes.set(scopeId, scope);
      try {
        const queryRevision = revision;
        const selectedTabs = await options.chrome.tabs.query(selector.kind === 'active-tab' ? { active: true } : {});
        if (disposed || scopes.get(scopeId) !== scope) return [];
        for (const tab of selectedTabs) {
          if ((tabRevisions.get(tab.tabId) ?? 0) > queryRevision) continue;
          if (matchesTabScope(selector, tab)) scope.snapshotTabIds.add(tab.tabId);
          if (!tabs.has(tab.tabId)) tabs.set(tab.tabId, { tab });
        }
        await Promise.all(Array.from(tabs.keys(), async tabId => serialize(tabId, async () => reconcileTab(tabId))));
        return scopes.get(scopeId) === scope ? [...scope.targets.values()] : [];
      } catch (error) {
        if (scopes.get(scopeId) === scope) await removeScope(scopeId);
        throw error;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      options.chrome.tabs.onCreated.removeListener(onCreated);
      options.chrome.tabs.onUpdated.removeListener(onUpdated);
      options.chrome.tabs.onRemoved.removeListener(onRemoved);
      options.chrome.tabGroups?.onRemoved?.removeListener(onGroupRemoved);
      options.chrome.tabGroups?.onUpdated.removeListener(onGroupUpdated);
      options.chrome.windows?.onRemoved.removeListener(onWindowRemoved);
      await Promise.all(Array.from(scopes.keys(), async scopeId => removeScope(scopeId)));
      await Promise.all([...operations.values()]);
      tabs.clear();
    },
    getTargets(scopeId) {
      return [...(scopes.get(scopeId)?.targets.values() ?? [])];
    },
    removeScope,
    updateTarget(tabId, target) {
      const managed = tabs.get(tabId);
      if (disposed || managed === undefined || managed.publisher === undefined) return;
      if (target !== undefined && managed.identity !== undefined
        && (managed.identity.id !== target.id || target.generation < managed.identity.generation)) return;
      if (target === undefined) delete managed.target;
      else {
        managed.target = target;
        managed.identity = target;
      }
      const matching = new Set(matchingScopes(managed.tab).map(([scopeId]) => scopeId));
      for (const [scopeId, scope] of scopes) {
        if (target === undefined || managed.closed || !matching.has(scopeId)) {
          if (!scope.targets.delete(tabId)) continue;
        } else scope.targets.set(tabId, target);
        report(notify(scopeId, [...scope.targets.values()]));
      }
    },
  };
}
