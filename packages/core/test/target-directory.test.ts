import type { CdpCommand, PublishedTarget } from '../src/protocol.js';

import { expect, it, vi } from 'vitest';

import { createTargetBroker } from '../src/broker.js';
import { createChromeDebuggerBridgeClient } from '../src/client.js';

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
