import type { BrokerToClientMessage, ClientToBrokerMessage, PublishedTarget } from '@dvcol/cdb/protocol';

import type { NodeClientConnection, StandaloneChromeDebuggerBridgeHost } from '../src/node.js';

import { afterEach, expect, it } from 'vitest';

import {
  connectNodeClientWebSocket,
  createStandaloneChromeDebuggerBridgeHost,
} from '../src/node.js';

const hosts: StandaloneChromeDebuggerBridgeHost[] = [];
const target = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: '60000000-0000-4000-8000-000000000001',
  scopeId: '40000000-0000-4000-8000-000000000001',
  title: 'Standalone target',
  type: 'page',
  url: 'https://example.com/',
} satisfies PublishedTarget;

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async host => host.dispose()));
});

async function receiveResponse(connection: NodeClientConnection, requestId: string): Promise<Extract<BrokerToClientMessage, { readonly kind: 'response' }>> {
  return new Promise((resolve, reject) => {
    const removeListener = connection.onMessage((message) => {
      if (message.kind === 'error' && message.requestId === requestId) {
        removeListener();
        reject(new Error(message.error.code));
      } else if (message.kind === 'response' && message.requestId === requestId) {
        removeListener();
        resolve(message);
      }
    });
  });
}

function getArtifactId(message: Extract<BrokerToClientMessage, { readonly kind: 'response' }>): string {
  if (message.method !== 'cdp.send' || !('artifact' in message.result.value)) throw new Error('Expected an artifact response.');
  const artifact = message.result.value.artifact;
  if (typeof artifact !== 'object' || artifact === null || !('id' in artifact) || typeof artifact.id !== 'string') {
    throw new Error('Expected a valid artifact descriptor.');
  }
  return artifact.id;
}

async function request(
  connection: NodeClientConnection,
  message: ClientToBrokerMessage,
): Promise<Extract<BrokerToClientMessage, { readonly kind: 'response' }>> {
  if (message.kind !== 'request') throw new Error('Expected a client request.');
  const response = receiveResponse(connection, message.requestId);
  await connection.send(message);
  return response;
}

it('starts explicit loopback endpoints, mediates command artifacts, and disposes them', async () => {
  expect.assertions(8);
  let pairingPresentation: { readonly agentEndpoint: string; readonly code: string } | undefined;
  const host = await createStandaloneChromeDebuggerBridgeHost({
    clientAuthentication: { async authenticate(input) {
      return input.authorization === 'Bearer client-token' ? { id: 'client-1', role: 'client' as const } : undefined;
    } },
    maximumInlineResultBytes: 1,
    onPairingPresentation(presentation) {
      pairingPresentation = presentation;
    },
  });
  hosts.push(host);
  host.broker.publishTarget(target);
  host.broker.registerTargetExecutor(target, { async execute() {
    return { response: 'Artifact content from standalone host' };
  } });

  const connection = await connectNodeClientWebSocket({ authorization: 'Bearer client-token', endpoint: host.clientEndpoint });
  const leaseResponse = await request(connection, {
    kind: 'request',
    method: 'leases.acquire',
    parameters: { durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id },
    protocolVersion: 1,
    requestId: '10000000-0000-4000-8000-000000000001',
  });
  if (leaseResponse.method !== 'leases.acquire') throw new Error('Expected a lease response.');
  const commandResponse = await request(connection, {
    kind: 'request',
    method: 'cdp.send',
    parameters: {
      leaseId: leaseResponse.result.lease.id,
      method: 'Runtime.evaluate',
      operationId: '10000000-0000-4000-8000-000000000002',
      parameters: { expression: '1 + 1' },
      targetGeneration: target.generation,
      targetId: target.id,
    },
    protocolVersion: 1,
    requestId: '10000000-0000-4000-8000-000000000003',
  });
  const artifactId = getArtifactId(commandResponse);
  const response = await fetch(`${host.artifactEndpoint}${encodeURIComponent(artifactId)}`, { headers: { authorization: 'Bearer client-token' } });
  const disposed = host.dispose();
  await disposed;

  expect(host.agentEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/u);
  expect(host.clientEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/u);
  expect(host.artifactEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:/u);
  expect(pairingPresentation?.agentEndpoint).toBe(host.agentEndpoint);
  expect(pairingPresentation?.code).toMatch(/^\d{6}$/u);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Artifact content');
  await expect(fetch(host.artifactEndpoint)).rejects.toThrow();
  connection.close();
});
