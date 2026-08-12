import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createBrowserChromeDebuggerBridgeClient } from '@dvcol/cdb-websocket/browser';
import {
  connectNodeClientWebSocket,
  createStandaloneAuthenticatedWebSocketBridge,
  mountAuthenticatedArtifactHttpEndpoint,
} from '@dvcol/cdb-websocket/node';
import {
  createMemoryAgentAuthenticationAdapter,
  createStaticClientAuthenticationAdapter,
} from '@dvcol/cdb-websocket/testing';
import protocolJsonSchema from '@dvcol/cdb/protocol.schema.json' with { type: 'json' };

const disconnectedErrorPattern = /disconnected/u;

async function main() {
  assert.equal(protocolJsonSchema.$id, 'urn:dvcol:chrome-debugger-bridge:protocol:1');
  assert.equal(protocolJsonSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const authorization = 'Bearer packed-example-client';
  const target = {
    availability: 'available',
    capabilities: { allow: ['Runtime.evaluate', 'Runtime.consoleAPICalled'] },
    generation: 1,
    id: crypto.randomUUID(),
    scopeId: crypto.randomUUID(),
    type: 'page',
  };
  const artifactId = crypto.randomUUID();
  const artifactBytes = new TextEncoder().encode('packed generic artifact');

  function response(connection, message, method, result) {
    return connection.send({ kind: 'response', method, protocolVersion: 1, requestId: message.requestId, result });
  }

  function waitForMessage(connection, predicate) {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timed out waiting for a generic client message.'));
      }, 2_000);
      unsubscribe = connection.onMessage((message) => {
        if (!predicate(message)) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(message);
      });
    });
  }

  const brokerId = crypto.randomUUID();
  const bridge = await createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({
      brokerId,
      pairingCode: '123456',
      pairingCodeExpiresAt: Date.now() + 60_000,
      principal: { id: crypto.randomUUID(), role: 'agent' },
    }),
    brokerId,
    clientAuthentication: createStaticClientAuthenticationAdapter(authorization, { id: crypto.randomUUID(), role: 'client' }),
    onAgentConnection() {},
    onClientConnection({ connection }) {
      void connection.send({ kind: 'notification', method: 'targets.snapshot', parameters: { sequence: 0, targets: [target] }, protocolVersion: 1 });
      connection.onMessage((message) => {
        if (message.kind !== 'request') return;
        void (async () => {
          if (message.method === 'targets.list') {
            await response(connection, message, 'targets.list', { targets: [target] });
          } else if (message.method === 'leases.acquire' || message.method === 'leases.renew') {
            await response(connection, message, message.method, {
              lease: {
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                id: crypto.randomUUID(),
                issuedAt: new Date().toISOString(),
                methods: ['Runtime.evaluate', 'Runtime.consoleAPICalled'],
                mode: 'shared-read',
                targetGeneration: target.generation,
                targetId: target.id,
              },
            });
          } else if (message.method === 'cdp.subscribe') {
            const subscriptionId = crypto.randomUUID();
            await response(connection, message, 'cdp.subscribe', { subscriptionId });
            await connection.send({
              kind: 'notification',
              method: 'cdp.event',
              parameters: { method: 'Runtime.consoleAPICalled', parameters: {}, sequence: 1, subscriptionId, targetGeneration: target.generation, targetId: target.id },
              protocolVersion: 1,
            });
          } else if (message.method === 'cdp.send' && message.parameters.parameters?.expression === 'disconnect') {
            connection.close(1012, 'Packed browser reconnect test');
          } else if (message.method === 'cdp.send') {
            await response(connection, message, 'cdp.send', { operationId: message.parameters.operationId, value: { result: { type: 'string', value: 'packed generic client' } } });
          } else {
            await response(connection, message, message.method, {});
          }
        })().catch(error => connection.close(1011, error instanceof Error ? error.message : 'Responder failure'));
      });
    },
    originPolicy() {
      return true;
    },
  });

  const artifactServer = createServer();
  const mountedArtifacts = mountAuthenticatedArtifactHttpEndpoint({
    authenticate: createStaticClientAuthenticationAdapter(authorization, { id: crypto.randomUUID(), role: 'client' }),
    async originPolicy() {
      return true;
    },
    async readArtifact(requestedArtifactId) {
      return requestedArtifactId === artifactId
        ? { bytes: artifactBytes, descriptor: { expiresAt: new Date(Date.now() + 60_000).toISOString(), id: artifactId, length: artifactBytes.byteLength, mediaType: 'text/plain' } }
        : undefined;
    },
    server: artifactServer,
  });

  await new Promise((resolve, reject) => artifactServer.listen(0, '127.0.0.1', error => error === undefined ? resolve() : reject(error)));
  const artifactAddress = artifactServer.address();
  if (artifactAddress === null || typeof artifactAddress === 'string') throw new Error('Artifact server did not expose a TCP port.');
  const clientEndpoint = `ws://${bridge.host}:${bridge.port}/cdb/client`;
  const artifactEndpoint = `http://127.0.0.1:${artifactAddress.port}/cdb/artifacts/`;

  try {
    const browserClient = await createBrowserChromeDebuggerBridgeClient({ artifactEndpoint, authorization, endpoint: clientEndpoint, reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 5 } });
    const [publishedTarget] = await browserClient.listTargets();
    assert.equal(publishedTarget?.id, target.id);
    const lease = await browserClient.acquireLease({ durationMilliseconds: 30_000, requestedMethods: ['Runtime.evaluate', 'Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
    const subscription = await browserClient.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
    assert.equal((await subscription[Symbol.asyncIterator]().next()).value.method, 'Runtime.consoleAPICalled');
    assert.deepEqual(await browserClient.readArtifact({ artifactId, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id }), artifactBytes);
    await browserClient.cancelCommand({ operationId: crypto.randomUUID(), targetGeneration: target.generation, targetId: target.id });
    await assert.rejects(browserClient.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: crypto.randomUUID(), parameters: { expression: 'disconnect' }, targetGeneration: target.generation, targetId: target.id }), disconnectedErrorPattern);
    assert.equal((await browserClient.listTargets())[0]?.id, target.id);
    assert.equal((await subscription[Symbol.asyncIterator]().next()).value.method, 'Runtime.consoleAPICalled');
    browserClient.close();
    await browserClient.closed;

    const nodeConnection = await connectNodeClientWebSocket({ authorization, endpoint: clientEndpoint });
    const event = waitForMessage(nodeConnection, message => message.kind === 'notification' && message.method === 'cdp.event');
    const subscribeResponse = waitForMessage(nodeConnection, message => message.kind === 'response' && message.method === 'cdp.subscribe');
    await nodeConnection.send({ kind: 'request', method: 'cdp.subscribe', parameters: { buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: crypto.randomUUID(), match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
    await subscribeResponse;
    assert.equal((await event).method, 'cdp.event');
    const cancellation = waitForMessage(nodeConnection, message => message.kind === 'response' && message.method === 'cdp.cancel');
    await nodeConnection.send({ kind: 'request', method: 'cdp.cancel', parameters: { operationId: crypto.randomUUID(), targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
    await cancellation;
    const artifactResponse = await fetch(`${artifactEndpoint}${artifactId}`, { headers: { authorization } });
    assert.equal(artifactResponse.status, 200);
    assert.deepEqual(new Uint8Array(await artifactResponse.arrayBuffer()), artifactBytes);
    nodeConnection.close();
  } finally {
    mountedArtifacts.close();
    await Promise.all([
      bridge.close(),
      new Promise((resolve, reject) => artifactServer.close(error => error === undefined ? resolve() : reject(error))),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
