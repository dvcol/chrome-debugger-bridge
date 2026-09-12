import type { BrokerRequest, BrokerState } from '@dvcol/cdb-broker/contract';

import { afterEach, expect, it, vi } from 'vitest';

import { createBrowserControlNotificationController } from '../src/notifications.js';

afterEach(() => {
  vi.useRealTimers();
});

const request: BrokerRequest = { id: 'request', principalId: 'principal', principalLabel: '<script>agent</script>', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: 2_000 };
const state: BrokerState = { revision: 1, providers: [], principals: [], requests: [request], grants: [], scopes: [], targets: [], leases: [] };

it('keeps dismissal local and expires requests without another broker update', async () => {
  expect.assertions(5);
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const review = vi.fn();
  const revoke = vi.fn();
  const controller = createBrowserControlNotificationController({ onReview: review, onRevoke: revoke });
  controller.update(state);
  await controller.review(request.id);
  expect(review).toHaveBeenCalledWith(request);
  controller.dismiss(request.id);
  expect(controller.snapshot().requests).toEqual([]);
  expect(revoke).not.toHaveBeenCalled();
  controller.update({ ...state, requests: [] });
  controller.update(state);
  expect(controller.snapshot().requests).toEqual([request]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(controller.snapshot().requests).toEqual([]);
  controller.dispose();
});
