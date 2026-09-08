import type { CdbDevframeService } from '@dvcol/cdb-devframe';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createCdbPanel, createCdbService, getCdbService } from '@dvcol/cdb-devframe';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { defineDevframe } from 'devframe';
import { createDevServer } from 'devframe/adapters/dev';
import { createWsOriginRegistry } from 'devframe/rpc/transports/ws-server';
import { chromium } from 'playwright';
import { build } from 'vite';
import { expect, it } from 'vitest';

import { deepDomPage } from './fixtures/deep-dom-page.js';
import { benchmarkAgentWorkflow } from './fixtures/workflow-benchmark.js';

interface FixtureWorker {
  startDevframeProvider: (baseURL: string) => Promise<void>;
  approveDevframeRequest: (requestId: string, scope?: 'tab' | 'group') => Promise<unknown>;
  changeFixtureMembership: (url: string, joined: boolean) => Promise<void>;
  disconnectDevframeProvider: () => void;
  stopDevframeProvider: () => Promise<void>;
}

it('runs native MCP actions through Chrome extension and shared Devframe RPC across closed shadows and cross-origin frames', async () => {
  expect.assertions(27);
  const cleanups: (() => Promise<unknown>)[] = [];
  try {
    const pageServer = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(deepDomPage(new URL(request.url ?? '/', `http://${request.headers.host}`)));
    });
    await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => new Promise<void>((resolve, reject) => pageServer.close(error => error === undefined ? resolve() : reject(error))));
    const address = pageServer.address();
    if (address === null || typeof address === 'string') throw new Error('The fixture server has no port.');
    let service: CdbDevframeService | undefined;
    const allowedOrigins = createWsOriginRegistry();
    const panel = createCdbPanel({ client() {
      const broker = service!.broker;
      return { ...broker, watch(listener) {
        listener(broker.snapshot());
        return broker.subscribe(listener);
      } };
    } });
    const devframe = await createDevServer(defineDevframe({
      ...panel.definition,
      services: [createCdbService()],
      async setup(context) {
        service = getCdbService(context);
        await panel.definition.setup(context);
      },
    }), {
      host: '127.0.0.1',
      port: 0,
      openBrowser: false,
      auth: false,
      mcp: false,
      allowedOrigins,
      onPeerConnect: (connection, session) => service!.onPeerConnect(connection, session),
      onPeerDisconnect: (connection) => {
        void service!.onPeerDisconnect(connection);
      },
    });
    cleanups.push(async () => {
      panel.dispose();
      await devframe.close();
      await service?.dispose();
    });
    const broker = service!.broker;
    const directory = await mkdtemp(join(tmpdir(), 'cdb-devframe-chromium-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const extensionDirectory = join(directory, 'extension');
    await build({ configFile: false, logLevel: 'silent', build: { emptyOutDir: true, outDir: extensionDirectory, lib: { entry: resolve('tests/e2e/fixtures/devframe-service-worker.ts'), fileName: () => 'worker.js', formats: ['es'] } } });
    await writeFile(join(extensionDirectory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Public CDB Devframe fixture', version: '1.0.0', background: { service_worker: 'worker.js', type: 'module' }, permissions: ['debugger', 'tabs', 'tabGroups', 'webNavigation', 'storage', 'alarms'], host_permissions: ['http://*/*'] }));
    const browser = await chromium.launchPersistentContext(join(directory, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--site-per-process', '--host-resolver-rules=MAP *.test 127.0.0.1', '--no-proxy-server'] });
    cleanups.push(async () => browser.close());
    const page = await browser.newPage();
    await page.goto(`http://cdb-root.test:${address.port}/?profile=normal&shadow=closed&frames=cross-origin`);
    const leaf = page.frames().find(frame => new URL(frame.url()).searchParams.get('frame') === '3');
    if (leaf === undefined) throw new Error('The nested fixture frame did not load.');
    await leaf.waitForSelector('html[data-fixture-ready="true"]');
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
    const workerUrl = new URL(worker.url());
    const registrationUrl = new URL(`http://127.0.0.1:${devframe.port}/__connection.json`);
    registrationUrl.searchParams.set('devframe_viewer_origin', `${workerUrl.protocol}//${workerUrl.host}`);
    registrationUrl.searchParams.set('devframe_viewer_origin_token', allowedOrigins.token);
    allowedOrigins.registerFromUrl(registrationUrl.href);
    await worker.evaluate(async baseURL => (globalThis as unknown as FixtureWorker).startDevframeProvider(baseURL), `http://127.0.0.1:${devframe.port}/`);
    await expect.poll(() => broker.snapshot().providers.some(provider => provider.state === 'ready')).toBe(true);
    const management = await browser.newPage();
    const pageErrors: string[] = [];
    management.on('pageerror', error => pageErrors.push(error.message));
    await management.goto(`http://127.0.0.1:${devframe.port}/`);
    await management.getByRole('tab', { name: /Providers/ }).click();
    await expect.poll(async () => management.getByText('Public Chrome fixture', { exact: true }).count()).toBe(1).catch(async (error) => {
      throw new Error(JSON.stringify({ pageErrors, panel: await management.locator('#app').textContent() }), { cause: error });
    });

    const mcpServer = new Server({ name: 'public-cdb-agent', version: '1.0.0' }, { capabilities: { tools: {} } });
    const principal = { id: 'fixture-agent' };
    mcpServer.setRequestHandler('tools/list', async () => ({ tools: broker.tools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, type: 'object' as const } })) }));
    mcpServer.setRequestHandler('tools/call', async (request, context): Promise<CallToolResult> => {
      try {
        const value = await broker.invoke(principal, request.params.name, request.params.arguments, { signal: context.mcpReq.signal });
        return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ...(error as object), message: error instanceof Error ? error.message : String(error) }) }] };
      }
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: 'Public regression agent', version: '1.0.0' });
    await mcpServer.connect(serverTransport);
    await agent.connect(clientTransport);
    cleanups.push(async () => {
      await agent.close();
      await mcpServer.close();
    });
    const requested = agent.callTool({ name: 'browser.request_access', arguments: { level: 'interact' } });
    await expect.poll(() => broker.snapshot().requests.length).toBe(1);
    await worker.evaluate(async requestId => (globalThis as unknown as FixtureWorker).approveDevframeRequest(requestId), broker.snapshot().requests[0]!.id);
    const access = await requested;
    expect(access.isError).toBeUndefined();
    await benchmarkAgentWorkflow(agent, browser.browser()?.version() ?? 'unavailable', page);
    await page.locator('#toggle-overlay').click();
    const blockedStarted = performance.now();
    const blocked = await agent.callTool({ name: 'browser.click', arguments: { targetRef: 't1', locator: { role: 'button', name: { match: 'exact', value: 'Save deep value' } } } });
    expect(JSON.stringify(blocked)).toContain('MCP_ELEMENT_COVERED');
    expect(performance.now() - blockedStarted).toBeLessThan(3_000);
    await page.evaluate(() => {
      setTimeout(() => document.getElementById('parent-overlay')?.remove(), 2_500);
    });
    const delayedStarted = performance.now();
    const delayed = await agent.callTool({ name: 'browser.click', arguments: { targetRef: 't1', locator: { role: 'button', name: { match: 'exact', value: 'Save deep value' } }, timeoutMilliseconds: 4_000 } });
    expect(delayed.isError, JSON.stringify(delayed)).toBeUndefined();
    expect(performance.now() - delayedStarted).toBeGreaterThanOrEqual(2_000);
    const result = await agent.callTool({ name: 'browser.batch', arguments: {
      actionTimeoutMilliseconds: 10_000,
      targetRef: 't1',
      observe: true,
      actions: [
        { action: 'fill', locator: { role: 'textbox', name: { match: 'exact', value: 'Deep value' } }, text: 'Shared RPC proof' },
        { action: 'click', locator: { role: 'button', name: { match: 'exact', value: 'Save deep value' } } },
      ],
    } });
    expect(result.isError, JSON.stringify(result)).toBeUndefined();
    await expect.poll(async () => page.getByRole('status').textContent()).toBe('Saved: Shared RPC proof');
    const initialScope = broker.snapshot().scopes[0]!.id;
    const initialOrigin = new URL(page.url()).origin;
    const followPeer = { id: 'follow-tab-agent' };
    const additionalAccess = broker.invoke(followPeer, 'browser.request_access', { level: 'interact', navigation: 'follow-tab' });
    await expect.poll(() => broker.snapshot().requests.length).toBe(1);
    await worker.evaluate(async requestId => (globalThis as unknown as FixtureWorker).approveDevframeRequest(requestId, 'group'), broker.snapshot().requests[0]!.id);
    await additionalAccess;
    expect(new Set(broker.snapshot().grants.map(grant => grant.targetId)).size).toBe(1);
    const joining = await browser.newPage();
    await joining.goto(`http://cdb-root.test:${address.port}/?profile=normal`);
    await worker.evaluate(async url => (globalThis as unknown as FixtureWorker).changeFixtureMembership(url, true), joining.url());
    await expect.poll(() => broker.snapshot().grants.length).toBe(3);
    expect(await broker.invoke(followPeer, 'browser.list_targets', {})).toHaveLength(2);
    await worker.evaluate(async url => (globalThis as unknown as FixtureWorker).changeFixtureMembership(url, false), joining.url());
    await expect.poll(() => broker.snapshot().grants.length).toBe(2);
    await joining.close();
    const previousGeneration = broker.snapshot().grants[0]!.targetGeneration;
    await worker.evaluate(() => (globalThis as unknown as FixtureWorker).disconnectDevframeProvider());
    await expect.poll(() => broker.snapshot().grants.length === 2 && broker.snapshot().grants.every(grant => grant.state === 'active' && grant.targetGeneration > previousGeneration)).toBe(true);
    expect(await broker.invoke(followPeer, 'browser.list_targets', {})).toMatchObject([{ targetRef: 't1' }]);
    await page.goto(`http://cdb-other.test:${address.port}/?profile=normal&shadow=closed&frames=cross-origin`);
    await expect.poll(() => broker.snapshot().grants.map(grant => grant.state).sort()).toEqual(['active', 'out-of-scope']);
    expect(broker.snapshot().grants.map(grant => grant.approvedOrigin)).toEqual([initialOrigin, initialOrigin]);
    const denied = await agent.callTool({ name: 'browser.snapshot', arguments: { targetRef: 't1' } });
    expect(JSON.stringify(denied)).toContain('TARGET_OUT_OF_SCOPE');
    expect(await broker.invoke(followPeer, 'browser.list_targets', {})).toMatchObject([{ targetRef: 't1' }]);
    await broker.revokeScope(initialScope);
    await expect.poll(() => broker.snapshot().grants.length).toBe(1);
    const continued = await broker.invoke(followPeer, 'browser.batch', {
      actionTimeoutMilliseconds: 10_000,
      targetRef: 't1',
      actions: [
        { action: 'fill', locator: { role: 'textbox', name: { match: 'exact', value: 'Deep value' } }, text: 'Independent approval survived' },
        { action: 'click', locator: { role: 'button', name: { match: 'exact', value: 'Save deep value' } } },
      ],
    });
    expect(continued).toMatchObject({ completed: [{ index: 0, action: 'fill' }, { index: 1, action: 'click' }] });
    await expect.poll(async () => page.getByRole('status').textContent()).toBe('Saved: Independent approval survived');
    await management.getByRole('tab', { name: /Access/ }).click();
    await management.getByRole('button', { name: 'Revoke target', exact: true }).click();
    await expect.poll(() => broker.snapshot().grants).toEqual([]);
    await expect.poll(async () => management.getByText('No shared tabs. Approve an agent request in the browser to grant access.', { exact: true }).count()).toBe(1);
    await worker.evaluate(async () => (globalThis as unknown as FixtureWorker).stopDevframeProvider());
    expect(broker.snapshot().grants).toEqual([]);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}, process.env.CDB_DEVFRAME_BENCHMARK_OUTPUT === undefined ? 90_000 : 240_000);
