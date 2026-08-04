import type { BrokerToClientMessage } from '@dvcol/chrome-debugger-bridge/protocol';

import type { AgentAuthenticationTranscript } from '../src/authentication.js';
import type {
  AgentAuthenticationAdapter,
  AuthenticatedAgentConnection,
  StandaloneAuthenticatedWebSocketBridge,
} from '../src/node.js';

import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  createAgentAuthenticationProof,
  decodeBase64UrlBytes,
  generateRandomBase64Url,
  importAgentCredential,
} from '../src/authentication.js';
import {
  agentWebSocketProtocol,
  clientWebSocketProtocol,
  connectNodeClientWebSocket,
  createStandaloneAuthenticatedWebSocketBridge,
} from '../src/node.js';
import {
  createMemoryAgentAuthenticationAdapter,
  createStaticClientAuthenticationAdapter,
} from '../src/testing.js';

const openBridges: StandaloneAuthenticatedWebSocketBridge[] = [];

afterEach(async () => {
  await Promise.all(openBridges.splice(0).map(async bridge => bridge.close()));
});

async function createTestBridge(options: {
  readonly agentAuthentication?: AgentAuthenticationAdapter<{ readonly id: string; readonly role: 'agent' }>;
  readonly brokerId?: string;
  readonly handshakeTimeoutMilliseconds?: number;
  readonly holdClientAuthentication?: boolean;
  readonly maximumMessageBytes?: number;
  readonly maximumPreAuthenticationBytes?: number;
  readonly maximumPreAuthenticationMessages?: number;
  readonly maximumUnauthenticatedConnections?: number;
  readonly onAgentConnection?: (
    connection: AuthenticatedAgentConnection<{ readonly id: string; readonly role: 'agent' }>,
  ) => void;
  readonly onClientMessage?: () => void;
  readonly onClientPrincipal?: (principalId: string) => void;
  readonly originPolicy?: (origin: string | undefined) => boolean | Promise<boolean>;
  readonly pairingTimeoutMilliseconds?: number;
} = {}): Promise<StandaloneAuthenticatedWebSocketBridge> {
  const brokerId = options.brokerId ?? crypto.randomUUID();
  const bridge = await createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication: options.agentAuthentication ?? createMemoryAgentAuthenticationAdapter({
      brokerId,
      pairingCode: '047204',
      pairingCodeExpiresAt: Date.now() + 300_000,
      principal: { id: crypto.randomUUID(), role: 'agent' as const },
    }),
    brokerId,
    clientAuthentication: options.holdClientAuthentication
      ? { async authenticate() {
          return new Promise<never>(() => {});
        } }
      : createStaticClientAuthenticationAdapter(
          'Bearer valid-client-token',
          { id: '30000000-0000-4000-8000-000000000001', role: 'client' as const },
        ),
    limits: {
      ...(options.handshakeTimeoutMilliseconds === undefined
        ? {}
        : { handshakeTimeoutMilliseconds: options.handshakeTimeoutMilliseconds }),
      ...(options.maximumMessageBytes === undefined ? {} : { maximumMessageBytes: options.maximumMessageBytes }),
      ...(options.maximumPreAuthenticationBytes === undefined
        ? {}
        : { maximumPreAuthenticationBytes: options.maximumPreAuthenticationBytes }),
      ...(options.maximumPreAuthenticationMessages === undefined
        ? {}
        : { maximumPreAuthenticationMessages: options.maximumPreAuthenticationMessages }),
      ...(options.maximumUnauthenticatedConnections === undefined
        ? {}
        : { maximumUnauthenticatedConnections: options.maximumUnauthenticatedConnections }),
      ...(options.pairingTimeoutMilliseconds === undefined
        ? {}
        : { pairingTimeoutMilliseconds: options.pairingTimeoutMilliseconds }),
    },
    onAgentConnection(connection) {
      options.onAgentConnection?.(connection);
    },
    onClientConnection({ connection, principal }) {
      options.onClientPrincipal?.(principal.id);
      connection.onMessage((message) => {
        options.onClientMessage?.();
        if (message.kind !== 'request' || message.method !== 'broker.info') {
          return;
        }
        void connection.send({
          kind: 'response',
          method: 'broker.info',
          protocolVersion: 1,
          requestId: message.requestId,
          result: {
            broker: {
              instanceId: brokerId,
              name: 'node-test-broker',
              role: 'broker',
              version: '0.0.0',
            },
            features: [],
            limits: {
              maximumArtifactBytes: 16_777_216,
              maximumInlineResultBytes: 65_536,
              maximumMessageBytes: 16_384,
            },
            protocolVersion: 1,
          },
        });
      });
    },
    async originPolicy({ origin }) {
      return options.originPolicy?.(origin) ?? true;
    },
  });
  openBridges.push(bridge);
  return bridge;
}

async function waitForClientMessage(
  connection: { onMessage: (listener: (message: BrokerToClientMessage) => void) => () => void },
): Promise<BrokerToClientMessage> {
  return new Promise((resolve) => {
    const removeListener = connection.onMessage((message) => {
      removeListener();
      resolve(message);
    });
  });
}

async function waitForClose(webSocket: WebSocket): Promise<number> {
  return new Promise(resolve => webSocket.once('close', code => resolve(code)));
}

async function waitForMessage(webSocket: WebSocket): Promise<string> {
  return new Promise(resolve => webSocket.once('message', data => resolve(data.toString())));
}

async function waitForTestStage<Value>(promise: Promise<Value>, stage: string): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out: ${stage}`)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
}

async function openAgentWebSocket(bridge: StandaloneAuthenticatedWebSocketBridge, origin: string): Promise<WebSocket> {
  const webSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    agentWebSocketProtocol,
    { headers: { origin } },
  );
  await new Promise<void>((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
  });
  return webSocket;
}

function createAuthenticationBegin(credentialId?: string): string {
  return JSON.stringify({
    kind: 'request',
    method: 'agent.auth.begin',
    parameters: {
      agentId: crypto.randomUUID(),
      clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ...(credentialId === undefined ? {} : { credentialId }),
      endpointPath: '/__chrome_debugger_bridge/agent',
      origin: 'chrome-extension://limit-test',
      protocolVersions: { maximum: 1, minimum: 1 },
      role: 'agent',
    },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  });
}

async function authenticateStoredAgentWebSocket(webSocket: WebSocket, input: {
  readonly agentId: string;
  readonly brokerId: string;
  readonly credential: Uint8Array;
  readonly credentialId: string;
  readonly origin: string;
}): Promise<void> {
  const clientNonce = generateRandomBase64Url(32);
  webSocket.send(JSON.stringify({
    kind: 'request',
    method: 'agent.auth.begin',
    parameters: {
      agentId: input.agentId,
      clientNonce,
      credentialId: input.credentialId,
      endpointPath: '/__chrome_debugger_bridge/agent',
      expectedBrokerId: input.brokerId,
      origin: input.origin,
      protocolVersions: { maximum: 1, minimum: 1 },
      role: 'agent',
    },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));
  const beginResponse = JSON.parse(await waitForMessage(webSocket)) as {
    readonly kind: string;
    readonly result: {
      readonly connectionId: string;
      readonly expiresAt: string;
      readonly serverNonce: string;
    };
  };
  if (beginResponse.kind !== 'response') {
    throw new Error('Expected an authentication challenge');
  }
  const transcript: AgentAuthenticationTranscript = {
    agentId: input.agentId,
    brokerId: input.brokerId,
    clientNonce,
    connectionId: beginResponse.result.connectionId,
    credentialId: input.credentialId,
    endpointPath: '/__chrome_debugger_bridge/agent',
    expiresAt: beginResponse.result.expiresAt,
    origin: input.origin,
    protocolVersion: 1,
    serverNonce: beginResponse.result.serverNonce,
  };
  const credentialKey = await importAgentCredential(input.credential);
  webSocket.send(JSON.stringify({
    kind: 'request',
    method: 'agent.auth.finish',
    parameters: {
      connectionId: transcript.connectionId,
      credentialId: input.credentialId,
      proof: await createAgentAuthenticationProof(credentialKey, transcript),
    },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));
  const finishResponse = JSON.parse(await waitForMessage(webSocket)) as { readonly kind: string };
  if (finishResponse.kind !== 'response') {
    throw new Error('Expected authentication to finish');
  }
}

async function waitForRejectedUpgrade(webSocket: WebSocket): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    webSocket.once('error', reject);
    webSocket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
}

it('authenticates a generic Node client separately and completes a validated round trip', async () => {
  expect.assertions(3);
  let receivedPrincipalId: string | undefined;
  const bridge = await createTestBridge({
    onClientPrincipal(principalId) {
      receivedPrincipalId = principalId;
    },
  });
  const endpoint = `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/client`;
  const connection = await connectNodeClientWebSocket({
    authorization: 'Bearer valid-client-token',
    endpoint,
  });
  const responsePromise = waitForClientMessage(connection);
  await connection.send({
    kind: 'request',
    method: 'broker.info',
    parameters: {},
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000001',
  });
  const response = await responsePromise;

  expect(receivedPrincipalId).toBe('30000000-0000-4000-8000-000000000001');
  expect(response.kind).toBe('response');
  expect(response.method).toBe('broker.info');
  connection.close();
});

it('rejects invalid client authority without creating a client connection', async () => {
  expect.assertions(1);
  const bridge = await createTestBridge();
  await expect(connectNodeClientWebSocket({
    authorization: 'Bearer invalid-client-token',
    endpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/client`,
  })).rejects.toThrow('401');
});

it('times out pending generic client authentication', async () => {
  expect.assertions(1);
  const bridge = await createTestBridge({ handshakeTimeoutMilliseconds: 25, holdClientAuthentication: true });

  await expect(connectNodeClientWebSocket({
    authorization: 'Bearer valid-client-token',
    endpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/client`,
  })).rejects.toThrow('408');
});

it('rejects malformed frames from an authenticated generic client', async () => {
  expect.assertions(1);
  const bridge = await createTestBridge();
  const webSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/client`,
    clientWebSocketProtocol,
    { headers: { authorization: 'Bearer valid-client-token' } },
  );
  await new Promise<void>((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
  });
  const close = waitForClose(webSocket);
  webSocket.send('{');

  expect(await close).toBe(1008);
});

it('does not deliver valid generic-client frames queued after a fatal frame', async () => {
  expect.assertions(2);
  let deliveredMessages = 0;
  const bridge = await createTestBridge({ onClientMessage: () => deliveredMessages += 1 });
  const webSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/client`,
    clientWebSocketProtocol,
    { headers: { authorization: 'Bearer valid-client-token' } },
  );
  await new Promise<void>((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
  });
  const close = waitForClose(webSocket);
  webSocket.send('{');
  webSocket.send(JSON.stringify({
    kind: 'request',
    method: 'broker.info',
    parameters: {},
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));

  expect(await close).toBe(1008);
  expect(deliveredMessages).toBe(0);
});

it('rejects a client subprotocol on the agent endpoint before authentication', async () => {
  expect.assertions(1);
  const bridge = await createTestBridge();
  const webSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    clientWebSocketProtocol,
  );

  expect(await waitForRejectedUpgrade(webSocket)).toBe(400);
});

it('applies the host origin policy before agent authentication', async () => {
  expect.assertions(1);
  const bridge = await createTestBridge({ originPolicy: origin => origin === 'chrome-extension://allowed' });
  const webSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    agentWebSocketProtocol,
    { headers: { origin: 'chrome-extension://denied' } },
  );

  expect(await waitForRejectedUpgrade(webSocket)).toBe(403);
});

it('bounds and times out sockets while the host origin policy is pending', async () => {
  expect.assertions(2);
  let notifyPolicyStarted: (() => void) | undefined;
  const policyStarted = new Promise<void>(resolve => notifyPolicyStarted = resolve);
  const bridge = await createTestBridge({
    handshakeTimeoutMilliseconds: 50,
    maximumUnauthenticatedConnections: 1,
    async originPolicy() {
      notifyPolicyStarted?.();
      return new Promise<boolean>(() => {});
    },
  });
  const endpoint = `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`;
  const firstWebSocket = new WebSocket(endpoint, agentWebSocketProtocol);
  const firstRejection = waitForRejectedUpgrade(firstWebSocket);
  await policyStarted;
  const secondWebSocket = new WebSocket(endpoint, agentWebSocketProtocol);

  expect(await waitForRejectedUpgrade(secondWebSocket)).toBe(503);
  expect(await firstRejection).toBe(408);
});

it('rejects client-plane role confusion on the agent endpoint', async () => {
  expect.assertions(2);
  let agentConnections = 0;
  const bridge = await createTestBridge({
    onAgentConnection() {
      agentConnections += 1;
    },
  });
  const webSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    agentWebSocketProtocol,
    {
      headers: { origin: 'chrome-extension://role-confusion' },
    },
  );
  await new Promise<void>((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
  });
  const closePromise = waitForClose(webSocket);
  webSocket.send(JSON.stringify({
    kind: 'request',
    method: 'broker.info',
    parameters: {},
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));

  expect(await closePromise).toBe(1008);
  expect(agentConnections).toBe(0);
});

it('fails closed instead of pairing when an offered credential is invalid', async () => {
  expect.assertions(2);
  const bridge = await createTestBridge();
  const webSocket = await openAgentWebSocket(bridge, 'chrome-extension://limit-test');
  const close = waitForClose(webSocket);
  webSocket.send(createAuthenticationBegin(crypto.randomUUID()));
  const response = JSON.parse(await waitForMessage(webSocket)) as { readonly kind?: unknown };

  expect(response.kind).toBe('error');
  expect(await close).toBe(1008);
});

it('closes stalled unauthenticated agent connections at the handshake deadline', async () => {
  expect.assertions(1);
  const bridge = await createTestBridge({ handshakeTimeoutMilliseconds: 25 });
  const webSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    agentWebSocketProtocol,
    {
      headers: { origin: 'chrome-extension://timeout' },
    },
  );
  const closePromise = waitForClose(webSocket);
  expect(await closePromise).toBe(1008);
});

it('revokes a pending credential returned after its pairing connection times out', async () => {
  expect.assertions(2);
  let releasePairing: (() => void) | undefined;
  let notifyPairingStarted: (() => void) | undefined;
  let notifyRevoked: ((credentialId: string) => void) | undefined;
  const pairingStarted = new Promise<void>(resolve => notifyPairingStarted = resolve);
  const revoked = new Promise<string>(resolve => notifyRevoked = resolve);
  let reservedCredentialId: string | undefined;
  const adapter: AgentAuthenticationAdapter<{ readonly id: string; readonly role: 'agent' }> = {
    async activate() {
      return undefined;
    },
    async authenticate() {
      return undefined;
    },
    async load() {
      return undefined;
    },
    async pair(input) {
      reservedCredentialId = input.credentialId;
      notifyPairingStarted?.();
      await new Promise<void>(resolve => releasePairing = resolve);
      return {
        agentId: input.agentId,
        brokerId: input.brokerId,
        credential: Uint8Array.from(input.credential),
        credentialId: input.credentialId,
        principalId: '50000000-0000-4000-8000-000000000001',
        status: 'pending',
      };
    },
    async revoke(credentialId) {
      notifyRevoked?.(credentialId);
    },
  };
  const bridge = await createTestBridge({
    agentAuthentication: adapter,
    handshakeTimeoutMilliseconds: 100,
    pairingTimeoutMilliseconds: 100,
  });
  const webSocket = await openAgentWebSocket(bridge, 'chrome-extension://limit-test');
  webSocket.send(createAuthenticationBegin());
  const challenge = JSON.parse(await waitForMessage(webSocket)) as {
    readonly result: { readonly connectionId: string };
  };
  const close = waitForClose(webSocket);
  webSocket.send(JSON.stringify({
    kind: 'request',
    method: 'agent.pair.finish',
    parameters: { connectionId: challenge.result.connectionId, pairingCode: '047204' },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));
  await pairingStarted;

  expect(await close).toBe(1008);
  releasePairing?.();
  expect(await revoked).toBe(reservedCredentialId);
});

it('closes live agent connections before durable credential revocation completes', async () => {
  expect.assertions(3);
  const brokerId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const origin = 'chrome-extension://revocation-test';
  const principal = { id: crypto.randomUUID(), role: 'agent' as const };
  let durableRevocationCompleted = false;
  let releaseRevocation: (() => void) | undefined;
  let notifyAgentConnected: (() => void) | undefined;
  let notifyRevocationStarted: (() => void) | undefined;
  const agentConnected = new Promise<void>(resolve => notifyAgentConnected = resolve);
  const revocationGate = new Promise<void>(resolve => releaseRevocation = resolve);
  const revocationStarted = new Promise<void>(resolve => notifyRevocationStarted = resolve);
  const activeRecord = {
    agentId,
    brokerId,
    credential,
    credentialId,
    principalId: principal.id,
    status: 'active' as const,
  };
  const adapter: AgentAuthenticationAdapter<typeof principal> = {
    async activate() {
      return undefined;
    },
    async authenticate(identity) {
      return identity.credentialId === credentialId ? principal : undefined;
    },
    async load(requestedCredentialId) {
      return requestedCredentialId === credentialId ? activeRecord : undefined;
    },
    async pair() {
      return undefined;
    },
    async revoke(requestedCredentialId) {
      if (requestedCredentialId !== credentialId) {
        return;
      }
      notifyRevocationStarted?.();
      await revocationGate;
      durableRevocationCompleted = true;
    },
  };
  const bridge = await createTestBridge({
    agentAuthentication: adapter,
    brokerId,
    onAgentConnection() {
      notifyAgentConnected?.();
    },
  });
  const webSocket = await openAgentWebSocket(bridge, origin);
  await waitForTestStage(
    authenticateStoredAgentWebSocket(webSocket, { agentId, brokerId, credential, credentialId, origin }),
    'authenticate stored agent',
  );
  await waitForTestStage(agentConnected, 'register stored agent');
  const close = waitForClose(webSocket);
  const revocationPromise = bridge.revokeAgentCredential(credentialId);
  await waitForTestStage(revocationStarted, 'start durable revocation');
  let durableRevocationCompletedAtClose: boolean | undefined;
  let closeCode: number | undefined;
  try {
    closeCode = await close;
    durableRevocationCompletedAtClose = durableRevocationCompleted;
  } finally {
    releaseRevocation?.();
    await revocationPromise;
  }

  expect(closeCode).toBe(1008);
  expect(durableRevocationCompletedAtClose).toBe(false);
  expect(durableRevocationCompleted).toBe(true);
});

it('revokes every connection that races with activation of a new credential', async () => {
  expect.assertions(4);
  const brokerId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const origin = 'chrome-extension://activation-race-test';
  const principal = { id: crypto.randomUUID(), role: 'agent' as const };
  const records = new Map<string, {
    readonly agentId: string;
    readonly brokerId: string;
    readonly credential: Uint8Array;
    readonly credentialId: string;
    readonly principalId: string;
    readonly status: 'active' | 'pending';
  }>();
  let agentConnections = 0;
  let releaseActivation: (() => void) | undefined;
  let notifyActivationStarted: (() => void) | undefined;
  let notifySecondAgentConnected: (() => void) | undefined;
  const activationGate = new Promise<void>(resolve => releaseActivation = resolve);
  const activationStarted = new Promise<void>(resolve => notifyActivationStarted = resolve);
  const secondAgentConnected = new Promise<void>(resolve => notifySecondAgentConnected = resolve);
  const adapter: AgentAuthenticationAdapter<typeof principal> = {
    async activate(record) {
      const activeRecord = { ...record, status: 'active' as const };
      records.set(record.credentialId, activeRecord);
      notifyActivationStarted?.();
      await activationGate;
      return activeRecord;
    },
    async authenticate(identity) {
      const record = records.get(identity.credentialId);
      return record?.status === 'active' ? principal : undefined;
    },
    async load(credentialId) {
      return records.get(credentialId);
    },
    async pair(input) {
      const pendingRecord = {
        agentId: input.agentId,
        brokerId: input.brokerId,
        credential: Uint8Array.from(input.credential),
        credentialId: input.credentialId,
        principalId: principal.id,
        status: 'pending' as const,
      };
      records.set(input.credentialId, pendingRecord);
      return pendingRecord;
    },
    async revoke(credentialId) {
      records.delete(credentialId);
    },
  };
  const bridge = await createTestBridge({
    agentAuthentication: adapter,
    brokerId,
    onAgentConnection() {
      agentConnections += 1;
      notifySecondAgentConnected?.();
    },
  });
  const firstWebSocket = await openAgentWebSocket(bridge, origin);
  const clientNonce = generateRandomBase64Url(32);
  firstWebSocket.send(JSON.stringify({
    kind: 'request',
    method: 'agent.auth.begin',
    parameters: {
      agentId,
      clientNonce,
      endpointPath: '/__chrome_debugger_bridge/agent',
      origin,
      protocolVersions: { maximum: 1, minimum: 1 },
      role: 'agent',
    },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));
  const beginResponse = JSON.parse(await waitForMessage(firstWebSocket)) as {
    readonly result: {
      readonly connectionId: string;
      readonly expiresAt: string;
      readonly serverNonce: string;
    };
  };
  firstWebSocket.send(JSON.stringify({
    kind: 'request',
    method: 'agent.pair.finish',
    parameters: { connectionId: beginResponse.result.connectionId, pairingCode: '047204' },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));
  const pairingResponse = JSON.parse(await waitForMessage(firstWebSocket)) as {
    readonly result: { readonly credential: string; readonly credentialId: string };
  };
  const credential = decodeBase64UrlBytes(pairingResponse.result.credential);
  const transcript: AgentAuthenticationTranscript = {
    agentId,
    brokerId,
    clientNonce,
    connectionId: beginResponse.result.connectionId,
    credentialId: pairingResponse.result.credentialId,
    endpointPath: '/__chrome_debugger_bridge/agent',
    expiresAt: beginResponse.result.expiresAt,
    origin,
    protocolVersion: 1,
    serverNonce: beginResponse.result.serverNonce,
  };
  firstWebSocket.send(JSON.stringify({
    kind: 'request',
    method: 'agent.auth.finish',
    parameters: {
      connectionId: transcript.connectionId,
      credentialId: transcript.credentialId,
      proof: await createAgentAuthenticationProof(await importAgentCredential(credential), transcript),
    },
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  }));
  const firstFinishResponse = JSON.parse(await waitForTestStage(
    waitForMessage(firstWebSocket),
    'receive first finish response',
  )) as { readonly kind: string };
  await waitForTestStage(activationStarted, 'start first activation');
  const secondWebSocket = await openAgentWebSocket(bridge, origin);
  await waitForTestStage(authenticateStoredAgentWebSocket(secondWebSocket, {
    agentId,
    brokerId,
    credential,
    credentialId: transcript.credentialId,
    origin,
  }), 'authenticate racing agent');
  await waitForTestStage(secondAgentConnected, 'register racing agent');
  const secondClose = waitForClose(secondWebSocket);
  firstWebSocket.close();
  try {
    expect(firstFinishResponse.kind).toBe('response');
    expect(await secondClose).toBe(1008);
    expect(records.has(transcript.credentialId)).toBe(false);
    expect(agentConnections).toBe(1);
  } finally {
    releaseActivation?.();
  }
});

it('enforces cumulative byte and message limits before authentication', async () => {
  expect.assertions(2);
  const authenticationBegin = createAuthenticationBegin();
  const messageLimitedBridge = await createTestBridge({ maximumPreAuthenticationMessages: 1 });
  const messageLimitedSocket = await openAgentWebSocket(messageLimitedBridge, 'chrome-extension://limit-test');
  messageLimitedSocket.send(authenticationBegin);
  await waitForMessage(messageLimitedSocket);
  const messageLimitedClose = waitForClose(messageLimitedSocket);
  messageLimitedSocket.send('{}');
  expect(await messageLimitedClose).toBe(1008);

  const byteLimitedBridge = await createTestBridge({
    maximumPreAuthenticationBytes: authenticationBegin.length + 1,
  });
  const byteLimitedSocket = await openAgentWebSocket(byteLimitedBridge, 'chrome-extension://limit-test');
  byteLimitedSocket.send(authenticationBegin);
  await waitForMessage(byteLimitedSocket);
  const byteLimitedClose = waitForClose(byteLimitedSocket);
  byteLimitedSocket.send('{}');
  expect(await byteLimitedClose).toBe(1008);
});

it('rejects malformed and oversized unauthenticated frames', async () => {
  expect.assertions(2);
  const bridge = await createTestBridge({ maximumMessageBytes: 128 });
  const malformedSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    agentWebSocketProtocol,
    {
      headers: { origin: 'chrome-extension://malformed' },
    },
  );
  await new Promise<void>((resolve, reject) => {
    malformedSocket.once('open', resolve);
    malformedSocket.once('error', reject);
  });
  const malformedClose = waitForClose(malformedSocket);
  malformedSocket.send('{');
  expect(await malformedClose).toBe(1008);

  const oversizedSocket = new WebSocket(
    `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    agentWebSocketProtocol,
    {
      headers: { origin: 'chrome-extension://oversized' },
    },
  );
  await new Promise<void>((resolve, reject) => {
    oversizedSocket.once('open', resolve);
    oversizedSocket.once('error', reject);
  });
  const oversizedClose = waitForClose(oversizedSocket);
  oversizedSocket.send('x'.repeat(129));
  expect(await oversizedClose).toBe(1009);
});

it('closes authenticated generic clients during broker cleanup', async () => {
  expect.assertions(2);
  const bridge = await createTestBridge();
  const connection = await connectNodeClientWebSocket({
    authorization: 'Bearer valid-client-token',
    endpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/client`,
  });

  await bridge.close();
  openBridges.splice(openBridges.indexOf(bridge), 1);
  const close = await connection.closed;
  expect(close.code).toBe(1001);
  expect(close.reason).toBe('Server shutting down');
});
