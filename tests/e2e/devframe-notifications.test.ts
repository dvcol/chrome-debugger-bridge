import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUi } from '@devframes/hub-ui';
import { initHub } from '@devframes/hub/initiate';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it.each(['embedded', 'standalone'] as const)('updates and removes notifications in the patched %s browser assets', async (mode) => {
  expect.assertions(15);
  const directory = await mkdtemp(join(tmpdir(), 'cdb-hub-notifications-'));
  const server = createServer();
  let origin = '';
  let full = false;
  let reads = 0;
  const hub = initHub({ base: '/hub/', cwd: directory, origin: () => origin, auth: false, server, ui: createUi(), configure(context) {
    context.rpc.register({ name: 'devframes:plugin:messages:list', type: 'query', handler: (since?: number | null) => {
      reads += 1;
      return context.messages.listSince(full ? null : since);
    } });
  } });
  server.on('request', (request, response) => {
    if (request.url === '/app') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><html><body><h1>Public CDB notification host</h1><script type="module" src="/hub/embedded.js"></script></body></html>');
    } else hub.nodeMiddleware(request, response);
  });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address.');
    origin = `http://127.0.0.1:${address.port}`;
    await hub.ready;
    const context = await hub.context;
    const page = await browser.newPage();
    await page.goto(`${origin}${mode === 'embedded' ? '/app' : '/hub/'}`);
    await expect.poll(() => reads).toBeGreaterThan(0);
    for (const reconcileFull of [false, true]) {
      full = reconcileFull;
      const message = await context.messages.info('CDB approval fixture', { notify: true, autoDismiss: false, description: 'One approved tab' });
      await expect.poll(async () => page.getByText('One approved tab', { exact: true }).count()).toBe(1);
      await message.update({ description: 'Two approved tabs' });
      await expect.poll(async () => page.getByText('Two approved tabs', { exact: true }).count()).toBe(1);
      await page.locator('.bg-toast-glass').getByRole('button').click();
      await expect.poll(async () => page.getByText('CDB approval fixture', { exact: true }).count()).toBe(0);
      const previousReads = reads;
      await context.messages.info('Feed refresh', { notify: false });
      await expect.poll(() => reads).toBeGreaterThan(previousReads);
      expect(await page.getByText('CDB approval fixture', { exact: true }).count()).toBe(0);
      await message.update({ description: 'Three approved tabs' });
      await expect.poll(async () => page.getByText('Three approved tabs', { exact: true }).count()).toBe(1);
      await message.dismiss();
      await expect.poll(async () => page.getByText('CDB approval fixture', { exact: true }).count()).toBe(0);
    }
  } finally {
    await browser.close();
    await hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
