import type { PublishedTarget } from '@dvcol/chrome-debugger-bridge/protocol';

import { expect, it, vi } from 'vitest';

import { createBrokerTabAssignment } from '../src/broker-tab-assignment.js';

const tab = { incognito: false, tabId: 42, url: 'https://example.com/' };
const target = { availability: 'available', capabilities: { level: 'observe' as const }, generation: 1, id: '10000000-0000-4000-8000-000000000001', scopeId: '40000000-0000-4000-8000-000000000001', type: 'page' } satisfies PublishedTarget;

it('revokes the old broker before assigning a root tab to the next broker', async () => {
  expect.assertions(5);
  const calls: string[] = [];
  const firstBroker = { brokerId: 'first', async publish() {
    calls.push('first-publish');
    return target;
  }, async revoke() {
    calls.push('first-revoke');
  } };
  const secondBroker = { brokerId: 'second', async publish() {
    calls.push('second-publish');
    return target;
  }, async revoke() {
    calls.push('second-revoke');
  } };
  const assignments = createBrokerTabAssignment();
  await assignments.assign(firstBroker, tab);
  await assignments.assign(secondBroker, tab);

  expect(calls).toEqual(['first-publish', 'first-revoke', 'second-publish']);
  expect(calls.indexOf('first-revoke')).toBeLessThan(calls.indexOf('second-publish'));
  await assignments.revoke(tab.tabId);
  expect(calls).toEqual(['first-publish', 'first-revoke', 'second-publish', 'second-revoke']);
  expect(secondBroker.revoke).toBeDefined();
  expect(firstBroker.revoke).toBeDefined();
});

it('serializes concurrent reassignment attempts for the same root tab', async () => {
  expect.assertions(2);
  let finishFirstPublication: (() => void) | undefined;
  const firstPublication = new Promise<void>((resolve) => {
    finishFirstPublication = resolve;
  });
  const firstBroker = { brokerId: 'first', async publish() {
    await firstPublication;
    return target;
  }, revoke: vi.fn(async () => {}) };
  const secondBroker = { brokerId: 'second', publish: vi.fn(async () => target), revoke: vi.fn(async () => {}) };
  const assignments = createBrokerTabAssignment();
  const firstAssignment = assignments.assign(firstBroker, tab);
  const secondAssignment = assignments.assign(secondBroker, tab);
  await Promise.resolve();
  expect(secondBroker.publish).not.toHaveBeenCalled();
  finishFirstPublication?.();
  await Promise.all([firstAssignment, secondAssignment]);
  expect(secondBroker.publish).toHaveBeenCalledOnce();
});
