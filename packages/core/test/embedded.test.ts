import type { ArtifactStore } from '../src/artifact-store.js';
import type { PublishedTarget } from '../src/protocol.js';

import { expect, it, vi } from 'vitest';

import { createMemoryArtifactStore } from '../src/artifact-store.js';
import { createDiagnosticTraceStore } from '../src/diagnostic-trace.js';
import { createEmbeddedChromeDebuggerBridge } from '../src/embedded.js';
import { artifactResultSchema } from '../src/protocol.js';

const target = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: '60000000-0000-4000-8000-000000000001',
  scopeId: '40000000-0000-4000-8000-000000000001',
  title: 'Embedded target',
  type: 'page',
  url: 'https://example.com/',
} satisfies PublishedTarget;

it('composes custom host adapters across an in-memory client boundary', async () => {
  expect.assertions(11);
  let currentTime = Date.parse('2026-08-05T00:00:00.000Z');
  const backingStore = createMemoryArtifactStore(100, () => currentTime);
  const artifactStore: ArtifactStore = {
    ...backingStore,
    create: vi.fn(backingStore.create),
  };
  const diagnostics = createDiagnosticTraceStore(2, () => currentTime);
  const authorization = { authorize: vi.fn(async () => true) };
  const bridge = createEmbeddedChromeDebuggerBridge({
    artifactStore,
    authorization,
    diagnostics,
    generateId: vi.fn()
      .mockReturnValueOnce('70000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('70000000-0000-4000-8000-000000000002'),
    maximumInlineResultBytes: 1,
    now: () => currentTime,
  });
  bridge.broker.publishTarget(target);
  bridge.registerTargetExecutor(target, { execute: vi.fn(async () => ({ value: 'large result' })) });

  const targets = await bridge.client.listTargets();
  targets[0]!.title = 'Mutated by the host';
  const lease = await bridge.client.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  const result = await bridge.client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000001', targetGeneration: target.generation, targetId: target.id });
  const artifactResult = await artifactResultSchema['~standard'].validate(result.value);

  expect(await bridge.client.listTargets()).toMatchObject([{ title: 'Embedded target' }]);
  expect(lease.id).toBe('70000000-0000-4000-8000-000000000001');
  expect(authorization.authorize).toHaveBeenCalledWith(expect.objectContaining({ targetId: target.id }), expect.objectContaining({ id: lease.id }));
  expect(artifactResult).toHaveProperty('value.artifact.id');
  if ('issues' in artifactResult) throw new Error('Expected an artifact result.');
  expect(await bridge.client.readArtifact({ artifactId: artifactResult.value.artifact.id, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id })).toEqual(new TextEncoder().encode(JSON.stringify({ value: 'large result' })));
  expect(artifactStore.create).toHaveBeenCalledTimes(1);
  expect(diagnostics.entries()).toEqual([]);
  expect(currentTime).toBe(Date.parse('2026-08-05T00:00:00.000Z'));
  currentTime += 1_001;
  await expect(bridge.client.readArtifact({ artifactId: artifactResult.value.artifact.id, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id })).rejects.toThrow('not available');
  expect(diagnostics.entries()).toEqual([]);
  bridge.dispose();
  expect(() => bridge.broker.listTargets()).toThrow('disposed');
});

it('cleans pending operations and async iterators when the host disposes the embedded bridge', async () => {
  expect.assertions(5);
  const bridge = createEmbeddedChromeDebuggerBridge();
  bridge.broker.publishTarget(target);
  const pendingExecutor = vi.fn(async (_command, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  bridge.registerTargetExecutor(target, { execute: pendingExecutor });
  const watcher = bridge.client.watchTargets()[Symbol.asyncIterator]();
  expect(await watcher.next()).toMatchObject({ value: { kind: 'snapshot' } });
  const pendingWatch = watcher.next();
  const lease = await bridge.client.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  const pendingCommand = bridge.client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000002', targetGeneration: target.generation, targetId: target.id });
  await Promise.resolve();

  bridge.dispose();

  await expect(pendingWatch).resolves.toEqual({ done: true, value: undefined });
  await expect(pendingCommand).rejects.toThrow('disposed');
  expect(pendingExecutor).toHaveBeenCalledTimes(1);
  await expect(bridge.client.listTargets()).rejects.toThrow('disposed');
});
