import type { AgentToBrokerMessage, CdpCommand, PublishedTarget } from '../src/protocol.js';

import { expect, it, vi } from 'vitest';

import { createTargetBroker } from '../src/broker.js';
import { createChromeDebuggerBridgeClient } from '../src/client.js';
import { connectAgentTargetBroker } from '../src/index.js';

const target = {
  availability: 'available',
  capabilities: { methods: ['Runtime.evaluate'] },
  generation: 1,
  id: '60000000-0000-4000-8000-000000000001',
  scopeId: '40000000-0000-4000-8000-000000000001',
  title: 'Example target',
  type: 'page',
  url: 'https://example.com/',
} satisfies PublishedTarget;

it('lists only opaque targets published by the agent', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  const client = createChromeDebuggerBridgeClient(broker);

  broker.publishTarget(target);
  const targets = await client.listTargets();
  broker.revokeTarget(target.id, target.generation);

  expect(targets).toEqual([target]);
  expect(Object.keys(targets[0] ?? {})).not.toContain('tabId');
  expect(await client.listTargets()).toEqual([]);
});

it('orders target changes and starts every watcher from a fresh snapshot', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  const watcher = broker.watchTargets()[Symbol.asyncIterator]();
  broker.publishTarget(target);
  broker.updateTarget({ ...target, title: 'Changed title' });
  broker.revokeTarget(target.id, target.generation, 'closed');

  expect(await watcher.next()).toEqual({ done: false, value: { kind: 'snapshot', sequence: 0, targets: [] } });
  expect(await watcher.next()).toMatchObject({ done: false, value: { kind: 'published', sequence: 1, target } });
  expect(await watcher.next()).toMatchObject({ done: false, value: { kind: 'updated', sequence: 2, target: { title: 'Changed title' } } });
  expect(await watcher.next()).toEqual({ done: false, value: { kind: 'revoked', reason: 'closed', sequence: 3, targetGeneration: 1, targetId: target.id } });
});

it('reconciles agent state without accepting a stale target generation', () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget({ ...target, generation: 2 });
  broker.reconcileTargets([{ ...target, generation: 3, title: 'Reconnected target' }]);

  expect(broker.listTargets()).toEqual([{ ...target, generation: 3, title: 'Reconnected target' }]);
  broker.revokeTarget(target.id, 3);
  expect(() => broker.reconcileTargets([target])).toThrowError('The requested target operation is not available.');
  expect(broker.listTargets()).toEqual([]);
});

it('applies authenticated agent lifecycle notifications to the broker', () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  const disconnect = connectAgentTargetBroker({ onMessage(receivedListener) {
    listener = receivedListener;
    return () => listener = undefined;
  } }, broker);

  listener?.({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
  expect(broker.listTargets()).toEqual([target]);
  listener?.({ kind: 'notification', method: 'targets.reconcile', parameters: { targets: [] }, protocolVersion: 1 });
  expect(broker.listTargets()).toEqual([]);
  disconnect();
});

it('executes only a non-expired lease grant through the registered opaque target executor', async () => {
  expect.assertions(6);
  let currentTime = Date.parse('2026-08-04T12:00:00.000Z');
  const broker = createTargetBroker({ now: () => currentTime });
  const client = createChromeDebuggerBridgeClient(broker);
  broker.publishTarget(target);
  const execute = vi.fn(async (command: CdpCommand) => ({ expression: command.parameters?.expression ?? '' }));
  broker.registerTargetExecutor(target, { execute });
  const lease = await client.acquireLease({
    durationMilliseconds: 1_000,
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const result = await client.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000001',
    parameters: { expression: 'document.title' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  currentTime += 1_000;

  expect(result).toEqual({ operationId: '30000000-0000-4000-8000-000000000001', value: { expression: 'document.title' } });
  expect(execute).toHaveBeenCalledOnce();
  await expect(client.acquireLease({
    durationMilliseconds: 1,
    requestedMethods: ['Page.navigate'],
    targetGeneration: target.generation,
    targetId: target.id,
  })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  await expect(client.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000002',
    targetGeneration: target.generation,
    targetId: target.id,
  })).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
  await expect(client.executeCommand({
    leaseId: globalThis.crypto.randomUUID(),
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000003',
    targetGeneration: target.generation,
    targetId: target.id,
  })).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  expect(Object.keys(result.value)).not.toContain('tabId');
});

it('cancels a pending command and disposes its eventual response', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  let resolveCommand: ((value: { readonly result: string }) => void) | undefined;
  broker.registerTargetExecutor(target, {
    async execute() {
      return new Promise(resolve => resolveCommand = resolve);
    },
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const operationId = '30000000-0000-4000-8000-000000000004';
  const command = broker.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId,
    targetGeneration: target.generation,
    targetId: target.id,
  });

  broker.cancelCommand(operationId);
  resolveCommand?.({ result: 'late response' });

  await expect(command).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  expect(resolveCommand).toBeDefined();
  expect(broker.listTargets()).toEqual([target]);
});

it('delivers bounded matching events with opaque sequence numbers and closes on revocation', async () => {
  expect.assertions(5);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: [], targetGeneration: target.generation, targetId: target.id });
  const subscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
    leaseId: lease.id,
    match: { methodPrefix: 'Runtime.' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' });
  broker.publishEvent(target, 'Network.requestWillBeSent', {});
  const iterator = subscription[Symbol.asyncIterator]();
  const event = await iterator.next();
  broker.revokeTarget(target.id, target.generation);

  expect(event).toMatchObject({ done: false, value: { method: 'Runtime.consoleAPICalled', sequence: 1, subscriptionId: subscription.id } });
  expect(event.done ? [] : Object.keys(event.value)).not.toContain('sessionId');
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(broker.listTargets()).toEqual([]);
  expect(subscription.id).toMatch(/^[0-9a-f-]{36}$/u);
});

it('reports overflow and retains the newest event for a drop-oldest subscription', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: [], targetGeneration: target.generation, targetId: target.id });
  const subscription = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { methodPrefix: 'Runtime.' }, targetGeneration: target.generation, targetId: target.id });
  broker.publishEvent(target, 'Runtime.first', {});
  broker.publishEvent(target, 'Runtime.second', {});
  const event = await subscription[Symbol.asyncIterator]().next();

  expect(subscription.overflowed).toBe(true);
  expect(event).toMatchObject({ done: false, value: { method: 'Runtime.second', sequence: 2 } });
  expect(Object.keys(event.done ? {} : event.value)).not.toContain('sessionId');
});

it('returns subscription demand to the extension executor when the client closes', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const setSubscriptionDemand = vi.fn(async () => {});
  broker.registerTargetExecutor(target, { async execute() {
    return {};
  }, setSubscriptionDemand });
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: [], targetGeneration: target.generation, targetId: target.id });
  const subscription = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'disconnect' }, leaseId: lease.id, match: { methodPrefix: 'Runtime.' }, targetGeneration: target.generation, targetId: target.id });
  subscription.close();

  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(1, 'Runtime.', true);
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(2, 'Runtime.', false);
});

it('rejects commands carrying the stale generation after a target is republished', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  broker.revokeTarget(target.id, target.generation);
  broker.publishTarget({ ...target, generation: 2 });

  await expect(broker.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000005', targetGeneration: target.generation, targetId: target.id })).rejects.toMatchObject({ code: 'TARGET_GENERATION_STALE' });
  expect(broker.listTargets()).toEqual([{ ...target, generation: 2 }]);
});

it('aborts an in-flight command when its target is revoked', async () => {
  expect.assertions(1);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, { async execute(_command, abortSignal) {
    return new Promise(resolve => abortSignal.addEventListener('abort', () => resolve({}), { once: true }));
  } });
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  const command = broker.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000006', targetGeneration: target.generation, targetId: target.id });
  broker.revokeTarget(target.id, target.generation);
  await expect(command).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
});
