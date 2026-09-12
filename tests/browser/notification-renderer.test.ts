import type { BrokerRequest, BrokerState } from '@dvcol/cdb-broker/contract';

import { afterEach, expect, it, vi } from 'vitest';

import { createBrowserControlNotificationController, renderBrowserControlNotifications } from '../../packages/extension/src/notifications.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const request: BrokerRequest = { id: 'request', principalId: 'principal', principalLabel: '<script>agent</script>', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: 2_000 };
const state: BrokerState = { revision: 1, providers: [], principals: [], requests: [request], grants: [], scopes: [], targets: [], leases: [] };

it.each(['Review request', 'Accept INTERACT'])('renders untrusted labels as text and delegates "%s" to the embedding application', async (label) => {
  expect.assertions(4);
  const review = vi.fn();
  const controller = createBrowserControlNotificationController({ onReview: review, onRevoke: async () => {} });
  controller.update({ ...state, requests: [{ ...request, expiresAt: null }] });
  const renderer = renderBrowserControlNotifications({ controller, container: document.body, branding: { title: 'Browser access' }, ...(label === 'Review request' ? {} : { reviewLabel: (request: BrokerRequest) => `Accept ${request.level.toUpperCase()}` }) });
  const root = document.querySelector('section')!.shadowRoot!;
  expect(root.querySelector('script')).toBeNull();
  expect(root.textContent).toContain(request.principalLabel);
  [...root.querySelectorAll('button')].find(button => button.textContent === label)!.click();
  await vi.waitUntil(() => review.mock.calls.length === 1);
  expect(review).toHaveBeenCalledOnce();
  renderer.dispose();
  expect(document.body.children).toHaveLength(0);
  controller.dispose();
});

it('preserves focused notification controls across equivalent broker publications', () => {
  expect.assertions(4);
  const controller = createBrowserControlNotificationController({ onReview: async () => {}, onRevoke: async () => {} });
  const pendingRequest = { ...request, expiresAt: null };
  controller.update({ requests: [pendingRequest], grants: [] });
  const renderer = renderBrowserControlNotifications({ controller, container: document.body });
  const root = document.querySelector('section')!.shadowRoot!;
  const review = root.querySelectorAll('button')[1]!;
  review.focus();

  /** Transport publications contain fresh objects even when the pending request has not changed. */
  controller.update({ requests: [{ ...pendingRequest }], grants: [] });
  expect(root.querySelectorAll('button')[1]).toBe(review);
  expect(root.activeElement).toBe(review);

  controller.update({ requests: [{ ...pendingRequest, principalLabel: 'Updated client' }], grants: [] });
  expect(root.textContent).toContain('Updated client');
  controller.update({ requests: [], grants: [] });
  expect(root.querySelector('article')).toBeNull();
  renderer.dispose();
  controller.dispose();
});

it('changes theme and color mode without replacing focused controls or pending actions', async () => {
  expect.assertions(10);
  const pending = Promise.withResolvers<void>();
  const controller = createBrowserControlNotificationController({ onReview: async () => pending.promise, onRevoke: async () => {} });
  controller.update({ requests: [{ ...request, expiresAt: null }], grants: [] });
  const renderer = renderBrowserControlNotifications({ controller, container: document.body, theme: { light: { primary: 'green' } }, branding: { accent: 'purple' }, css: ':host { --cdb-primary: orange; }' });
  const host = document.querySelector('section')!;
  const root = host.shadowRoot!;
  const review = root.querySelectorAll('button')[1]!;
  review.focus();
  expect(host.dataset.colorMode).toBe('system');
  expect(root.adoptedStyleSheets[1]!.cssRules[3]!.cssText).toContain('prefers-color-scheme: dark');
  renderer.setColorMode('dark');
  renderer.setTheme({ spacing: '20px', dark: { text: 'yellow' } });
  expect(host.dataset.colorMode).toBe('dark');
  expect(root.activeElement).toBe(review);
  expect(getComputedStyle(host).getPropertyValue('--cdb-spacing').trim()).toBe('20px');
  expect(root.adoptedStyleSheets[1]!.cssRules[2]!.cssText).toContain('--cdb-primary: purple');
  expect(getComputedStyle(host).getPropertyValue('--cdb-primary').trim()).toBe('orange');
  expect(root.querySelector('style')).toBeNull();
  review.click();
  renderer.setColorMode('light');
  expect(root.querySelectorAll('button')[1]).toBe(review);
  pending.resolve();
  await vi.waitUntil(() => !review.disabled);
  expect(host.dataset.colorMode).toBe('light');
  renderer.dispose();
  controller.dispose();
});
