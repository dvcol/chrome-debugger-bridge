import type { BrokerRequest, BrokerState } from '@dvcol/cdb-broker/contract';

import { afterEach, expect, it, vi } from 'vitest';

import { createBrowserControlNotificationController } from '../src/notifications.js';

afterEach(() => {
  vi.useRealTimers();
});

const request: BrokerRequest = { id: 'request', principalId: 'principal', principalLabel: '<script>agent</script>', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: 2_000 };
const state: BrokerState = { revision: 1, providers: [], principals: [], requests: [request], grants: [], scopes: [], targets: [], leases: [] };

it('keeps dismissal local and expires requests without another broker update', async () => {
  expect.assertions(7);
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const review = vi.fn();
  const reject = vi.fn();
  const revoke = vi.fn();
  const controller = createBrowserControlNotificationController({ onReview: review, onReject: reject, onRevoke: revoke });
  controller.update(state);
  await controller.review(request.id);
  expect(review).toHaveBeenCalledWith(request);
  controller.dismiss(request.id);
  expect(controller.snapshot().requests).toEqual([]);
  controller.update({ ...state, requests: [{ ...request, principalLabel: 'Updated agent' }] });
  expect(controller.snapshot().requests).toEqual([]);
  expect(reject).not.toHaveBeenCalled();
  expect(revoke).not.toHaveBeenCalled();
  controller.update({ ...state, requests: [] });
  controller.update(state);
  expect(controller.snapshot().requests).toEqual([request]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(controller.snapshot().requests).toEqual([]);
  controller.dispose();
});

it('rejects a pending request authoritatively, distinct from local dismissal', async () => {
  expect.assertions(3);
  const pendingRequest = { ...request, expiresAt: null };
  const pendingState = { ...state, requests: [pendingRequest] };
  const reject = vi.fn(async () => {});
  const controller = createBrowserControlNotificationController({ onReview: vi.fn(), onReject: reject, onRevoke: vi.fn() });
  controller.update(pendingState);
  await controller.reject(pendingRequest.id);
  expect(reject).toHaveBeenCalledWith(pendingRequest.id);
  controller.update({ ...pendingState, requests: [] });
  await expect(controller.reject(pendingRequest.id)).rejects.toThrow('no longer pending');
  expect(reject).toHaveBeenCalledOnce();
  controller.dispose();
});
