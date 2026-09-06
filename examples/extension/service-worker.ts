import type { GrantedTargetReference, GrantRequest, GrantRequestClaim } from '@dvcol/cdb';
import type { ApprovalChannel, ExtensionApprovalSender, SelectedTab, SelectedTabPublisher } from '@dvcol/cdb-extension';
import type { AgentToBrokerMessage, HeartbeatParameters, JsonObject, PublishedTarget } from '@dvcol/cdb/protocol';

import type { GrantFlowHostConfiguration } from '../standalone-host/grant-flow.ts';

import {
  createApprovalChannel,
  createExtensionApprovalSenderValidator,
  createIndexedDbPairingStore,
  createSelectedTabPublisher,
  createTabScopeManager,
  sendAgentHeartbeat,
} from '@dvcol/cdb-extension';
import { connectAgentWebSocket } from '@dvcol/cdb-websocket/browser';

const { chrome } = globalThis;

function selectedTab(tab: chrome.tabs.Tab): SelectedTab {
  if (tab.id === undefined) throw new Error('Chrome returned a tab without an identifier.');
  return { active: tab.active, groupId: tab.groupId, incognito: tab.incognito, tabId: tab.id, ...(tab.title === undefined ? {} : { title: tab.title }), ...(tab.url === undefined ? {} : { url: tab.url }), windowId: tab.windowId };
}

export interface ExampleState { readonly requests: readonly GrantRequest[] }

interface ExampleRuntime {
  readonly approval: ApprovalChannel<ExtensionApprovalSender>;
  readonly isTrustedSender: (sender: ExtensionApprovalSender) => boolean;
  readonly state: () => Promise<ExampleState>;
}

interface ControlResponses {
  readonly cancel: unknown;
  readonly claim: GrantRequestClaim;
  readonly complete: unknown;
  readonly reconcile: unknown;
  readonly state: ExampleState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetUnavailable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'GRANT_TARGET_UNAVAILABLE';
}

function mappedEvent<Parameters extends unknown[], Transformed extends unknown[]>(event: {
  addListener: (listener: (...parameters: Parameters) => void) => void;
  removeListener: (listener: (...parameters: Parameters) => void) => void;
}, transform: (...parameters: Parameters) => Transformed): {
  addListener: (listener: (...parameters: Transformed) => void) => void;
  removeListener: (listener: (...parameters: Transformed) => void) => void;
} {
  const listeners = new Map<(...parameters: Transformed) => void, (...parameters: Parameters) => void>();
  return {
    addListener(listener: (...parameters: Transformed) => void) {
      const mapped = (...parameters: Parameters): void => listener(...transform(...parameters));
      listeners.set(listener, mapped);
      event.addListener(mapped);
    },
    removeListener(listener: (...parameters: Transformed) => void) {
      const mapped = listeners.get(listener);
      if (mapped !== undefined) event.removeListener(mapped);
      listeners.delete(listener);
    },
  };
}

async function initialize(): Promise<ExampleRuntime> {
  const configurationResponse = await fetch(chrome.runtime.getURL('configuration.json'));
  const configurationValue: unknown = await configurationResponse.json();
  const configuration = configurationValue as GrantFlowHostConfiguration;
  const connection = await connectAgentWebSocket({
    credentialStore: createIndexedDbPairingStore({ databaseName: `cdb-example-${configuration.brokerId}` }),
    endpoint: configuration.agentEndpoint,
    implementation: { instanceId: configuration.providerInstanceId, name: 'cdb-approval-example', version: '0.0.0' },
    requestPairingCode: async () => configuration.pairingCode,
  });
  const publishers = new Map<number, SelectedTabPublisher>();
  const publishersByTarget = new Map<string, SelectedTabPublisher>();
  const cancellations = new Map<string, AbortController>();
  const approvedScopes = new Set<string>();
  const reconciliations = new Map<string, Promise<void>>();
  let pendingRequests: readonly GrantRequest[] = [];

  function report(error: unknown): void {
    console.error('[CDB approval example]', error);
    connection.close(1011, 'The example provider failed closed. Reload the extension after checking the host.');
  }

  async function control<Method extends keyof ControlResponses>(method: Method, input?: unknown): Promise<ControlResponses[Method]> {
    const response = await fetch(new URL(method, configuration.controlEndpoint), {
      headers: { authorization: configuration.controlAuthorization, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input), method: 'POST' }),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const failure = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
      throw Object.assign(new Error(typeof failure.message === 'string' ? failure.message : 'The example control endpoint is unavailable.'), { code: failure.code });
    }
    return result as ControlResponses[Method];
  }

  const exactTargets = (targets: readonly PublishedTarget[]): GrantedTargetReference[] => targets.map(target => ({ targetGeneration: target.generation, targetId: target.id }));
  const notify = async (message: Extract<AgentToBrokerMessage, { readonly kind: 'notification' }>): Promise<void> => connection.send(message);
  const scopes = createTabScopeManager({
    chrome: {
      tabs: {
        onCreated: mappedEvent(chrome.tabs.onCreated, (tab): [SelectedTab] => [selectedTab(tab)]),
        onRemoved: chrome.tabs.onRemoved,
        onUpdated: mappedEvent(chrome.tabs.onUpdated, (tabId, changeInfo, tab): [number, unknown, SelectedTab] => [tabId, changeInfo, selectedTab(tab)]),
        query: async queryInfo => (await chrome.tabs.query(queryInfo)).map(selectedTab),
      },
      tabGroups: chrome.tabGroups,
      windows: chrome.windows,
    },
    createPublisher(tab) {
      const publisher = createSelectedTabPublisher({
        capabilities: { level: 'interact' },
        chromeDebugger: {
          attach: async (target, version) => chrome.debugger.attach(target, version),
          detach: async target => chrome.debugger.detach(target),
          sendCommand: async (target, method, parameters) => await chrome.debugger.sendCommand(target, method, parameters) as JsonObject ?? {},
        },
        metadataPolicy: input => ({ ...(input.title === undefined ? {} : { title: input.title }), ...(input.url === undefined ? {} : { url: input.url }) }),
        publishEvent(target, method, parameters, sessionId) {
          void notify({ kind: 'notification', method: 'cdp.event', parameters: { method, parameters, ...(sessionId === undefined ? {} : { sessionId }), targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1 }).catch(report);
        },
        async publishTarget(target) {
          publishersByTarget.set(target.id, publisher);
          await notify({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
          scopes.updateTarget(tab.tabId, target);
        },
        async revokeTarget(target, reason) {
          publishersByTarget.delete(target.id);
          await notify({ kind: 'notification', method: 'targets.revoke', parameters: { reason, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1 });
          scopes.updateTarget(tab.tabId, undefined);
          publishers.delete(tab.tabId);
        },
        scopeId: crypto.randomUUID(),
        tabScopeSelector: { kind: 'explicit-tabs', tabIds: [tab.tabId] },
        async updateTarget(target) {
          await notify({ kind: 'notification', method: 'targets.update', parameters: { target }, protocolVersion: 1 });
          scopes.updateTarget(tab.tabId, target);
        },
      });
      publishers.set(tab.tabId, publisher);
      return publisher;
    },
    onError: report,
    async onTargetsChanged(requestId) {
      if (approvedScopes.has(requestId)) await reconcileScope(requestId);
    },
  });

  async function reconcileScope(requestId: string): Promise<void> {
    const pending = (reconciliations.get(requestId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const deadline = Date.now() + 5_000;
      while (approvedScopes.has(requestId)) {
        try {
          await control('reconcile', { requestId, targets: exactTargets(scopes.getTargets(requestId)) });
          return;
        } catch (error) {
          if (!approvedScopes.has(requestId)) return;
          if (!targetUnavailable(error) || Date.now() >= deadline) throw error;
          await new Promise(resolveRetry => setTimeout(resolveRetry, 25));
        }
      }
    });
    reconciliations.set(requestId, pending);
    try {
      await pending;
    } finally {
      if (reconciliations.get(requestId) === pending) reconciliations.delete(requestId);
    }
  }

  connection.onMessage((message) => {
    if (message.kind === 'notification' && message.method === 'cdp.cancel') {
      cancellations.get(message.parameters.operationId)?.abort();
      return;
    }
    if (message.kind === 'notification' && message.method === 'cdp.subscription-demand') {
      const { targetId, methodPrefix, active, sessionId } = message.parameters;
      void publishersByTarget.get(targetId)?.setSubscriptionDemand(methodPrefix, active, sessionId).catch(report);
      return;
    }
    if (message.kind !== 'request' || message.method !== 'cdp.execute') return;
    const { command, lease } = message.parameters;
    const abortController = new AbortController();
    cancellations.set(command.operationId, abortController);
    void (async () => {
      const publisher = publishersByTarget.get(command.targetId);
      if (publisher === undefined) throw new Error('The approved target is unavailable.');
      const value = await publisher.executeCommand(command, abortController.signal, lease);
      await connection.send({ kind: 'response', method: 'cdp.execute', protocolVersion: 1, requestId: message.requestId, result: { operationId: command.operationId, value } });
    })().catch(async error => connection.send({
      error: { code: 'CDP_COMMAND_FAILED', message: errorMessage(error), retryable: false },
      kind: 'error',
      method: 'cdp.execute',
      protocolVersion: 1,
      requestId: message.requestId,
    })).catch(report).finally(() => cancellations.delete(command.operationId));
  });
  const helloId = crypto.randomUUID();
  const hello = new Promise<HeartbeatParameters>((resolveHello, reject) => {
    const timeout = setTimeout(() => reject(new Error('The broker hello timed out.')), 5_000);
    const unsubscribe = connection.onMessage((message) => {
      if (!('requestId' in message) || message.requestId !== helloId) return;
      clearTimeout(timeout);
      unsubscribe();
      if (message.kind === 'error') reject(new Error(message.error.message));
      else if (message.kind === 'response' && message.method === 'agent.hello') resolveHello(message.result.heartbeat);
    });
  });
  await connection.send({
    kind: 'request',
    method: 'agent.hello',
    protocolVersion: 1,
    requestId: helloId,
    parameters: {
      connectionGeneration: connection.connectionGeneration,
      features: ['bridge.cdp.read'],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: { instanceId: configuration.providerInstanceId, name: 'cdb-approval-example', role: 'agent', version: '0.0.0' },
      limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 512_000, maximumMessageBytes: 8_388_608 },
      protocolVersions: { maximum: 1, minimum: 1 },
    },
  });
  const heartbeat = await hello;
  const heartbeatTimer = setInterval(() => void sendAgentHeartbeat(connection, connection.connectionGeneration, heartbeat.timeoutMilliseconds).catch(report), heartbeat.intervalMilliseconds);
  chrome.debugger.onEvent.addListener((source, method, parameters) => {
    if (source.tabId !== undefined) publishers.get(source.tabId)?.debuggerEvent(source, method, parameters as JsonObject ?? {});
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    const publisher = publishers.get(source.tabId);
    if (publisher !== undefined) void publisher.debuggerDetached(source.tabId).catch(report);
  });
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    const publisher = publishers.get(tabId);
    if (publisher !== undefined) void (async () => {
      await publisher.refresh(selectedTab(await chrome.tabs.get(tabId)));
      await publisher.renewAuthority();
    })().catch(report);
  });

  const isTrustedSender = createExtensionApprovalSenderValidator({
    allowedDocumentUrls: [chrome.runtime.getURL('popup.html')],
    extensionId: chrome.runtime.id,
  });
  const approval = createApprovalChannel({
    isTrustedSender,
    async onApprove(requestId, selector) {
      const claim = await control('claim', { requestId });
      try {
        await scopes.addScope(requestId, selector);
        const deadline = Date.now() + 5_000;
        while (true) {
          try {
            await control('complete', { claim, targets: exactTargets(scopes.getTargets(requestId)) });
            break;
          } catch (error) {
            if (!targetUnavailable(error) || Date.now() >= deadline) throw error;
            await new Promise(resolveRetry => setTimeout(resolveRetry, 25));
          }
        }
        approvedScopes.add(requestId);
        await reconcileScope(requestId);
      } catch (error) {
        approvedScopes.delete(requestId);
        try {
          await control('cancel', { requestId });
        } catch (cancellationError) {
          report(cancellationError);
        } finally {
          await scopes.removeScope(requestId);
        }
        throw error;
      }
    },
    async onDeny(requestId) {
      approvedScopes.delete(requestId);
      try {
        await control('cancel', { requestId });
      } catch (error) {
        report(error);
        throw error;
      } finally {
        await scopes.removeScope(requestId);
      }
    },
    async onRequest(requestId) {
      if (!pendingRequests.some(request => request.id === requestId)) return;
      await chrome.action.setBadgeText({ text: '!' });
      try {
        await chrome.action.openPopup();
      } catch {
        /** Some browser versions require the user to open the toolbar popup themselves. */
      }
    },
  });
  async function state(): Promise<ExampleState> {
    const result = await control('state');
    pendingRequests = result.requests.filter(request => request.state === 'pending');
    for (const requestId of approvedScopes) {
      if (result.requests.some(request => request.id === requestId && request.state === 'granted')) continue;
      approvedScopes.delete(requestId);
      await scopes.removeScope(requestId);
    }
    await chrome.action.setBadgeText({ text: pendingRequests.length === 0 ? '' : String(pendingRequests.length) });
    return result;
  }
  const notificationTimer = setInterval(() => void state().then(async () => {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id !== undefined) void chrome.tabs.sendMessage(tab.id, { kind: 'example.notifications', requests: pendingRequests }).catch(() => {});
    }
  }).catch(report), 2_000);
  void connection.closed.then(async () => {
    clearInterval(heartbeatTimer);
    clearInterval(notificationTimer);
    approvedScopes.clear();
    await scopes.dispose();
  }).catch(report);
  return { approval, isTrustedSender, state };
}

let runtime: Awaited<ReturnType<typeof initialize>> | undefined;
let startupError: string | undefined;
const ready = initialize().then(value => runtime = value, (error) => {
  startupError = errorMessage(error);
  console.error('[CDB approval example]', 'Provider startup failed.', error);
});
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  void ready.then(async () => {
    if (runtime === undefined) return { error: startupError ?? 'The example provider is starting.', ok: false };
    if (message !== null && typeof message === 'object' && 'kind' in message && message.kind === 'example.state') {
      if (!runtime.isTrustedSender(sender)) return { code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false };
      return runtime.state();
    }
    return runtime.approval.receive(message, sender);
  }).then(respond, error => respond({ error: errorMessage(error), ok: false }));
  return true;
});
