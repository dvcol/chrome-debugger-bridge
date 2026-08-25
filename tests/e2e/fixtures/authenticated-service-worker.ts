import type { BrokerToAgentMessage, JsonObject, PublishedTarget } from '../../../packages/core/src/protocol.js';
import type { BrowserAgentConnection } from '../../../packages/websocket/src/browser.js';

import { createAgentRecovery, createBirpcAgentBootstrap, createIndexedDbPairingStore, createSelectedTabLifecycle, createSelectedTabPublisher, sendAgentHeartbeat } from '../../../packages/extension/src/index.js';
import { connectAgentWebSocket } from '../../../packages/websocket/src/browser.js';

interface ServiceWorkerTestInput {
  readonly endpoint: string;
  readonly pairingCode: string;
}

interface ServiceWorkerTestResult {
  readonly brokerId: string;
  readonly connectionId: string;
  readonly resumedConnectionId: string;
  readonly responseKind: BrokerToAgentMessage['kind'];
  readonly responseMethod: BrokerToAgentMessage['method'];
}

interface BirpcBootstrapTestResult {
  readonly brokerId: string;
  readonly malformedRejected: boolean;
  readonly responseMethod: BrokerToAgentMessage['method'];
  readonly wrongOriginRejected: boolean;
}

interface BridgeTestGlobal {
  runAuthenticatedBridgeTest: (input: ServiceWorkerTestInput) => Promise<ServiceWorkerTestResult>;
  runIdleHeartbeatTest: (input: ServiceWorkerTestInput) => Promise<void>;
  runBirpcBootstrapTest: (input: ServiceWorkerTestInput) => Promise<BirpcBootstrapTestResult>;
  runDebuggerLifecycleTest: () => Promise<{ readonly revoked: boolean; readonly value: string }>;
  runPublishedTargetLifecycleTest: (updatedUrl: string) => Promise<readonly { readonly kind: 'published' | 'revoked' | 'updated'; readonly reason?: string }[]>;
  runPublishedTargetAgentTest: (input: ServiceWorkerTestInput) => Promise<Pick<PublishedTarget, 'generation' | 'id'>>;
  recoverPublishedTargetAgentTest: (input: ServiceWorkerTestInput) => Promise<Pick<PublishedTarget, 'generation' | 'id'>>;
  interruptPublishedTargetAgentTest: () => Promise<void>;
  revokePublishedTargetAgentTest: () => Promise<void>;
}

declare const chrome: {
  debugger: {
    attach: (target: { readonly tabId: number }, version: string) => Promise<void>;
    detach: (target: { readonly tabId: number }) => Promise<void>;
    sendCommand: (target: { readonly tabId: number }, method: string, parameters?: Record<string, unknown>) => Promise<{ readonly result?: { readonly value?: string } }>;
    onDetach: {
      addListener: (listener: (source: { readonly tabId?: number }) => void) => void;
      removeListener: (listener: (source: { readonly tabId?: number }) => void) => void;
    };
    onEvent: {
      addListener: (listener: (source: { readonly sessionId?: string; readonly tabId?: number }, method: string, parameters: JsonObject) => void) => void;
      removeListener: (listener: (source: { readonly sessionId?: string; readonly tabId?: number }, method: string, parameters: JsonObject) => void) => void;
    };
  };
  tabs: {
    onRemoved: {
      addListener: (listener: (tabId: number) => void) => void;
      removeListener: (listener: (tabId: number) => void) => void;
    };
    onUpdated: {
      addListener: (listener: (tabId: number, changeInfo: unknown, tab: { readonly id?: number; readonly incognito: boolean; readonly title?: string; readonly url?: string }) => void) => void;
      removeListener: (listener: (tabId: number, changeInfo: unknown, tab: { readonly id?: number; readonly incognito: boolean; readonly title?: string; readonly url?: string }) => void) => void;
    };
    query: (queryInfo: { readonly active: boolean }) => Promise<Array<{ readonly id?: number; readonly incognito?: boolean; readonly title?: string; readonly url?: string }>>;
    update: (tabId: number, updateProperties: { readonly url: string }) => Promise<void>;
  };
};

const bridgeTestGlobal = globalThis as typeof globalThis & BridgeTestGlobal;
let publishedTargetAgent: {
  bindConnection: (connection: BrowserAgentConnection) => void;
  connection: BrowserAgentConnection;
  readonly publisher: ReturnType<typeof createSelectedTabPublisher>;
  readonly removeDebuggerEventListener: () => void;
} | undefined;

bridgeTestGlobal.runAuthenticatedBridgeTest = async (input) => {
  let connection: BrowserAgentConnection | undefined;
  let helloResponse: Extract<BrokerToAgentMessage, { readonly kind: 'response'; readonly method: 'agent.hello' }> | undefined;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>(resolve => resolveReady = resolve);
  const recovery = createAgentRecovery({
    async connect() {
      return connectAgentWebSocket({
        credentialStore: createIndexedDbPairingStore({ databaseName: 'mv3-service-worker-test' }),
        endpoint: input.endpoint,
        async requestPairingCode() {
          return input.pairingCode;
        },
      });
    },
    async heartbeat(connectedAgent, connectionGeneration, heartbeat) {
      await sendAgentHeartbeat(connectedAgent, connectionGeneration, heartbeat.timeoutMilliseconds);
    },
    async reconcile(connectedAgent, connectionGeneration) {
      const response = new Promise<BrokerToAgentMessage>((resolve) => {
        const removeListener = connectedAgent.onMessage((message) => {
          removeListener();
          resolve(message);
        });
      });
      await connectedAgent.send({
        kind: 'request',
        method: 'agent.hello',
        parameters: {
          connectionGeneration,
          features: ['bridge.cdp.read'],
          heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
          implementation: { instanceId: crypto.randomUUID(), name: 'mv3-service-worker-test', role: 'agent', version: '0.0.0' },
          limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 16_384 },
          protocolVersions: { maximum: 1, minimum: 1 },
        },
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
      });
      const message = await response;
      if (message.kind !== 'response' || message.method !== 'agent.hello' || message.result.connectionGeneration !== connectionGeneration) {
        throw new Error('The recovery broker hello response is invalid.');
      }
      helloResponse = message;
      connection = connectedAgent;
      resolveReady?.();
      return message.result.heartbeat;
    },
  });
  recovery.start();
  await ready;
  if (connection === undefined) throw new Error('The recovering agent did not establish a connection.');
  const activeConnection = connection;
  const message = helloResponse;
  if (message === undefined) throw new Error('The recovering agent did not negotiate agent hello.');
  activeConnection.close(3001, 'MV3 recovery test interruption');
  await activeConnection.closed;
  const resumedConnection = await new Promise<BrowserAgentConnection>((resolve, reject) => {
    const deadline = globalThis.setTimeout(() => reject(new Error('The recovering agent did not reconnect.')), 5_000);
    const waitForReconnect = (): void => {
      if (connection !== undefined && connection !== activeConnection) {
        globalThis.clearTimeout(deadline);
        resolve(connection);
        return;
      }
      globalThis.setTimeout(waitForReconnect, 10);
    };
    waitForReconnect();
  });
  if (helloResponse?.result.connectionGeneration !== 2) throw new Error('The resumed agent did not negotiate a fresh generation.');
  recovery.stop();
  await resumedConnection.closed;
  return {
    brokerId: activeConnection.brokerId,
    connectionId: activeConnection.connectionId,
    resumedConnectionId: resumedConnection.connectionId,
    responseKind: message.kind,
    responseMethod: message.method,
  };
};

bridgeTestGlobal.runIdleHeartbeatTest = async (input) => {
  let connectedAgent: BrowserAgentConnection | undefined;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>(resolve => resolveReady = resolve);
  const recovery = createAgentRecovery({
    async connect() {
      return connectAgentWebSocket({
        credentialStore: createIndexedDbPairingStore({ databaseName: 'mv3-idle-heartbeat-test' }),
        endpoint: input.endpoint,
        async requestPairingCode() {
          return input.pairingCode;
        },
      });
    },
    async heartbeat(connection, connectionGeneration, heartbeat) {
      await sendAgentHeartbeat(connection, connectionGeneration, heartbeat.timeoutMilliseconds);
    },
    async reconcile(connection, connectionGeneration) {
      const response = new Promise<BrokerToAgentMessage>((resolve) => {
        const removeListener = connection.onMessage((message) => {
          if (message.kind !== 'response' || message.method !== 'agent.hello') return;
          removeListener();
          resolve(message);
        });
      });
      await connection.send({
        kind: 'request',
        method: 'agent.hello',
        parameters: {
          connectionGeneration,
          features: [],
          heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
          implementation: { instanceId: crypto.randomUUID(), name: 'mv3-idle-heartbeat-test', role: 'agent', version: '0.0.0' },
          limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 16_384 },
          protocolVersions: { maximum: 1, minimum: 1 },
        },
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
      });
      const message = await response;
      if (message.kind !== 'response' || message.method !== 'agent.hello' || message.result.connectionGeneration !== connectionGeneration) {
        throw new Error('The idle heartbeat generation is invalid.');
      }
      connectedAgent = connection;
      resolveReady?.();
      return message.result.heartbeat;
    },
  });
  recovery.start();
  await ready;
  await new Promise<void>(resolve => globalThis.setTimeout(resolve, 31_000));
  if (recovery.connection !== connectedAgent || connectedAgent === undefined) throw new Error('The idle MV3 agent did not remain connected.');
  await connectedAgent.send({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target: { availability: 'available', capabilities: { level: 'observe' }, generation: 1, id: crypto.randomUUID(), scopeId: crypto.randomUUID(), type: 'page' } },
    protocolVersion: 1,
  });
  await new Promise<void>(resolve => globalThis.setTimeout(resolve, 100));
  recovery.stop();
  await connectedAgent.closed;
};

bridgeTestGlobal.runBirpcBootstrapTest = async (input) => {
  const endpoint = input.endpoint;
  const offer = {
    brokerId: 'de2d3196-3e05-4f9d-9c93-d6651b9e38a2',
    endpoint,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: crypto.randomUUID(),
    protocolVersions: { maximum: 1, minimum: 1 },
  };
  const bootstrap = createBirpcAgentBootstrap({
    async connect(candidate) {
      return connectAgentWebSocket({
        credentialStore: createIndexedDbPairingStore({ databaseName: `mv3-birpc-bootstrap-${candidate.nonce}` }),
        endpoint: candidate.endpoint,
        async requestPairingCode() {
          return input.pairingCode;
        },
      });
    },
    locator: { async locate(candidate) {
      return candidate.endpoint === endpoint ? candidate : undefined;
    } },
    pairingPolicy: { async approve(_candidate, origin) {
      return origin === 'https://birpc.example.test';
    } },
  });
  const malformedRejected = await bootstrap.accept({ kind: 'chrome-debugger-bridge.birpc-offer', offer: { invalid: true }, origin: 'https://birpc.example.test' }) === undefined;
  const wrongOriginRejected = await bootstrap.accept({ kind: 'chrome-debugger-bridge.birpc-offer', offer: { ...offer, nonce: crypto.randomUUID() }, origin: 'https://attacker.example.test' }) === undefined;
  const connection = await bootstrap.accept({ kind: 'chrome-debugger-bridge.birpc-offer', offer, origin: 'https://birpc.example.test' });
  if (connection === undefined) throw new Error('The Birpc offer did not open a direct agent connection.');
  bootstrap.dispose();
  const response = new Promise<BrokerToAgentMessage>((resolve) => {
    const removeListener = connection.onMessage((message) => {
      removeListener();
      resolve(message);
    });
  });
  await connection.send({
    kind: 'request',
    method: 'agent.hello',
    parameters: {
      connectionGeneration: 1,
      features: ['bridge.cdp.read'],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: { instanceId: crypto.randomUUID(), name: 'mv3-birpc-bootstrap-test', role: 'agent', version: '0.0.0' },
      limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 16_384 },
      protocolVersions: { maximum: 1, minimum: 1 },
    },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  });
  const message = await response;
  connection.close(1000, 'Birpc bootstrap test complete');
  await connection.closed;
  return { brokerId: connection.brokerId, malformedRejected, responseMethod: message.method, wrongOriginRejected };
};

bridgeTestGlobal.runDebuggerLifecycleTest = async () => {
  const [tab] = await chrome.tabs.query({ active: true });
  if (tab?.id === undefined) throw new Error('No active tab is available.');
  const target = { tabId: tab.id };
  await chrome.debugger.attach(target, '1.3');
  let value = '';
  try {
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'document.title' });
    value = result.result?.value ?? '';
  } finally {
    await chrome.debugger.detach(target);
  }
  try {
    await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'document.title' });
    return { revoked: false, value };
  } catch {
    return { revoked: true, value };
  }
};

bridgeTestGlobal.runPublishedTargetLifecycleTest = async (updatedUrl) => {
  const [tab] = await chrome.tabs.query({ active: true });
  if (tab?.id === undefined) throw new Error('No active tab is available.');
  const outcomes: Array<{ readonly kind: 'published' | 'revoked' | 'updated'; readonly reason?: string }> = [];
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'interact' },
    chromeDebugger: chrome.debugger,
    metadataPolicy: input => ({ title: input.title, url: input.url }),
    publishTarget() {
      outcomes.push({ kind: 'published' });
    },
    revokeTarget(_target, reason) {
      outcomes.push({ kind: 'revoked', reason });
    },
    scopeId: crypto.randomUUID(),
    updateTarget() {
      outcomes.push({ kind: 'updated' });
    },
  });
  const lifecycle = createSelectedTabLifecycle({ chrome: chrome as never, publisher });
  lifecycle.start();
  try {
    await publisher.publish({
      incognito: tab.incognito ?? false,
      tabId: tab.id,
      ...(tab.title === undefined ? {} : { title: tab.title }),
      ...(tab.url === undefined ? {} : { url: tab.url }),
    });
    await chrome.tabs.update(tab.id, { url: updatedUrl });
    await new Promise(resolve => setTimeout(resolve, 100));
    await chrome.debugger.detach({ tabId: tab.id });
    await publisher.debuggerDetached(tab.id);
    return outcomes;
  } finally {
    lifecycle.stop();
    await publisher.revoke();
  }
};

async function negotiatePublishedTargetAgent(connection: BrowserAgentConnection): Promise<void> {
  const requestId = crypto.randomUUID();
  const response = new Promise<Extract<BrokerToAgentMessage, { readonly kind: 'response'; readonly method: 'agent.hello' }>>((resolve, reject) => {
    let removeListener: (() => void) | undefined;
    const timeout = setTimeout(() => {
      removeListener?.();
      reject(new Error('The published target agent hello response timed out.'));
    }, 5_000);
    removeListener = connection.onMessage((message) => {
      if ((message.kind !== 'response' && message.kind !== 'error') || message.requestId !== requestId || message.method !== 'agent.hello') return;
      clearTimeout(timeout);
      removeListener?.();
      if (message.kind === 'error') {
        reject(new Error(message.error.message));
        return;
      }
      if (message.kind !== 'response') return;
      resolve(message);
    });
  });
  await connection.send({
    kind: 'request',
    method: 'agent.hello',
    parameters: {
      connectionGeneration: 1,
      features: ['bridge.cdp.read'],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: { instanceId: crypto.randomUUID(), name: 'mv3-published-target-agent-test', role: 'agent', version: '0.0.0' },
      limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 16_384 },
      protocolVersions: { maximum: 1, minimum: 1 },
    },
    protocolVersion: 1,
    requestId,
  });
  const message = await response;
  if (message.result.connectionGeneration !== 1) throw new Error('The published target agent hello generation is invalid.');
}

bridgeTestGlobal.runPublishedTargetAgentTest = async (input) => {
  const [tab] = await chrome.tabs.query({ active: true });
  if (tab?.id === undefined) throw new Error('No active tab is available.');
  let connection = await connectAgentWebSocket({
    credentialStore: createIndexedDbPairingStore({ databaseName: 'mv3-published-target-agent-test' }),
    endpoint: input.endpoint,
    async requestPairingCode() {
      return input.pairingCode;
    },
  });
  await negotiatePublishedTargetAgent(connection);
  let setSubscriptionDemand: ((methodPrefix: string, active: boolean, sessionId?: string) => Promise<void>) | undefined;
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: chrome.debugger,
    publishEvent(target, method, parameters, sessionId) {
      void connection.send({ kind: 'notification', method: 'cdp.event', parameters: { method, parameters, ...(sessionId === undefined ? {} : { sessionId }), targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1 });
    },
    async publishTarget(target) {
      await connection.send({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
    },
    async revokeTarget(target, reason) {
      await connection.send({ kind: 'notification', method: 'targets.revoke', parameters: { reason, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1 });
    },
    scopeId: crypto.randomUUID(),
    registerTargetExecutor(_target, executor) {
      setSubscriptionDemand = executor.setSubscriptionDemand;
    },
    async updateTarget(target) {
      await connection.send({ kind: 'notification', method: 'targets.update', parameters: { target }, protocolVersion: 1 });
    },
  });
  const cancellations = new Map<string, AbortController>();
  const bindConnection = (nextConnection: BrowserAgentConnection): void => {
    connection = nextConnection;
    connection.onMessage((message) => {
      if (message.kind === 'notification' && message.method === 'cdp.cancel') {
        cancellations.get(message.parameters.operationId)?.abort();
        return;
      }
      if (message.kind === 'notification' && message.method === 'cdp.subscription-demand') {
        void setSubscriptionDemand?.(message.parameters.methodPrefix, message.parameters.active, message.parameters.sessionId);
        return;
      }
      if (message.kind !== 'request' || message.method !== 'cdp.execute') return;
      const executionRequest = message;
      const { command, lease } = executionRequest.parameters;
      const abortController = new AbortController();
      cancellations.set(command.operationId, abortController);
      void publisher.executeCommand(command, abortController.signal, lease).then(
        async value => connection.send({ kind: 'response', method: 'cdp.execute', protocolVersion: 1, requestId: executionRequest.requestId, result: { operationId: command.operationId, value } }),
        async () => connection.send({ error: { code: 'CDP_COMMAND_FAILED', message: 'The debugger command failed.', retryable: false }, kind: 'error', method: 'cdp.execute', protocolVersion: 1, requestId: executionRequest.requestId }),
      ).finally(() => cancellations.delete(command.operationId));
    });
  };
  bindConnection(connection);
  const debuggerEventListener = (source: { readonly sessionId?: string; readonly tabId?: number }, method: string, parameters: JsonObject): void => {
    publisher.debuggerEvent(source, method, parameters);
  };
  chrome.debugger.onEvent.addListener(debuggerEventListener);
  const target = await publisher.publish({
    incognito: tab.incognito ?? false,
    tabId: tab.id,
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.url === undefined ? {} : { url: tab.url }),
  });
  publishedTargetAgent = { bindConnection, connection, publisher, removeDebuggerEventListener: () => chrome.debugger.onEvent.removeListener(debuggerEventListener) };
  return { generation: target.generation, id: target.id };
};

bridgeTestGlobal.recoverPublishedTargetAgentTest = async (input) => {
  const activeAgent = publishedTargetAgent;
  if (activeAgent === undefined) throw new Error('No published target agent is available.');
  activeAgent.connection.close(3001, 'Published target transport interruption');
  await activeAgent.connection.closed;
  const recoveredConnection = await connectAgentWebSocket({
    credentialStore: createIndexedDbPairingStore({ databaseName: 'mv3-published-target-agent-test' }),
    endpoint: input.endpoint,
    async requestPairingCode() {
      return input.pairingCode;
    },
  });
  await negotiatePublishedTargetAgent(recoveredConnection);
  activeAgent.bindConnection(recoveredConnection);
  activeAgent.connection = recoveredConnection;
  return activeAgent.publisher.renewAuthority();
};

bridgeTestGlobal.revokePublishedTargetAgentTest = async () => {
  const activeAgent = publishedTargetAgent;
  publishedTargetAgent = undefined;
  if (activeAgent === undefined) return;
  activeAgent.removeDebuggerEventListener();
  await activeAgent.publisher.revoke();
  activeAgent.connection.close(1000, 'Published target test completed');
  await activeAgent.connection.closed;
};

bridgeTestGlobal.interruptPublishedTargetAgentTest = async () => {
  const activeAgent = publishedTargetAgent;
  publishedTargetAgent = undefined;
  if (activeAgent === undefined) return;
  activeAgent.removeDebuggerEventListener();
  activeAgent.connection.close(3001, 'Published target transport interruption');
  await activeAgent.connection.closed;
};
