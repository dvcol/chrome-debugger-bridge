import type { AgentToBrokerMessage, BrokerToAgentMessage, HeartbeatParameters, JsonObject, PublishedTarget } from '@dvcol/cdb';
import type { AccessLevel, BrokerRequest, BrokerState, ProviderTarget } from '@dvcol/cdb-broker/contract';

import type { AgentRecoveryState } from './agent-recovery.js';
import type { AgentControlPresentationEvent } from './presentation.js';
import type { ProviderConnection } from './provider-connection.js';
import type { CommandAuthorizationPolicy, SelectedTab, SelectedTabPublisher } from './selected-tab-publisher.js';
import type { ChromeTabScopeLifecyclePort } from './tab-scope-lifecycle.js';
import type { TabScopeSelector } from './tab-scope.js';

import { sendAgentHeartbeat } from './agent-heartbeat.js';
import { createAgentRecovery } from './agent-recovery.js';
import { createSelectedTabPublisher } from './selected-tab-publisher.js';
import { createTabScopeManager } from './tab-scope-manager.js';
import { parseTabScopeSelector } from './tab-scope.js';

interface ChromeEvent<Arguments extends unknown[]> {
  addListener: (listener: (...arguments_: Arguments) => void) => void;
  removeListener: (listener: (...arguments_: Arguments) => void) => void;
}

function projectEvent<SourceArguments extends unknown[], ResultArguments extends unknown[]>(event: ChromeEvent<SourceArguments>, project: (...arguments_: SourceArguments) => ResultArguments): ChromeEvent<ResultArguments> {
  const listeners = new Map<(...arguments_: ResultArguments) => void, (...arguments_: SourceArguments) => void>();
  return {
    addListener(listener) {
      if (listeners.has(listener)) return;
      const projected = (...arguments_: SourceArguments): void => {
        listener(...project(...arguments_));
      };
      listeners.set(listener, projected);
      event.addListener(projected);
    },
    removeListener(listener) {
      const projected = listeners.get(listener);
      if (projected !== undefined) {
        event.removeListener(projected);
        listeners.delete(listener);
      }
    },
  };
}

function selectedTab(tab: chrome.tabs.Tab): SelectedTab {
  if (tab.id === undefined) throw new Error('The Chrome tab has no stable identifier.');
  return {
    tabId: tab.id,
    incognito: tab.incognito,
    active: tab.active,
    windowId: tab.windowId,
    ...(tab.groupId === undefined ? {} : { groupId: tab.groupId }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.url === undefined ? {} : { url: tab.url }),
  };
}

/** Converts Chrome's tab events to the shared publication contract. */
export function createChromeTabBindings(platform: typeof chrome = chrome): ChromeTabScopeLifecyclePort {
  return {
    tabs: {
      query: async query => (await platform.tabs.query(query)).filter(tab => tab.id !== undefined).map(selectedTab),
      onCreated: projectEvent(platform.tabs.onCreated, (tab): [SelectedTab] => [selectedTab(tab)]),
      onUpdated: projectEvent(platform.tabs.onUpdated, (tabId, change, tab): [number, unknown, SelectedTab] => [tabId, change, selectedTab(tab)]),
      onRemoved: platform.tabs.onRemoved,
    },
    tabGroups: platform.tabGroups,
    windows: platform.windows,
  };
}

export interface ChromeProviderOptions<ApprovalContext> {
  readonly chrome?: typeof chrome;
  readonly connect: () => Promise<ProviderConnection>;
  readonly maximumLevel: AccessLevel;
  /** Must validate the host's final approval source and tab-selection policy. Page messages alone are insufficient. */
  readonly authorizeApproval: (request: BrokerRequest, selector: TabScopeSelector, context: ApprovalContext) => boolean | Promise<boolean>;
  readonly isExposureAllowed?: (tab: Omit<SelectedTab, 'tabId'>) => boolean;
  readonly commandAuthorizationPolicy?: CommandAuthorizationPolicy;
  readonly targetMetadata?: (tab: SelectedTab) => ProviderTarget['metadata'];
  readonly onState?: (state: BrokerState) => void;
  readonly onError?: (error: unknown) => void;
  readonly onPresentation?: (tabId: number, event: AgentControlPresentationEvent) => void;
  /** Host-selected alarm name. Omit when the host already keeps the background process alive. */
  readonly recoveryAlarmName?: string;
  /** Uses Chrome session storage for publication continuity, never as proof of approval. */
  readonly recoveryStorageKey?: string;
}

interface ProviderRecoveryState {
  readonly version: 1;
  readonly brokerId: string;
  readonly scopes: readonly { readonly requestId: string; readonly selector: TabScopeSelector }[];
  readonly targets: readonly { readonly tabId: number; readonly id: string; readonly generation: number; readonly scopeId: string; readonly documentId?: string }[];
}

interface ControlledTab {
  readonly publisher: SelectedTabPublisher;
  tab: SelectedTab;
  target?: PublishedTarget;
  documentId?: string;
}

export interface ChromeProvider<ApprovalContext> {
  readonly state: AgentRecoveryState;
  start: () => void;
  approve: (requestId: string, selector: TabScopeSelector, context: ApprovalContext) => Promise<BrokerState>;
  revoke: (requestId: string) => Promise<void>;
  dispose: () => Promise<void>;
}

/** Composes shared publications, claims, navigation renewal, Chrome events and recoverable provider transport. */
export function createChromeProvider<ApprovalContext>(options: ChromeProviderOptions<ApprovalContext>): ChromeProvider<ApprovalContext> {
  const platform = options.chrome ?? chrome;
  const tabs = new Map<number, ControlledTab>();
  const scopes = new Map<string, TabScopeSelector>();
  const approved = new Set<string>();
  const commands = new Map<string, AbortController>();
  const tabOperations = new Map<number, Promise<unknown>>();
  const renewingTabs = new Set<number>();
  const restoredTargets = new Map<number, ProviderRecoveryState['targets'][number]>();
  let restored = false;
  let storageUpdates = Promise.resolve();
  let connection: ProviderConnection | undefined;
  let stopWatching: (() => void) | undefined;
  let stopMessages: (() => void) | undefined;
  let reconciling = false;
  let disposed = false;
  let started = false;
  let stateUpdates = Promise.resolve();

  function report(operation: Promise<unknown>): void {
    void operation.catch(error => options.onError?.(error));
  }
  function current(): ProviderConnection {
    if (disposed || connection === undefined) throw new Error('The browser provider is disconnected.');
    return connection;
  }
  async function send(message: AgentToBrokerMessage): Promise<void> {
    if (connection === undefined) throw new Error('The browser provider is disconnected.');
    return connection.send(message);
  }
  async function serialize<Result>(tabId: number, operation: () => Promise<Result>): Promise<Result> {
    const pending = (tabOperations.get(tabId) ?? Promise.resolve()).catch(() => {}).then(operation);
    tabOperations.set(tabId, pending);
    void pending.finally(() => {
      if (tabOperations.get(tabId) === pending) tabOperations.delete(tabId);
    }).catch(() => {});
    return pending;
  }
  function projection(target: PublishedTarget): ProviderTarget {
    const controlled = [...tabs.values()].find(tab => tab.target?.id === target.id);
    const metadata = controlled === undefined ? undefined : options.targetMetadata?.(controlled.tab);
    return { id: target.id, generation: target.generation, scopeId: target.scopeId, ...(target.title === undefined ? {} : { title: target.title }), ...(target.url === undefined ? {} : { url: target.url }), ...(metadata === undefined ? {} : { metadata }) };
  }

  const manager = createTabScopeManager({
    chrome: createChromeTabBindings(platform),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    async onTargetsChanged(requestId, targets) {
      if (approved.has(requestId) && !reconciling && connection !== undefined) await connection.reconcileScope(requestId, targets.map(projection));
    },
    createPublisher(tab) {
      const restoredTarget = restoredTargets.get(tab.tabId);
      const scopeId = restoredTarget?.scopeId ?? crypto.randomUUID();
      let controlled: ControlledTab;
      const publisher = createSelectedTabPublisher({
        capabilities: { level: options.maximumLevel },
        scopeId,
        ...(restoredTarget === undefined ? {} : { targetIdentity: { id: restoredTarget.id, generation: restoredTarget.generation + 1 } }),
        ...(options.isExposureAllowed === undefined ? {} : { isExposureAllowed: options.isExposureAllowed }),
        ...(options.commandAuthorizationPolicy === undefined ? {} : { commandAuthorizationPolicy: options.commandAuthorizationPolicy }),
        chromeDebugger: {
          attach: async (target, version) => platform.debugger.attach(target, version),
          detach: async target => platform.debugger.detach(target),
          sendCommand: async (target, method, parameters) => (await platform.debugger.sendCommand(target, method, parameters)) as JsonObject ?? {},
        },
        metadataPolicy: candidate => ({ ...(candidate.title === undefined ? {} : { title: candidate.title }), ...(candidate.url === undefined ? {} : { url: candidate.url }) }),
        async publishTarget(target) {
          await send({ kind: 'notification', method: 'targets.publish', protocolVersion: 1, parameters: { target } });
          controlled.target = target;
          manager.updateTarget(tab.tabId, target);
        },
        async updateTarget(target) {
          await send({ kind: 'notification', method: 'targets.update', protocolVersion: 1, parameters: { target } });
          controlled.target = target;
          manager.updateTarget(tab.tabId, target);
        },
        async revokeTarget(target, reason) {
          if (connection !== undefined) await send({ kind: 'notification', method: 'targets.revoke', protocolVersion: 1, parameters: { targetId: target.id, targetGeneration: target.generation, reason } });
          if (!renewingTabs.has(tab.tabId)) {
            delete controlled.target;
            manager.updateTarget(tab.tabId, undefined);
          }
        },
        publishEvent(target, method, parameters, sessionId) {
          report(send({ kind: 'notification', method: 'cdp.event', protocolVersion: 1, parameters: { targetId: target.id, targetGeneration: target.generation, method, parameters, ...(sessionId === undefined ? {} : { sessionId }) } }));
        },
        publishPresentationEvent: event => options.onPresentation?.(tab.tabId, event),
      });
      const wrapped: SelectedTabPublisher = {
        ...publisher,
        publish: async nextTab => serialize(tab.tabId, async () => {
          controlled.tab = nextTab;
          return publisher.publish(nextTab);
        }),
        refresh: async nextTab => serialize(tab.tabId, async () => {
          controlled.tab = nextTab;
          await publisher.refresh(nextTab);
        }),
        revoke: async reason => serialize(tab.tabId, async () => {
          await publisher.revoke(reason);
          tabs.delete(tab.tabId);
        }),
        renewAuthority: async () => serialize(tab.tabId, async () => {
          renewingTabs.add(tab.tabId);
          try {
            return await publisher.renewAuthority();
          } finally {
            renewingTabs.delete(tab.tabId);
          }
        }),
      };
      controlled = { tab, publisher: wrapped, ...(restoredTarget?.documentId === undefined ? {} : { documentId: restoredTarget.documentId }) };
      tabs.set(tab.tabId, controlled);
      return wrapped;
    },
  });

  async function persist(): Promise<void> {
    const storageKey = options.recoveryStorageKey;
    if (storageKey === undefined || connection === undefined || reconciling) return Promise.resolve();
    const value: ProviderRecoveryState = {
      version: 1,
      brokerId: connection.brokerId,
      scopes: [...scopes].filter(([requestId]) => approved.has(requestId)).map(([requestId, selector]) => ({ requestId, selector })),
      targets: [...tabs.values()].flatMap(tab => tab.target === undefined ? [] : [{ tabId: tab.tab.tabId, id: tab.target.id, generation: tab.target.generation, scopeId: tab.target.scopeId, ...(tab.documentId === undefined ? {} : { documentId: tab.documentId }) }]),
    };
    storageUpdates = storageUpdates.catch(() => {}).then(async () => platform.storage.session.set({ [storageKey]: value }));
    return storageUpdates;
  }

  async function restore(candidate: ProviderConnection): Promise<void> {
    if (restored || options.recoveryStorageKey === undefined) return;
    const stored = (await platform.storage.session.get(options.recoveryStorageKey))[options.recoveryStorageKey] as ProviderRecoveryState | undefined;
    const authority = await candidate.snapshot();
    if (stored?.version === 1 && stored.brokerId === candidate.brokerId) {
      for (const target of stored.targets) restoredTargets.set(target.tabId, target);
      for (const scope of stored.scopes) {
        if (!authority.scopes.some(granted => granted.id === scope.requestId && granted.providerId === candidate.registration.id)) continue;
        if (approved.has(scope.requestId)) continue;
        await manager.addScope(scope.requestId, scope.selector);
        scopes.set(scope.requestId, scope.selector);
        approved.add(scope.requestId);
      }
      restoredTargets.clear();
    }
    restored = true;
  }

  function consumeState(state: BrokerState): void {
    stateUpdates = stateUpdates.catch(() => {}).then(async () => {
      if (disposed) return;
      for (const requestId of approved) {
        if (state.scopes.some(scope => scope.id === requestId)) continue;
        approved.delete(requestId);
        scopes.delete(requestId);
        await manager.removeScope(requestId);
      }
      await persist();
      options.onState?.(state);
    });
    report(stateUpdates);
  }

  function receive(message: BrokerToAgentMessage): void {
    if (disposed) return;
    if (message.kind === 'notification' && message.method === 'cdp.cancel') {
      commands.get(message.parameters.operationId)?.abort();
      return;
    }
    if (message.kind === 'notification' && message.method === 'cdp.subscription-demand') {
      const { targetId, targetGeneration, methodPrefix, active, sessionId } = message.parameters;
      const controlled = [...tabs.values()].find(tab => tab.target?.id === targetId && tab.target.generation === targetGeneration);
      if (controlled !== undefined) report(controlled.publisher.setSubscriptionDemand(methodPrefix, active, sessionId));
      return;
    }
    if (message.kind !== 'request' || message.method !== 'cdp.execute') return;
    const source = current();
    const { command, lease } = message.parameters;
    const controlled = [...tabs.values()].find(tab => tab.target?.id === command.targetId && tab.target.generation === command.targetGeneration);
    const controller = new AbortController();
    commands.set(command.operationId, controller);
    report((async () => {
      try {
        if (controlled === undefined) throw new Error('The controlled target generation was replaced.');
        const value = await controlled.publisher.executeCommand(command, controller.signal, lease);
        await source.send({ kind: 'response', method: 'cdp.execute', requestId: message.requestId, protocolVersion: 1, result: { operationId: command.operationId, value } });
      } catch (error) {
        await source.send({ kind: 'error', method: 'cdp.execute', requestId: message.requestId, protocolVersion: 1, error: { code: 'CDP_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } });
      } finally {
        commands.delete(command.operationId);
      }
    })());
  }

  async function hello(candidate: ProviderConnection): Promise<HeartbeatParameters> {
    const requestId = crypto.randomUUID();
    const ready = Promise.withResolvers<HeartbeatParameters>();
    const unsubscribe = candidate.onMessage((message) => {
      if (message.kind === 'notification' || message.requestId !== requestId || message.method !== 'agent.hello') return;
      if (message.kind === 'response') ready.resolve(message.result.heartbeat);
      else if (message.kind === 'error') ready.reject(new Error(message.error.message));
    });
    const timeout = setTimeout(() => ready.reject(new Error('The CDB broker hello timed out.')), 5_000);
    try {
      await candidate.send({ kind: 'request', method: 'agent.hello', requestId, protocolVersion: 1, parameters: {
        connectionGeneration: candidate.generation,
        protocolVersions: { minimum: 1, maximum: 1 },
        features: [],
        implementation: { instanceId: candidate.registration.instanceId, name: candidate.registration.name, role: 'agent', version: candidate.registration.version },
        heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
        limits: { maximumArtifactBytes: 16 * 1_024 * 1_024, maximumInlineResultBytes: 64 * 1_024, maximumMessageBytes: 64 * 1_024 * 1_024 },
      } });
      return await ready.promise;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
  }

  const recovery = createAgentRecovery({
    connect: options.connect,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    heartbeat: async (candidate, _generation, parameters) => sendAgentHeartbeat(candidate, candidate.generation, parameters.timeoutMilliseconds),
    async reconcile(candidate) {
      reconciling = true;
      try {
        connection = candidate;
        stopMessages?.();
        stopMessages = candidate.onMessage(receive);
        void candidate.closed.then(() => {
          if (connection !== candidate) return;
          connection = undefined;
          for (const controller of commands.values()) controller.abort();
          commands.clear();
        });
        const heartbeat = await hello(candidate);
        for (const tab of tabs.values()) if (tab.target !== undefined) await tab.publisher.renewAuthority();
        await restore(candidate);
        await candidate.send({ kind: 'notification', method: 'targets.reconcile', protocolVersion: 1, parameters: { targets: [...tabs.values()].flatMap(tab => tab.target === undefined ? [] : [tab.target]) } });
        consumeState(await candidate.reconcile([...tabs.values()].flatMap(tab => tab.target === undefined ? [] : [projection(tab.target)])));
        reconciling = false;
        stopWatching?.();
        stopWatching = await candidate.watch(consumeState);
        await persist();
        return heartbeat;
      } finally {
        reconciling = false;
      }
    },
    onStateChange(state) {
      if (state === 'revoked') report((async () => {
        connection = undefined;
        approved.clear();
        scopes.clear();
        await manager.dispose();
      })());
    },
  });

  function debuggerEvent(source: chrome.debugger.Debuggee & { readonly sessionId?: string }, method: string, parameters?: object): void {
    if (source.tabId !== undefined) tabs.get(source.tabId)?.publisher.debuggerEvent(source, method, parameters as JsonObject ?? {});
  }
  function detached(source: chrome.debugger.Debuggee, reason: `${chrome.debugger.DetachReason}`): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const controlled = tabs.get(tabId);
    if (controlled?.target === undefined) return;
    report(serialize(tabId, async () => {
      if (reason !== 'target_closed') return controlled.publisher.debuggerDetached(tabId);
      renewingTabs.add(tabId);
      try {
        /** A renderer replacement can detach Chrome's debugger without closing its tab. */
        await platform.tabs.get(tabId);
        await controlled.publisher.debuggerDetached(tabId, { recover: true });
        if (connection !== undefined) await connection.reconcile([...tabs.values()].flatMap(tab => tab.target === undefined ? [] : [projection(tab.target)]));
        await persist();
      } catch (error) {
        renewingTabs.delete(tabId);
        await controlled.publisher.debuggerDetached(tabId);
        delete controlled.target;
        manager.updateTarget(tabId, undefined);
        throw error;
      } finally {
        renewingTabs.delete(tabId);
      }
    }));
  }
  function committed(details: chrome.webNavigation.WebNavigationFramedCallbackDetails & { readonly documentId?: string }): void {
    const tab = tabs.get(details.tabId);
    if (details.frameId !== 0 || tab === undefined || (details.documentId !== undefined && details.documentId === tab.documentId)) return;
    tab.documentId = details.documentId;
    report((async () => {
      await tab.publisher.refresh(selectedTab(await platform.tabs.get(details.tabId)));
      if (tab.target !== undefined) await tab.publisher.renewAuthority();
      if (connection !== undefined) await connection.reconcile([...tabs.values()].flatMap(value => value.target === undefined ? [] : [projection(value.target)]));
    })());
  }
  function alarm(value: chrome.alarms.Alarm): void {
    if (value.name === options.recoveryAlarmName && !disposed) recovery.start();
  }

  return {
    get state() {
      return recovery.state;
    },
    start() {
      if (started || disposed) return;
      started = true;
      platform.debugger.onEvent.addListener(debuggerEvent);
      platform.debugger.onDetach.addListener(detached);
      platform.webNavigation.onCommitted.addListener(committed);
      if (options.recoveryAlarmName !== undefined) {
        platform.alarms.onAlarm.addListener(alarm);
        report(platform.alarms.create(options.recoveryAlarmName, { periodInMinutes: 0.5 }));
      }
      recovery.start();
    },
    async approve(requestId: string, selectorInput: TabScopeSelector, approvalContext: ApprovalContext) {
      const source = current();
      const selector = parseTabScopeSelector(selectorInput);
      if (selector === undefined) throw new Error('A valid tab-selection scope is required.');
      const { claim, request } = await source.claim(requestId);
      try {
        if (!await options.authorizeApproval(request, selector, approvalContext)) throw new Error('The final approval source or selection policy was rejected.');
        scopes.set(requestId, selector);
        const targets = await manager.addScope(requestId, selector);
        const state = await source.approve(claim, targets.map(projection));
        approved.add(requestId);
        await source.reconcileScope(requestId, manager.getTargets(requestId).map(projection));
        consumeState(state);
        return state;
      } catch (error) {
        approved.delete(requestId);
        scopes.delete(requestId);
        await manager.removeScope(requestId).catch(() => {});
        await source.release(claim).catch(() => {});
        throw error;
      }
    },
    async revoke(requestId: string) {
      await current().revokeScope(requestId);
      approved.delete(requestId);
      scopes.delete(requestId);
      await manager.removeScope(requestId);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching?.();
      stopMessages?.();
      for (const controller of commands.values()) controller.abort();
      commands.clear();
      platform.debugger.onEvent.removeListener(debuggerEvent);
      platform.debugger.onDetach.removeListener(detached);
      platform.webNavigation.onCommitted.removeListener(committed);
      platform.alarms.onAlarm.removeListener(alarm);
      const source = connection;
      const results = await Promise.allSettled(Array.from(approved, async requestId => source?.revokeScope(requestId)));
      approved.clear();
      scopes.clear();
      results.push(...await Promise.allSettled([stateUpdates, storageUpdates]));
      try {
        await manager.dispose();
      } finally {
        recovery.stop();
        connection = undefined;
        if (options.recoveryAlarmName !== undefined) await platform.alarms.clear(options.recoveryAlarmName);
        if (options.recoveryStorageKey !== undefined) await platform.storage.session.remove(options.recoveryStorageKey);
      }
      const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'The Chrome provider stopped, but some authority updates failed.');
    },
  };
}

/** Preserves a host-chosen installation storage key and serializes first creation across extension contexts. */
export async function getChromeProviderIdentity(storageKey: string, platform: typeof chrome = chrome): Promise<string> {
  return navigator.locks.request(`cdb:${storageKey}`, async () => {
    const values = await platform.storage.local.get(storageKey);
    const existing: unknown = values[storageKey];
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const identity = crypto.randomUUID();
    await platform.storage.local.set({ [storageKey]: identity });
    return identity;
  });
}
