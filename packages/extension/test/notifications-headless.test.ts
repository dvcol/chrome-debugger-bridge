import { expect, it, vi } from 'vitest';

import { createBrowserControlNotificationController } from '../src/notifications.js';

it('runs without a document, window or theme listeners', () => {
  expect.assertions(2);
  vi.stubGlobal('window', undefined);
  vi.stubGlobal('document', undefined);
  const subscribe = vi.fn();
  const controller = createBrowserControlNotificationController({ onReview: async () => {}, onReject: async () => {}, onRevoke: async () => {} });
  const unsubscribe = controller.subscribe(subscribe);
  controller.update({ requests: [], grants: [] });
  expect(controller.snapshot()).toEqual({ requests: [], grants: [] });
  expect(subscribe).toHaveBeenCalled();
  unsubscribe();
  controller.dispose();
  vi.unstubAllGlobals();
});
