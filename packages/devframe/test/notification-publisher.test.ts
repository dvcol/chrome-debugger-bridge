import type { BrokerState } from '@dvcol/cdb-broker/contract';

import { createBrowserControlNotificationController } from '@dvcol/cdb-extension/notifications';
import { expect, it, vi } from 'vitest';

import { publishBrowserControlNotifications } from '../src/notification-publisher.js';

async function notificationFixture(message = { dismiss: vi.fn(async () => {}), update: vi.fn(async (_patch: { description: string }) => {}) }, creation?: Promise<typeof message>) {
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  const controller = createBrowserControlNotificationController({ onReview: vi.fn(), onReject: vi.fn(async () => {}), onRevoke: vi.fn(async () => {}) });
  const info = vi.fn(async () => creation ?? message);
  const stopPublishing = publishBrowserControlNotifications(controller, { info });
  controller.update(state);
  await Promise.resolve();
  return {
    state,
    publish: (next: BrokerState) => controller.update(next),
    message,
    info,
    dispose() {
      stopPublishing();
      controller.dispose();
    },
  };
}

it('updates changed descriptions through the existing message without registering another command', async () => {
  expect.assertions(3);
  const fixture = await notificationFixture();
  try {
    fixture.publish({ ...fixture.state, revision: 2 });
    expect(fixture.message.update).not.toHaveBeenCalled();
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'Renamed agent' }] });
    await vi.waitUntil(() => fixture.message.update.mock.calls.length === 1);
    expect(fixture.message.update).toHaveBeenCalledWith({ description: 'Renamed agent requests interact access with same-origin navigation.' });
    expect(fixture.info).toHaveBeenCalledOnce();
  } finally {
    fixture.dispose();
  }
});

it('updates overlapping-grant tab counts without notifying unchanged publications', async () => {
  expect.assertions(3);
  const fixture = await notificationFixture();
  const grant = { id: 'grant', requestId: 'request', principalId: 'principal', principalLabel: 'Agent', providerId: 'provider', targetId: 'one', targetGeneration: 1, level: 'interact' as const, navigation: 'same-origin' as const, approvedOrigin: 'https://example.test', createdAt: 0, state: 'active' as const };
  try {
    fixture.publish({ ...fixture.state, requests: [], grants: [grant] });
    fixture.publish({ ...fixture.state, requests: [], grants: [grant, { ...grant, id: 'second', targetId: 'two' }] });
    await vi.waitUntil(() => fixture.message.update.mock.calls.length === 1);
    expect(fixture.message.update).toHaveBeenLastCalledWith({ description: 'Agent: interact access to 2 approved tabs.' });
    fixture.publish({ ...fixture.state, revision: 3, requests: [], grants: [grant, { ...grant, id: 'second', targetId: 'two' }] });
    await Promise.resolve();
    expect(fixture.message.update).toHaveBeenCalledOnce();
    expect(fixture.info).toHaveBeenCalledTimes(2);
  } finally {
    fixture.dispose();
  }
});

it('serializes updates and dismisses after a pending update without publishing queued stale data', async () => {
  expect.assertions(4);
  const pending = Promise.withResolvers<void>();
  const update = vi.fn(async (_patch: { description: string }) => pending.promise);
  const fixture = await notificationFixture({ update, dismiss: vi.fn(async () => {}) });
  try {
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'First' }] });
    await vi.waitUntil(() => update.mock.calls.length === 1);
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'Second' }] });
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    fixture.publish({ ...fixture.state, requests: [] });
    expect(fixture.message.dismiss).not.toHaveBeenCalled();
    pending.resolve();
    await vi.waitUntil(() => fixture.message.dismiss.mock.calls.length === 1);
    expect(update).toHaveBeenCalledOnce();
    expect(fixture.message.dismiss).toHaveBeenCalledOnce();
  } finally {
    pending.resolve();
    fixture.dispose();
  }
});

it.each(['expiry', 'disposal'] as const)('cleans up delayed message creation after %s', async (ending) => {
  expect.assertions(2);
  const message = { dismiss: vi.fn(async () => {}), update: vi.fn(async (_patch: { description: string }) => {}) };
  const creation = Promise.withResolvers<typeof message>();
  const fixture = await notificationFixture(message, creation.promise);
  try {
    if (ending === 'expiry') fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, expiresAt: 1 }] });
    else fixture.dispose();
    creation.resolve(message);
    await vi.waitUntil(() => message.dismiss.mock.calls.length === 1);
    expect(message.dismiss).toHaveBeenCalledOnce();
    expect(message.update).not.toHaveBeenCalled();
  } finally {
    fixture.dispose();
  }
});

it('reports structured update failures, continues updates, and still removes the message', async () => {
  expect.assertions(3);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  const message = { dismiss: vi.fn(async () => {}), update: vi.fn(async (_patch: { description: string }) => {}) };
  const failure = Object.assign(new Error('Host update failed'), { code: 'MESSAGE_UPDATE_FAILED', retryable: true, retryAfterMilliseconds: 100 });
  const report = vi.fn();
  const controller = createBrowserControlNotificationController({ onReview: vi.fn(), onReject: vi.fn(async () => {}), onRevoke: vi.fn(async () => {}) });
  const info = vi.fn(async () => message);
  const stopPublishing = publishBrowserControlNotifications(controller, { info }, 'review', report);
  controller.update(state);
  await Promise.resolve();
  message.update.mockRejectedValueOnce(failure);
  try {
    controller.update({ ...state, requests: [{ ...state.requests[0]!, principalLabel: 'First' }] });
    await vi.waitUntil(() => report.mock.calls.length === 1);
    controller.update({ ...state, requests: [{ ...state.requests[0]!, principalLabel: 'Second' }] });
    await vi.waitUntil(() => message.update.mock.calls.length === 2);
    expect(message.update).toHaveBeenLastCalledWith({ description: 'Second requests interact access with same-origin navigation.' });
    controller.update({ ...state, requests: [] });
    await vi.waitUntil(() => message.dismiss.mock.calls.length === 1);
    expect(message.dismiss).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({ code: 'MESSAGE_UPDATE_FAILED', message: 'Host update failed', retryable: true, retryAfterMilliseconds: 100 });
  } finally {
    stopPublishing();
    controller.dispose();
  }
});

it('finishes old updates and removal before recreating the same message after reconnect', async () => {
  expect.assertions(5);
  const pending = Promise.withResolvers<void>();
  const update = vi.fn(async (_patch: { description: string }) => pending.promise);
  const fixture = await notificationFixture({ update, dismiss: vi.fn(async () => {}) });
  const replacement = { dismiss: vi.fn(async () => {}), update: vi.fn(async () => {}) };
  try {
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'Changed' }] });
    await vi.waitUntil(() => update.mock.calls.length === 1);
    fixture.publish({ ...fixture.state, requests: [] });
    fixture.info.mockResolvedValueOnce(replacement);
    fixture.publish(fixture.state);
    await Promise.resolve();
    expect(fixture.info).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.waitUntil(() => fixture.info.mock.calls.length === 2);
    expect(fixture.message.dismiss).toHaveBeenCalledOnce();
    expect(fixture.message.dismiss.mock.invocationCallOrder[0]).toBeLessThan(fixture.info.mock.invocationCallOrder[1]!);
    expect(replacement.dismiss).not.toHaveBeenCalled();
    fixture.dispose();
    await vi.waitUntil(() => replacement.dismiss.mock.calls.length === 1);
    expect(replacement.dismiss).toHaveBeenCalledOnce();
  } finally {
    pending.resolve();
    fixture.dispose();
  }
});
