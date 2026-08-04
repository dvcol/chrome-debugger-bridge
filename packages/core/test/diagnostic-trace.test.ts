import { expect, it } from 'vitest';

import { createTargetBroker } from '../src/broker.js';
import { createDiagnosticTraceStore } from '../src/diagnostic-trace.js';

it('retains bounded failure traces without accepting target data or artifact bytes', () => {
  expect.assertions(5);
  let currentTime = Date.parse('2026-08-05T00:00:00.000Z');
  const diagnostics = createDiagnosticTraceStore(2, () => currentTime);
  const broker = createTargetBroker({ diagnostics });
  const targetId = '60000000-0000-4000-8000-000000000001';

  expect(() => broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.evaluate'], targetGeneration: 1, targetId })).toThrow('not available');
  currentTime += 1_000;
  expect(() => broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.evaluate'], targetGeneration: 1, targetId })).toThrow('not available');
  currentTime += 1_000;
  expect(() => broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.evaluate'], targetGeneration: 1, targetId })).toThrow('not available');
  expect(diagnostics.entries()).toEqual([
    { code: 'TARGET_NOT_FOUND', component: 'target-broker', occurredAt: '2026-08-05T00:00:01.000Z', sequence: 2 },
    { code: 'TARGET_NOT_FOUND', component: 'target-broker', occurredAt: '2026-08-05T00:00:02.000Z', sequence: 3 },
  ]);
  expect(JSON.stringify(diagnostics.entries())).not.toContain(targetId);
});
