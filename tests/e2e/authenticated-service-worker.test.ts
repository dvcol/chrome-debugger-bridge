import type { BrokerToAgentMessage } from '../../packages/core/src/protocol.js';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';
import { build } from 'vite';
import { afterEach, expect, it } from 'vitest';

import { createStandaloneAuthenticatedWebSocketBridge } from '../../packages/websocket/src/node.js';
import {
  createMemoryAgentAuthenticationAdapter,
  createStaticClientAuthenticationAdapter,
} from '../../packages/websocket/src/testing.js';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

it('runs the authenticated browser transport inside an MV3 service worker', async () => {
  expect.assertions(4);
  const brokerId = crypto.randomUUID();
  const pairingCode = '047204';
  const bridge = await createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({
      brokerId,
      pairingCode,
      pairingCodeExpiresAt: Date.now() + 300_000,
      principal: { id: crypto.randomUUID(), role: 'agent' as const },
    }),
    brokerId,
    clientAuthentication: createStaticClientAuthenticationAdapter(
      'Bearer mv3-test-client',
      { id: crypto.randomUUID(), role: 'client' as const },
    ),
    onAgentConnection({ connection }) {
      connection.onMessage((message) => {
        if (message.kind !== 'request' || message.method !== 'agent.hello') {
          return;
        }
        const response: BrokerToAgentMessage = {
          kind: 'response',
          method: 'agent.hello',
          protocolVersion: 1,
          requestId: message.requestId,
          result: {
            broker: {
              instanceId: brokerId,
              name: 'mv3-test-broker',
              role: 'broker',
              version: '0.0.0',
            },
            connectionGeneration: 1,
            features: ['bridge.cdp.read'],
            heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
            limits: {
              maximumArtifactBytes: 16_777_216,
              maximumInlineResultBytes: 65_536,
              maximumMessageBytes: 16_384,
            },
            protocolVersion: 1,
          },
        };
        void connection.send(response);
      });
    },
    onClientConnection() {},
    originPolicy({ origin }) {
      return origin?.startsWith('chrome-extension://') === true;
    },
  });
  cleanupTasks.push(async () => bridge.close());

  const extensionDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-extension-'));
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-profile-'));
  cleanupTasks.push(async () => rm(extensionDirectory, { force: true, recursive: true }));
  cleanupTasks.push(async () => rm(userDataDirectory, { force: true, recursive: true }));
  await build({
    build: {
      emptyOutDir: true,
      lib: {
        entry: resolve('tests/e2e/fixtures/authenticated-service-worker.ts'),
        fileName: () => 'service-worker.js',
        formats: ['es'],
      },
      outDir: extensionDirectory,
    },
    configFile: false,
    logLevel: 'silent',
  });
  await writeFile(join(extensionDirectory, 'manifest.json'), `${JSON.stringify({
    background: { service_worker: 'service-worker.js', type: 'module' },
    manifest_version: 3,
    name: 'Chrome Debugger Bridge MV3 Test',
    permissions: ['debugger', 'storage', 'tabs'],
    version: '0.0.0',
  }, null, 2)}\n`, 'utf8');

  const context = await chromium.launchPersistentContext(userDataDirectory, {
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
    channel: 'chromium',
    headless: true,
  });
  cleanupTasks.push(async () => context.close());
  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const inspectedPage = await context.newPage();
  await inspectedPage.goto('data:text/html,<title>Bridge debugger test</title>');
  const result = await serviceWorker.evaluate(async ({ endpoint, pairingCode: code }) => {
    const serviceWorkerGlobal = globalThis as typeof globalThis & {
      runAuthenticatedBridgeTest: (input: {
        readonly endpoint: string;
        readonly pairingCode: string;
      }) => Promise<{
        readonly brokerId: string;
        readonly connectionId: string;
        readonly responseKind: string;
        readonly responseMethod: string;
      }>;
    };
    return serviceWorkerGlobal.runAuthenticatedBridgeTest({ endpoint, pairingCode: code });
  }, {
    endpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`,
    pairingCode,
  });

  expect(result.brokerId).toBe(brokerId);
  expect(result.connectionId).toMatch(/^[\da-f-]{36}$/u);
  expect(result.responseKind).toBe('response');
  expect(result.responseMethod).toBe('agent.hello');
}, 20_000);

it('attaches and detaches the real MV3 debugger from an eligible tab', async () => {
  expect.assertions(3);
  const extensionDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-extension-'));
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-profile-'));
  cleanupTasks.push(async () => rm(extensionDirectory, { force: true, recursive: true }));
  cleanupTasks.push(async () => rm(userDataDirectory, { force: true, recursive: true }));
  await build({ build: { emptyOutDir: true, lib: { entry: resolve('tests/e2e/fixtures/authenticated-service-worker.ts'), fileName: () => 'service-worker.js', formats: ['es'] }, outDir: extensionDirectory }, configFile: false, logLevel: 'silent' });
  await writeFile(join(extensionDirectory, 'manifest.json'), `${JSON.stringify({ background: { service_worker: 'service-worker.js', type: 'module' }, manifest_version: 3, name: 'Chrome Debugger Bridge MV3 Test', permissions: ['debugger', 'tabs'], version: '0.0.0' }, null, 2)}\n`, 'utf8');
  const context = await chromium.launchPersistentContext(userDataDirectory, { args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`], channel: 'chromium', headless: true });
  cleanupTasks.push(async () => context.close());
  const page = await context.newPage();
  await page.setContent('<title>Bridge debugger test</title>');
  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const result = await serviceWorker.evaluate(async () => (globalThis as unknown as { runDebuggerLifecycleTest: () => Promise<{ readonly revoked: boolean; readonly value: string }> }).runDebuggerLifecycleTest());
  expect(result.value).toBe('Bridge debugger test');
  expect(result.revoked).toBe(true);
  await expect(page.title()).resolves.toBe('Bridge debugger test');
}, 20_000);

it('publishes, updates, and revokes a target through real Chrome lifecycle events', async () => {
  expect.assertions(3);
  const server = createServer((_request, response) => {
    response.end('<title>Bridge target</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test server did not expose a TCP address.');
  cleanupTasks.push(async () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))));
  const initialUrl = `http://127.0.0.1:${address.port}/initial`;
  const updatedUrl = `http://127.0.0.1:${address.port}/updated`;
  const extensionDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-extension-'));
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-profile-'));
  cleanupTasks.push(async () => rm(extensionDirectory, { force: true, recursive: true }));
  cleanupTasks.push(async () => rm(userDataDirectory, { force: true, recursive: true }));
  await build({ build: { emptyOutDir: true, lib: { entry: resolve('tests/e2e/fixtures/authenticated-service-worker.ts'), fileName: () => 'service-worker.js', formats: ['es'] }, outDir: extensionDirectory }, configFile: false, logLevel: 'silent' });
  await writeFile(join(extensionDirectory, 'manifest.json'), `${JSON.stringify({ background: { service_worker: 'service-worker.js', type: 'module' }, manifest_version: 3, name: 'Chrome Debugger Bridge MV3 Test', permissions: ['debugger', 'tabs'], version: '0.0.0' }, null, 2)}\n`, 'utf8');
  const context = await chromium.launchPersistentContext(userDataDirectory, { args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`], channel: 'chromium', headless: true });
  cleanupTasks.push(async () => context.close());
  const page = await context.newPage();
  await page.goto(initialUrl);
  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const outcomes = await serviceWorker.evaluate(async url => (globalThis as unknown as { runPublishedTargetLifecycleTest: (updatedUrl: string) => Promise<readonly { readonly kind: 'published' | 'revoked' | 'updated'; readonly reason?: string }[]> }).runPublishedTargetLifecycleTest(url), updatedUrl);

  expect(outcomes.map(outcome => outcome.kind)).toContain('published');
  expect(outcomes.map(outcome => outcome.kind)).toContain('updated');
  expect(outcomes).toContainEqual({ kind: 'revoked', reason: 'detached' });
}, 20_000);
