import type { AgentToBrokerMessage, BrokerToAgentMessage } from '../../packages/core/src/protocol.js';
import type { PairedAgentCredentialStore } from '../../packages/websocket/src/browser.js';

import { expect, inject, it } from 'vitest';

import { createIndexedDbPairingStore } from '../../packages/extension/src/index.js';
import { connectAgentWebSocket } from '../../packages/websocket/src/browser.js';
import { agentWebSocketProtocol } from '../../packages/websocket/src/protocols.js';

async function waitForAgentMessage(
  connection: { onMessage: (listener: (message: BrokerToAgentMessage) => void) => () => void },
): Promise<BrokerToAgentMessage> {
  return new Promise((resolve) => {
    let messageReceived = false;
    const listenerRegistration: { remove?: () => void } = {};
    listenerRegistration.remove = connection.onMessage((message) => {
      if (messageReceived) {
        return;
      }
      messageReceived = true;
      listenerRegistration.remove?.();
      resolve(message);
    });
    if (messageReceived) {
      listenerRegistration.remove();
    }
  });
}

async function waitForNativeClose(webSocket: WebSocket): Promise<number> {
  return new Promise(resolve => webSocket.addEventListener('close', event => resolve(event.code), { once: true }));
}

it('rejects an incorrect pairing code without storing a credential', async () => {
  expect.assertions(2);
  const testContext = inject('websocketBrowserTest');
  const credentialStore = createIndexedDbPairingStore({ databaseName: `bridge-rejected-${testContext.brokerId}` });

  await expect(connectAgentWebSocket({
    credentialStore,
    endpoint: testContext.agentEndpoint,
    async requestPairingCode() {
      return '000000';
    },
  })).rejects.toThrow('Authentication failed');
  expect(await credentialStore.load(testContext.agentEndpoint)).toBeUndefined();
});

it('closes stalled and malformed native browser connections', async () => {
  expect.assertions(2);
  const testContext = inject('websocketBrowserTest');
  const stalledWebSocket = new WebSocket(testContext.agentEndpoint, agentWebSocketProtocol);
  expect(await waitForNativeClose(stalledWebSocket)).toBe(1008);

  const malformedWebSocket = new WebSocket(testContext.agentEndpoint, agentWebSocketProtocol);
  await new Promise<void>((resolve, reject) => {
    malformedWebSocket.addEventListener('open', () => resolve(), { once: true });
    malformedWebSocket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), { once: true });
  });
  const malformedClose = waitForNativeClose(malformedWebSocket);
  malformedWebSocket.send('{');
  expect(await malformedClose).toBe(1008);
});

it('aborts a pending pairing approval when the broker closes the handshake', async () => {
  expect.assertions(2);
  const testContext = inject('websocketBrowserTest');
  const credentialStore = createIndexedDbPairingStore({ databaseName: `bridge-aborted-${testContext.brokerId}` });
  let approvalSignal: AbortSignal | undefined;

  await expect(connectAgentWebSocket({
    credentialStore,
    endpoint: testContext.agentEndpoint,
    async requestPairingCode({ abortSignal }) {
      approvalSignal = abortSignal;
      return new Promise<string>(() => {});
    },
  })).rejects.toThrow('aborted');
  expect(approvalSignal?.aborted).toBe(true);
});

it('preserves broker frames sent while a new credential is being stored', async () => {
  expect.assertions(4);
  const testContext = inject('websocketBrowserTest');
  const indexedDbStore = createIndexedDbPairingStore({ databaseName: `bridge-buffered-${testContext.immediateBrokerId}` });
  let releaseSave: (() => void) | undefined;
  let notifySaveStarted: (() => void) | undefined;
  const saveGate = new Promise<void>(resolve => releaseSave = resolve);
  const saveStarted = new Promise<void>(resolve => notifySaveStarted = resolve);
  const delayedCredentialStore: PairedAgentCredentialStore = {
    async load(endpoint) {
      return indexedDbStore.load(endpoint);
    },
    async remove(credentialId) {
      await indexedDbStore.remove(credentialId);
    },
    async save(credential) {
      notifySaveStarted?.();
      await saveGate;
      await indexedDbStore.save(credential);
    },
  };
  const connectionPromise = connectAgentWebSocket({
    credentialStore: delayedCredentialStore,
    endpoint: testContext.immediateAgentEndpoint,
    async requestPairingCode(challenge) {
      expect(challenge.brokerId).toBe(testContext.immediateBrokerId);
      return testContext.immediatePairingCode;
    },
  });
  await saveStarted;
  await new Promise<void>(resolve => globalThis.setTimeout(resolve, 50));
  releaseSave?.();
  const connection = await connectionPromise;
  const immediateMessage = await waitForAgentMessage(connection);
  expect(immediateMessage.method).toBe('cdp.execute');
  const responsePromise = waitForAgentMessage(connection);
  await connection.send({
    kind: 'request',
    method: 'agent.hello',
    parameters: {
      connectionGeneration: 1,
      features: ['bridge.cdp.read'],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: {
        instanceId: crypto.randomUUID(),
        name: 'buffered-frame-test-agent',
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
  });
  const response = await responsePromise;

  expect(response.method).toBe('agent.hello');
  connection.close(1000, 'Buffered frame test complete');
  expect((await connection.closed).code).toBe(1000);
});

it('pairs a native browser agent and resumes with the stored non-extractable credential', async () => {
  expect.assertions(12);
  const testContext = inject('websocketBrowserTest');
  const credentialStore = createIndexedDbPairingStore({ databaseName: `bridge-browser-${testContext.brokerId}` });
  const instanceId = crypto.randomUUID();
  let pairingRequests = 0;
  const firstConnection = await connectAgentWebSocket({
    credentialStore,
    endpoint: testContext.agentEndpoint,
    implementation: { instanceId, name: 'stable-identity-test-agent', version: '0.0.0' },
    async requestPairingCode(challenge) {
      pairingRequests += 1;
      expect(challenge.brokerId).toBe(testContext.brokerId);
      return testContext.pairingCode;
    },
  });

  const helloRequest: Extract<AgentToBrokerMessage, { kind: 'request'; method: 'agent.hello' }> = {
    kind: 'request',
    method: 'agent.hello',
    parameters: {
      connectionGeneration: 1,
      features: ['bridge.cdp.read'],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: {
        instanceId,
        name: 'chromium-test-agent',
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
  const firstResponsePromise = waitForAgentMessage(firstConnection);
  await firstConnection.send(helloRequest);
  const firstResponse = await firstResponsePromise;

  expect(firstConnection.brokerId).toBe(testContext.brokerId);
  expect(firstResponse.kind).toBe('response');
  expect(firstResponse.method).toBe('agent.hello');
  firstConnection.close(1000, 'First connection complete');
  expect((await firstConnection.closed).code).toBe(1000);

  const storedCredential = await credentialStore.load(testContext.agentEndpoint);
  expect(storedCredential?.agentId).toBe(instanceId);
  expect(storedCredential?.key.extractable).toBe(false);
  expect(storedCredential?.key.algorithm.name).toBe('HKDF');

  const resumedConnection = await connectAgentWebSocket({
    credentialStore,
    endpoint: testContext.agentEndpoint,
    implementation: { instanceId, name: 'stable-identity-test-agent', version: '0.0.0' },
    async requestPairingCode() {
      pairingRequests += 1;
      return testContext.pairingCode;
    },
  });
  expect(resumedConnection.credentialId).toBe(firstConnection.credentialId);
  expect(pairingRequests).toBe(1);
  resumedConnection.close(1000, 'Resumed connection complete');
  expect((await resumedConnection.closed).code).toBe(1000);
  await expect(connectAgentWebSocket({
    credentialStore,
    endpoint: testContext.agentEndpoint,
    implementation: { instanceId: crypto.randomUUID(), name: 'wrong-identity-test-agent', version: '0.0.0' },
  })).rejects.toThrow('configured agent identity does not match the stored pairing');
});
