// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { createPageRequestBridge } from '../src/page-request.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('matches source, origin, response type and correlation before delivering an acknowledgement', async () => {
  expect.assertions(3);
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const remove = vi.spyOn(window, 'removeEventListener');
  const bridge = createPageRequestBridge({ receiver: window, target: window, targetOrigin: 'https://example.test', correlationKey: 'correlation' });
  const response = bridge.request('approve', 'approved', { requestId: 'grant-request' });
  const sent = post.mock.calls[0]![0] as { payload: Record<string, unknown> };
  let resolved = false;
  void response.then(() => {
    resolved = true;
  });
  const payload = { ...sent.payload, acknowledged: false };
  const deliver = (source: Window | null, origin: string, type: string, reply: Readonly<Record<string, unknown>> = payload): void => {
    window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type, payload: reply } }));
  };
  deliver(null, 'https://example.test', 'approved');
  deliver(window, 'https://other.test', 'approved');
  deliver(window, 'https://example.test', 'wrong');
  deliver(window, 'https://example.test', 'approved', { ...payload, correlation: 'wrong' });
  await Promise.resolve();
  expect(resolved).toBe(false);
  deliver(window, 'https://example.test', 'approved');
  await expect(response).resolves.toEqual(payload);
  expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
  bridge.dispose();
});

it('cleans up on deadline, cancellation and disposal without affecting other requests', async () => {
  expect.assertions(6);
  vi.useFakeTimers();
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const remove = vi.spyOn(window, 'removeEventListener');
  const bridge = createPageRequestBridge({ receiver: window, target: window, targetOrigin: '*', timeoutMilliseconds: 100 });
  const controller = new AbortController();
  const cancelled = bridge.request('one', 'response', {}, { signal: controller.signal });
  const timedOut = bridge.request('two', 'response');
  const cancelledAssertion = expect(cancelled).rejects.toThrow('Cancelled');
  controller.abort(new Error('Cancelled'));
  await cancelledAssertion;
  const timeoutAssertion = expect(timedOut).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(100);
  await timeoutAssertion;
  const disposed = bridge.request('three', 'response');
  const disposedAssertion = expect(disposed).rejects.toThrow('disposed');
  bridge.dispose();
  await disposedAssertion;
  await expect(bridge.request('four', 'response')).rejects.toThrow('disposed');
  expect(remove).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
