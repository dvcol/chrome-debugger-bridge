import type { PublishedTarget } from '@dvcol/chrome-debugger-bridge/protocol';

import type { DevframeRpcChannel } from '../src/client.js';

import { createServer } from 'node:http';

import {
  createMemoryAgentAuthenticationAdapter,
  createStaticClientAuthenticationAdapter,
} from '@dvcol/chrome-debugger-bridge-websocket/testing';
import { artifactResultSchema } from '@dvcol/chrome-debugger-bridge/protocol';
import { expect, it } from 'vitest';

import { createDevframeBridgeClient } from '../src/client.js';
import { mountDevframeChromeDebuggerBridge } from '../src/node.js';

const target = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
} satisfies PublishedTarget;

function createChannelPair(): readonly [DevframeRpcChannel, DevframeRpcChannel] {
  const leftListeners = new Set<(message: unknown) => void>();
  const rightListeners = new Set<(message: unknown) => void>();
  const createChannel = (
    listeners: Set<(message: unknown) => void>,
    remoteListeners: Set<(message: unknown) => void>,
  ): DevframeRpcChannel => ({
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

it('maps the shared client facade through a Devframe birpc channel without owning the HTTP listener', async () => {
  expect.assertions(15);
  const server = createServer();
  const [hostChannel, clientChannel] = createChannelPair();
  const bridge = mountDevframeChromeDebuggerBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({
      brokerId: 'a797a9c2-ad27-4ca1-87f7-5bf9f58f936d',
      pairingCode: '123456',
      pairingCodeExpiresAt: Date.now() + 60_000,
      principal: { id: 'ecb4e5c2-7597-4fea-9fec-a7f0b6c181d7', role: 'agent' },
    }),
    agentPath: '/devframe-agent',
    artifactLifetimeMilliseconds: 60_000,
    brokerId: 'a797a9c2-ad27-4ca1-87f7-5bf9f58f936d',
    channel: hostChannel,
    clientAuthentication: createStaticClientAuthenticationAdapter('Bearer devframe-client', { id: 'b4fd95e4-b7d4-43b2-b152-a86d07d0aad2', role: 'client' }),
    clientPath: '/devframe-client',
    maximumInlineResultBytes: 1,
    originPolicy() {
      return true;
    },
    server,
  });
  const client = createDevframeBridgeClient(clientChannel);
  let resolveStarted: (() => void) | undefined;
  const commandStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  bridge.broker.publishTarget(target);
  bridge.broker.registerTargetExecutor(target, {
    async execute(command, abortSignal) {
      if (command.parameters?.expression !== 'wait') return { result: { type: 'string', value: 'Devframe bridge' } };
      resolveStarted?.();
      return new Promise<never>((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error('Cancelled by Devframe client.')), { once: true });
      });
    },
  });

  try {
    expect(server.listening).toBe(false);
    expect(server.listenerCount('upgrade')).toBe(1);
    const targetIterator = client.watchTargets()[Symbol.asyncIterator]();
    expect(await targetIterator.next()).toEqual({ done: false, value: { kind: 'snapshot', sequence: 1, targets: [target] } });
    expect((await client.listTargets())[0]?.id).toBe(target.id);
    const lease = await client.acquireLease({ durationMilliseconds: 30_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled', 'Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
    expect(lease.targetId).toBe(target.id);
    expect((await client.renewLease({ durationMilliseconds: 30_000, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id })).id).toBe(lease.id);
    const subscription = await client.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
    expect(client.diagnostics()).toEqual({ disposed: false, subscriptionCount: 1, watchingTargets: true });
    expect(bridge.diagnostics()).toEqual({ disposed: false, ownsBroker: true, subscriptionCount: 1, watchingTargets: true });
    bridge.broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' });
    expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({ done: false, value: { method: 'Runtime.consoleAPICalled', targetId: target.id } });
    const result = await client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '2f2d0d0e-fc67-4a55-80ce-c03d708f610f', parameters: { expression: 'artifact' }, targetGeneration: target.generation, targetId: target.id });
    const artifactValidation = await artifactResultSchema['~standard'].validate(result.value);
    if ('issues' in artifactValidation) throw new Error('Expected the small inline limit to create an artifact.');
    expect(artifactValidation.value.artifact.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await client.readArtifact({ artifactId: artifactValidation.value.artifact.id, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id })).toBeInstanceOf(Uint8Array);
    const pendingCommand = client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '109b92c9-3499-4dbe-8e4a-e2a20d61a799', parameters: { expression: 'wait' }, targetGeneration: target.generation, targetId: target.id });
    await commandStarted;
    await client.cancelCommand({ operationId: '109b92c9-3499-4dbe-8e4a-e2a20d61a799', targetGeneration: target.generation, targetId: target.id });
    await expect(pendingCommand).rejects.toThrow();
    subscription.close();
    await client.releaseLease({ leaseId: lease.id, targetGeneration: target.generation, targetId: target.id });
  } finally {
    client.dispose();
    await bridge.dispose();
  }

  expect(server.listening).toBe(false);
  expect(server.listenerCount('upgrade')).toBe(0);
  expect(bridge.diagnostics()).toEqual({ disposed: true, ownsBroker: true, subscriptionCount: 0, watchingTargets: false });
});

it('releases Devframe routes and streams across repeated host mount cycles', async () => {
  expect.assertions(5);
  const server = createServer();
  const [firstHostChannel, firstClientChannel] = createChannelPair();
  const createBridge = (channel: DevframeRpcChannel) => mountDevframeChromeDebuggerBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({
      brokerId: 'ad0ea525-155e-47b7-a218-4a4b2c91d1e0',
      pairingCode: '123456',
      pairingCodeExpiresAt: Date.now() + 60_000,
      principal: { id: 'c206d4c0-5650-42bb-a60c-054673446442', role: 'agent' },
    }),
    agentPath: '/devframe-agent',
    brokerId: 'ad0ea525-155e-47b7-a218-4a4b2c91d1e0',
    channel,
    clientAuthentication: createStaticClientAuthenticationAdapter('Bearer devframe-client', { id: 'ccc243ef-b45a-4c1b-8877-8da4ca3b4dc4', role: 'client' }),
    clientPath: '/devframe-client',
    originPolicy() {
      return true;
    },
    server,
  });
  const firstBridge = createBridge(firstHostChannel);
  const firstClient = createDevframeBridgeClient(firstClientChannel);
  const targetIterator = firstClient.watchTargets()[Symbol.asyncIterator]();

  try {
    expect(server.listenerCount('upgrade')).toBe(1);
    firstClient.dispose();
    expect(await targetIterator.next()).toEqual({ done: true, value: undefined });
    await firstBridge.dispose();
    expect(server.listenerCount('upgrade')).toBe(0);

    const [secondHostChannel, secondClientChannel] = createChannelPair();
    const secondBridge = createBridge(secondHostChannel);
    const secondClient = createDevframeBridgeClient(secondClientChannel);
    expect(server.listenerCount('upgrade')).toBe(1);
    secondClient.dispose();
    await secondBridge.dispose();
    expect(server.listenerCount('upgrade')).toBe(0);
  } finally {
    firstClient.dispose();
    await firstBridge.dispose();
  }
});
