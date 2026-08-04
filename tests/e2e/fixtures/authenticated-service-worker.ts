import type { AgentToBrokerMessage, BrokerToAgentMessage } from '../../../packages/core/src/protocol.js';
import type { BrowserAgentConnection } from '../../../packages/websocket/src/browser.js';

import { createAgentRecovery, createIndexedDbPairingStore, createSelectedTabLifecycle, createSelectedTabPublisher } from '../../../packages/extension/src/index.js';
import { connectAgentWebSocket } from '../../../packages/websocket/src/browser.js';

interface ServiceWorkerTestInput {
  readonly endpoint: string;
  readonly pairingCode: string;
}

interface ServiceWorkerTestResult {
  readonly brokerId: string;
  readonly connectionId: string;
  readonly responseKind: BrokerToAgentMessage['kind'];
  readonly responseMethod: BrokerToAgentMessage['method'];
}

interface BridgeTestGlobal {
  runAuthenticatedBridgeTest: (input: ServiceWorkerTestInput) => Promise<ServiceWorkerTestResult>;
  runDebuggerLifecycleTest: () => Promise<{ readonly revoked: boolean; readonly value: string }>;
  runPublishedTargetLifecycleTest: (updatedUrl: string) => Promise<readonly { readonly kind: 'published' | 'revoked' | 'updated'; readonly reason?: string }[]>;
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
      addListener: (listener: (source: { readonly sessionId?: string; readonly tabId?: number }, method: string, parameters: Record<string, unknown>) => void) => void;
      removeListener: (listener: (source: { readonly sessionId?: string; readonly tabId?: number }, method: string, parameters: Record<string, unknown>) => void) => void;
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

bridgeTestGlobal.runAuthenticatedBridgeTest = async (input) => {
  let connection: BrowserAgentConnection | undefined;
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
    async reconcile(connectedAgent) {
      connection = connectedAgent;
      resolveReady?.();
    },
  });
  recovery.start();
  await ready;
  if (connection === undefined) throw new Error('The recovering agent did not establish a connection.');
  const activeConnection = connection;
  const response = new Promise<BrokerToAgentMessage>((resolve) => {
    const removeListener = activeConnection.onMessage((message) => {
      removeListener();
      resolve(message);
    });
  });
  const hello: Extract<AgentToBrokerMessage, { kind: 'request'; method: 'agent.hello' }> = {
    kind: 'request',
    method: 'agent.hello',
    parameters: {
      connectionGeneration: 1,
      features: ['bridge.cdp.read'],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: {
        instanceId: crypto.randomUUID(),
        name: 'mv3-service-worker-test',
        role: 'agent',
        version: '0.0.0',
      },
      limits: {
        maximumArtifactBytes: 16_777_216,
        maximumInlineResultBytes: 65_536,
        maximumMessageBytes: 16_384,
      },
      protocolVersions: { maximum: 1, minimum: 1 },
    },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  };
  await activeConnection.send(hello);
  const message = await response;
  recovery.stop();
  await activeConnection.closed;
  return {
    brokerId: activeConnection.brokerId,
    connectionId: activeConnection.connectionId,
    responseKind: message.kind,
    responseMethod: message.method,
  };
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
