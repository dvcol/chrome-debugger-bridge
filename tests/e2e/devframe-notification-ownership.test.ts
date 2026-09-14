import type { BrokerState } from '@dvcol/cdb-broker/contract';
import type { BrowserControlPanelClient } from '@dvcol/cdb-devframe/panel';

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUi } from '@devframes/hub-ui';
import { initHub } from '@devframes/hub/initiate';
import { createCdbPanel } from '@dvcol/cdb-devframe';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it.each(['embedded', 'standalone'] as const)('shares one approval notification between two %s clients with local actions', async (mode) => {
  expect.assertions(12);
  const directory = await mkdtemp(join(tmpdir(), 'cdb-notification-ownership-'));
  const server = createServer();
  let origin = '';
  let state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [] };
  const listeners = new Set<(state: BrokerState) => void>();
  const client: BrowserControlPanelClient = {
    snapshot: () => state,
    watch(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    revokeScope: async () => {},
    revokeGrant: async () => true,
    disconnectProvider: async () => true,
  };
  const panel = createCdbPanel({ client: () => client, approvalAction: 'accept' });
  const hub = initHub({ base: '/hub/', cwd: directory, origin: () => origin, auth: false, server, ui: createUi(), devframes: [panel.definition], configure(context) {
    context.rpc.register({ name: 'devframes:plugin:messages:list', type: 'query', handler: (since?: number | null) => context.messages.listSince(since) });
  } });
  server.on('request', (request, response) => {
    if (request.url !== '/app') return hub.nodeMiddleware(request, response);
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><html><body><h1>Public CDB approval fixture</h1><script type="module" src="/hub/embedded.js"></script></body></html>');
  });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address.');
    origin = `http://127.0.0.1:${address.port}`;
    await hub.ready;
    const context = await hub.context;
    const first = await browser.newPage();
    const second = await browser.newPage();
    for (const page of [first, second]) {
      await page.addInitScript(() => {
        window.addEventListener('cdb:accept-request', (event) => {
          document.documentElement.dataset.acceptedRequest = (event as CustomEvent<{ requestId: string }>).detail.requestId;
        });
      });
      await page.goto(`${origin}${mode === 'embedded' ? '/app' : '/hub/'}`);
      await expect.poll(async () => page.locator('html').getAttribute('data-cdb-notifications-ready'), { timeout: 5_000 }).toBe('');
    }
    state = { ...state, requests: [{ id: 'public-request', principalId: 'public-agent', principalLabel: 'Public test agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: Date.now(), expiresAt: null }] };
    for (const listener of listeners) listener(state);
    for (const page of [first, second]) {
      await expect.poll(async () => page.getByRole('button', { name: 'Accept', exact: true }).count(), { timeout: 5_000 }).toBe(1);
    }
    expect(Array.from(context.messages.entries.values()).filter(message => message.message === 'Browser control requested')).toHaveLength(1);
    await first.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(async () => first.locator('html').getAttribute('data-accepted-request')).toBe('public-request');
    expect(await second.locator('html').getAttribute('data-accepted-request')).toBeNull();
    await first.close();
    expect(Array.from(context.messages.entries.values()).filter(message => message.message === 'Browser control requested')).toHaveLength(1);
    await second.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(async () => second.locator('html').getAttribute('data-accepted-request')).toBe('public-request');
    state = { ...state, requests: [] };
    for (const listener of listeners) listener(state);
    await expect.poll(async () => second.getByText('Browser control requested', { exact: true }).count()).toBe(0);
    expect(Array.from(context.messages.entries.values()).filter(message => message.message === 'Browser control requested')).toHaveLength(0);
    expect(listeners.size).toBe(1);
  } finally {
    await browser.close();
    panel.dispose();
    await hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
