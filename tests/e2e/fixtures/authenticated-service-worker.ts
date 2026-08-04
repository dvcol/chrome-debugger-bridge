import type { AgentToBrokerMessage, BrokerToAgentMessage } from '../../../packages/core/src/protocol.js';

import { createIndexedDbPairingStore } from '../../../packages/extension/src/index.js';
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
}

const bridgeTestGlobal = globalThis as typeof globalThis & BridgeTestGlobal;

bridgeTestGlobal.runAuthenticatedBridgeTest = async (input) => {
  const connection = await connectAgentWebSocket({
    credentialStore: createIndexedDbPairingStore({ databaseName: 'mv3-service-worker-test' }),
    endpoint: input.endpoint,
    async requestPairingCode() {
      return input.pairingCode;
    },
  });
  const response = new Promise<BrokerToAgentMessage>((resolve) => {
    const removeListener = connection.onMessage((message) => {
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
  await connection.send(hello);
  const message = await response;
  connection.close(1000, 'MV3 test complete');
  await connection.closed;
  return {
    brokerId: connection.brokerId,
    connectionId: connection.connectionId,
    responseKind: message.kind,
    responseMethod: message.method,
  };
};
