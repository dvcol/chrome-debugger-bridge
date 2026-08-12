import { createServer } from 'node:http';

import { createBirpcBridgeClient } from '@dvcol/cdb-birpc/client';
import { mountBirpcChromeDebuggerBridge } from '@dvcol/cdb-birpc/node';
import { createMemoryAgentAuthenticationAdapter, createStaticClientAuthenticationAdapter } from '@dvcol/chrome-debugger-bridge-websocket/testing';

const target = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
};

function createChannelPair() {
  const leftListeners = new Set();
  const rightListeners = new Set();
  const createChannel = (listeners, remoteListeners) => ({
    off(listener) {
      listeners.delete(listener);
    },
    on(listener) {
      listeners.add(listener);
    },
    post(message) {
      queueMicrotask(() => {
        for (const listener of remoteListeners) listener(structuredClone(message));
      });
    },
  });
  return [createChannel(leftListeners, rightListeners), createChannel(rightListeners, leftListeners)];
}

async function runSmoke() {
  const server = createServer();
  const [hostChannel, clientChannel] = createChannelPair();
  const bridge = mountBirpcChromeDebuggerBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({
      brokerId: 'a797a9c2-ad27-4ca1-87f7-5bf9f58f936d',
      pairingCode: '123456',
      pairingCodeExpiresAt: Date.now() + 60_000,
      principal: { id: 'ecb4e5c2-7597-4fea-9fec-a7f0b6c181d7', role: 'agent' },
    }),
    agentPath: '/birpc-agent',
    artifactLifetimeMilliseconds: 60_000,
    brokerId: 'a797a9c2-ad27-4ca1-87f7-5bf9f58f936d',
    channel: hostChannel,
    clientAuthentication: createStaticClientAuthenticationAdapter('Bearer birpc-client', { id: 'b4fd95e4-b7d4-43b2-b152-a86d07d0aad2', role: 'client' }),
    clientPath: '/birpc-client',
    maximumInlineResultBytes: 1,
    originPolicy: () => true,
    server,
  });
  const client = createBirpcBridgeClient(clientChannel);

  bridge.broker.publishTarget(target);
  bridge.broker.registerTargetExecutor(target, {
    async execute() {
      return { result: { type: 'string', value: 'Birpc packed example' } };
    },
  });

  try {
    const targets = await client.listTargets();
    if (targets[0]?.id !== target.id) throw new Error('Expected the published target through Birpc birpc.');
    const lease = await client.acquireLease({ durationMilliseconds: 30_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled', 'Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
    const subscription = await client.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
    bridge.broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' });
    const event = await subscription[Symbol.asyncIterator]().next();
    if (event.value?.method !== 'Runtime.consoleAPICalled') throw new Error('Expected the Birpc event stream.');
    const command = await client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '2f2d0d0e-fc67-4a55-80ce-c03d708f610f', parameters: { expression: 'document.title' }, targetGeneration: target.generation, targetId: target.id });
    if (command.value === undefined || !('artifact' in command.value)) throw new Error('Expected a bounded artifact result.');
    const artifact = await client.readArtifact({ artifactId: command.value.artifact.id, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id });
    if (!(artifact instanceof Uint8Array)) throw new Error('Expected authorized artifact bytes.');
    subscription.close();
    await client.releaseLease({ leaseId: lease.id, targetGeneration: target.generation, targetId: target.id });
  } finally {
    client.dispose();
    await bridge.dispose();
  }

  if (server.listenerCount('upgrade') !== 0) throw new Error('Expected complete Birpc disposal.');
}

void runSmoke();
