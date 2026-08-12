import type { SelectedTab, SelectedTabPublisher } from './selected-tab-publisher.js';
import type { TabScopeSelector } from './tab-scope.js';

import { matchesTabScope } from './tab-scope.js';

interface ChromeEvent<Listener> {
  addListener: (listener: Listener) => void;
  removeListener: (listener: Listener) => void;
}

export interface ChromeTabScopeLifecyclePort {
  readonly tabs: {
    readonly onCreated: ChromeEvent<(tab: SelectedTab) => void>;
    readonly onRemoved: ChromeEvent<(tabId: number) => void>;
    readonly onUpdated: ChromeEvent<(tabId: number, changeInfo: unknown, tab: SelectedTab) => void>;
    query: (queryInfo: object) => Promise<SelectedTab[]>;
  };
  readonly tabGroups?: { readonly onUpdated: ChromeEvent<(group: { readonly id: number }) => void> };
  readonly windows?: { readonly onRemoved: ChromeEvent<(windowId: number) => void> };
}

export interface TabScopeLifecycle {
  start: () => void;
  stop: () => void;
}

export interface TabScopeLifecycleOptions {
  readonly chrome: ChromeTabScopeLifecyclePort;
  /** Creates a separately tab-gated publisher, so each public target keeps its own opaque identity. */
  readonly createPublisher: (tab: SelectedTab) => SelectedTabPublisher;
  readonly onError?: (error: unknown) => void;
  readonly selector: TabScopeSelector;
}

function isSnapshotSelector(selector: TabScopeSelector): boolean {
  return selector.kind === 'active-tab' || selector.kind === 'explicit-tabs';
}

/** Publishes snapshot selectors once and continuously reconciles live collection selectors. */
export function createTabScopeLifecycle(options: TabScopeLifecycleOptions): TabScopeLifecycle {
  const publishersByTabId = new Map<number, SelectedTabPublisher>();
  const snapshotTabIds = new Set<number>();
  let started = false;

  function report(task: Promise<void>): void {
    void task.catch(error => options.onError?.(error));
  }

  function matches(tab: SelectedTab): boolean {
    return isSnapshotSelector(options.selector)
      ? snapshotTabIds.has(tab.tabId)
      : matchesTabScope(options.selector, tab);
  }

  async function reconcileTab(tab: SelectedTab): Promise<void> {
    if (!started) return;
    const publisher = publishersByTabId.get(tab.tabId);
    if (!matches(tab)) {
      if (publisher !== undefined) {
        publishersByTabId.delete(tab.tabId);
        await publisher.revoke('policy-invalid');
      }
      return;
    }
    if (publisher === undefined) {
      const nextPublisher = options.createPublisher(tab);
      publishersByTabId.set(tab.tabId, nextPublisher);
      try {
        await nextPublisher.publish(tab);
        if (!started || publishersByTabId.get(tab.tabId) !== nextPublisher) {
          publishersByTabId.delete(tab.tabId);
          await nextPublisher.revoke();
        }
      } catch (error) {
        publishersByTabId.delete(tab.tabId);
        throw error;
      }
      return;
    }
    await publisher.refresh(tab);
  }

  async function reconcileAll(): Promise<void> {
    const tabs = await options.chrome.tabs.query({});
    const tabIds = new Set(tabs.map(tab => tab.tabId));
    for (const tab of tabs) await reconcileTab(tab);
    for (const [tabId, publisher] of publishersByTabId) {
      if (tabIds.has(tabId)) continue;
      publishersByTabId.delete(tabId);
      await publisher.revoke('closed');
    }
  }

  function onCreated(tab: SelectedTab): void {
    report(reconcileTab(tab));
  }

  function onUpdated(tabId: number, _changeInfo: unknown, tab: SelectedTab): void {
    report(reconcileTab({ ...tab, tabId }));
  }

  function onRemoved(tabId: number): void {
    const publisher = publishersByTabId.get(tabId);
    if (publisher === undefined) return;
    publishersByTabId.delete(tabId);
    report(publisher.revoke('closed'));
  }

  function onGroupUpdated(_group: { readonly id: number }): void {
    report(reconcileAll());
  }

  function onWindowRemoved(windowId: number): void {
    for (const [tabId, publisher] of publishersByTabId) {
      if (options.selector.kind !== 'window' || options.selector.windowId !== windowId) continue;
      publishersByTabId.delete(tabId);
      report(publisher.revoke('closed'));
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      snapshotTabIds.clear();
      if (options.selector.kind === 'explicit-tabs') {
        for (const tabId of options.selector.tabIds) snapshotTabIds.add(tabId);
      }
      options.chrome.tabs.onCreated.addListener(onCreated);
      options.chrome.tabs.onUpdated.addListener(onUpdated);
      options.chrome.tabs.onRemoved.addListener(onRemoved);
      options.chrome.tabGroups?.onUpdated.addListener(onGroupUpdated);
      options.chrome.windows?.onRemoved.addListener(onWindowRemoved);
      report((async () => {
        const tabs = await options.chrome.tabs.query(options.selector.kind === 'active-tab' ? { active: true } : {});
        if (options.selector.kind === 'active-tab') for (const tab of tabs) snapshotTabIds.add(tab.tabId);
        for (const tab of tabs) await reconcileTab(tab);
      })());
    },
    stop() {
      if (!started) return;
      started = false;
      options.chrome.tabs.onCreated.removeListener(onCreated);
      options.chrome.tabs.onUpdated.removeListener(onUpdated);
      options.chrome.tabs.onRemoved.removeListener(onRemoved);
      options.chrome.tabGroups?.onUpdated.removeListener(onGroupUpdated);
      options.chrome.windows?.onRemoved.removeListener(onWindowRemoved);
      for (const publisher of publishersByTabId.values()) report(publisher.revoke());
      publishersByTabId.clear();
      snapshotTabIds.clear();
    },
  };
}
