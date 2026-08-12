import type { TestProject } from 'vitest/node';

import type { AgentToBrokerMessage, BrokerToAgentMessage } from '../../packages/core/src/protocol.js';

import { createServer } from 'node:http';

import { mountAuthenticatedArtifactHttpEndpoint } from '../../packages/websocket/src/artifact-http.js';
import { createStandaloneAuthenticatedWebSocketBridge } from '../../packages/websocket/src/node.js';
import {
  createMemoryAgentAuthenticationAdapter,
  createStaticClientAuthenticationAdapter,
} from '../../packages/websocket/src/testing.js';

export interface WebSocketBrowserTestContext {
  readonly artifactEndpoint: string;
  readonly artifactId: string;
  readonly agentEndpoint: string;
  readonly brokerId: string;
  readonly clientEndpoint: string;
  readonly immediateAgentEndpoint: string;
  readonly immediateBrokerId: string;
  readonly immediatePairingCode: string;
  readonly pairingCode: string;
}

function attachClientResponder(connection: {
  close: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: import('../../packages/core/src/protocol.js').ClientToBrokerMessage) => void) => () => void;
  send: (message: import('../../packages/core/src/protocol.js').BrokerToClientMessage) => Promise<void>;
}): void {
  const target = {
    availability: 'available' as const,
    capabilities: { allow: ['Runtime.evaluate', 'Runtime.consoleAPICalled'] },
    generation: 1,
    id: '30000000-0000-4000-8000-000000000002',
    scopeId: '30000000-0000-4000-8000-000000000003',
    type: 'page' as const,
  };
  void connection.send({ kind: 'notification', method: 'targets.snapshot', parameters: { sequence: 0, targets: [target] }, protocolVersion: 1 });
  connection.onMessage((message) => {
    if (message.kind !== 'request') return;
    void (async () => {
      if (message.method === 'targets.list') {
        await connection.send({ kind: 'response', method: 'targets.list', protocolVersion: 1, requestId: message.requestId, result: { targets: [target] } });
      } else if (message.method === 'leases.acquire' || message.method === 'leases.renew') {
        await connection.send({ kind: 'response', method: message.method, protocolVersion: 1, requestId: message.requestId, result: { lease: { expiresAt: new Date(Date.now() + 60_000).toISOString(), id: '30000000-0000-4000-8000-000000000004', issuedAt: new Date().toISOString(), methods: ['Runtime.evaluate', 'Runtime.consoleAPICalled'], mode: 'shared-read', targetGeneration: 1, targetId: target.id } } });
      } else if (message.method === 'cdp.send') {
        if (message.parameters.parameters?.expression === 'disconnect') {
          connection.close(1012, 'Reconnect test');
          return;
        }
        await connection.send({ kind: 'response', method: 'cdp.send', protocolVersion: 1, requestId: message.requestId, result: { operationId: message.parameters.operationId, value: { result: { type: 'string', value: 'browser client' } } } });
      } else if (message.method === 'cdp.subscribe') {
        const subscriptionId = crypto.randomUUID();
        await connection.send({ kind: 'response', method: 'cdp.subscribe', protocolVersion: 1, requestId: message.requestId, result: { subscriptionId } });
        await connection.send({ kind: 'notification', method: 'cdp.event', parameters: { method: 'Runtime.consoleAPICalled', parameters: {}, sequence: 1, subscriptionId, targetGeneration: 1, targetId: target.id }, protocolVersion: 1 });
      } else {
        await connection.send({ kind: 'response', method: message.method, protocolVersion: 1, requestId: message.requestId, result: {} } as never);
      }
    })();
  });
}

declare module 'vitest' {
  export interface ProvidedContext {
    websocketBrowserTest: WebSocketBrowserTestContext;
  }
}

function attachAgentHelloResponder(connection: {
  onMessage: (listener: (message: AgentToBrokerMessage) => void) => () => void;
  send: (message: BrokerToAgentMessage) => Promise<void>;
}, brokerId: string): void {
  connection.onMessage((message) => {
    if (message.kind !== 'request' || message.method !== 'agent.hello') {
      return;
    }
    void connection.send({
      kind: 'response',
      method: 'agent.hello',
      protocolVersion: 1,
      requestId: message.requestId,
      result: {
        broker: {
          instanceId: brokerId,
          name: 'browser-test-broker',
          role: 'broker',
          version: '0.0.0',
        },
        connectionGeneration: 1,
        features: ['bridge.cdp.read'],
        heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
        limits: {
          maximumArtifactBytes: 16_777_216,
          maximumInlineResultBytes: 65_536,
          maximumMessageBytes: 16_384,
        },
        protocolVersion: 1,
      },
    });
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const brokerId = crypto.randomUUID();
  const pairingCode = '047204';
  const agentAuthentication = createMemoryAgentAuthenticationAdapter({
    brokerId,
    pairingCode,
    pairingCodeExpiresAt: Date.now() + 5 * 60_000,
    principal: { id: crypto.randomUUID(), role: 'agent' as const },
  });
  const bridge = await createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication,
    brokerId,
    clientAuthentication: createStaticClientAuthenticationAdapter(
      'Bearer browser-test-client',
      { id: crypto.randomUUID(), role: 'client' as const },
    ),
    limits: { handshakeTimeoutMilliseconds: 500, pairingTimeoutMilliseconds: 500 },
    onAgentConnection({ connection }) {
      attachAgentHelloResponder(connection, brokerId);
    },
    onClientConnection({ connection }) {
      attachClientResponder(connection);
    },
    originPolicy({ origin, role }) {
      return role === 'client' || origin?.startsWith('http://localhost:') === true;
    },
  });
  const immediateBrokerId = crypto.randomUUID();
  const immediatePairingCode = '830162';
  const immediateBridge = await createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({
      brokerId: immediateBrokerId,
      pairingCode: immediatePairingCode,
      pairingCodeExpiresAt: Date.now() + 5 * 60_000,
      principal: { id: crypto.randomUUID(), role: 'agent' as const },
    }),
    brokerId: immediateBrokerId,
    clientAuthentication: createStaticClientAuthenticationAdapter(
      'Bearer browser-test-client',
      { id: crypto.randomUUID(), role: 'client' as const },
    ),
    limits: { handshakeTimeoutMilliseconds: 500, pairingTimeoutMilliseconds: 500 },
    onAgentConnection({ connection }) {
      attachAgentHelloResponder(connection, immediateBrokerId);
      void connection.send({
        kind: 'request',
        method: 'cdp.execute',
        parameters: {
          command: {
            leaseId: crypto.randomUUID(),
            method: 'Runtime.evaluate',
            operationId: crypto.randomUUID(),
            parameters: { expression: 'document.title' },
            targetGeneration: 1,
            targetId: crypto.randomUUID(),
          },
          lease: {
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            id: crypto.randomUUID(),
            issuedAt: new Date().toISOString(),
            methods: ['Runtime.evaluate'],
            mode: 'exclusive-control',
            targetGeneration: 1,
            targetId: crypto.randomUUID(),
          },
        },
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
      });
    },
    onClientConnection() {},
    originPolicy({ origin, role }) {
      return role === 'client' || origin?.startsWith('http://localhost:') === true;
    },
  });
  const artifactId = 'browser-client-artifact';
  const artifactBytes = new TextEncoder().encode('browser artifact boundary');
  const artifactServer = createServer();
  const artifactAuthentication = createStaticClientAuthenticationAdapter(
    'Bearer browser-test-client',
    { id: crypto.randomUUID(), role: 'client' as const },
  );
  const mountedArtifacts = mountAuthenticatedArtifactHttpEndpoint({
    authenticate: artifactAuthentication,
    async originPolicy() {
      return true;
    },
    async readArtifact(id) {
      return id === artifactId
        ? { bytes: artifactBytes, descriptor: { expiresAt: new Date(Date.now() + 60_000).toISOString(), id: artifactId, length: artifactBytes.byteLength, mediaType: 'text/plain' } }
        : undefined;
    },
    server: artifactServer,
  });
  await new Promise<void>(resolve => artifactServer.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const artifactAddress = artifactServer.address();
  if (artifactAddress === null || typeof artifactAddress === 'string') throw new Error('Artifact test server did not expose a TCP address.');
  project.provide('websocketBrowserTest', {
    agentEndpoint: `ws://${bridge.host}:${bridge.port}/cdb/agent`,
    brokerId,
    artifactEndpoint: `http://127.0.0.1:${artifactAddress.port}/cdb/artifacts/`,
    artifactId,
    clientEndpoint: `ws://${bridge.host}:${bridge.port}/cdb/client`,
    immediateAgentEndpoint: `ws://${immediateBridge.host}:${immediateBridge.port}/cdb/agent`,
    immediateBrokerId,
    immediatePairingCode,
    pairingCode,
  });
  return async () => {
    mountedArtifacts.close();
    await Promise.all([
      bridge.close(),
      immediateBridge.close(),
      new Promise<void>((resolve, reject) => artifactServer.close(error => error === undefined ? resolve() : reject(error))),
    ]);
  };
}
