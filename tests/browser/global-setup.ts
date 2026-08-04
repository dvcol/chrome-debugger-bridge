import type { TestProject } from 'vitest/node';

import type { AgentToBrokerMessage, BrokerToAgentMessage } from '../../packages/core/src/protocol.js';

import { createStandaloneAuthenticatedWebSocketBridge } from '../../packages/websocket/src/node.js';
import {
  createMemoryAgentAuthenticationAdapter,
  createStaticClientAuthenticationAdapter,
} from '../../packages/websocket/src/testing.js';

export interface WebSocketBrowserTestContext {
  readonly agentEndpoint: string;
  readonly brokerId: string;
  readonly immediateAgentEndpoint: string;
  readonly immediateBrokerId: string;
  readonly immediatePairingCode: string;
  readonly pairingCode: string;
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
    onClientConnection() {},
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
  project.provide('websocketBrowserTest', {
    agentEndpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    brokerId,
    immediateAgentEndpoint: `ws://${immediateBridge.host}:${immediateBridge.port}/__chrome_debugger_bridge/agent`,
    immediateBrokerId,
    immediatePairingCode,
    pairingCode,
  });
  return async () => {
    await Promise.all([bridge.close(), immediateBridge.close()]);
  };
}
