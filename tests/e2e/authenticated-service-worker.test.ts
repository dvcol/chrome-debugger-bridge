import type { BrokerToAgentMessage, BrokerToClientMessage, ClientToBrokerMessage } from '../../packages/core/src/protocol.js';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';
import { build } from 'vite';
import { afterEach, expect, it } from 'vitest';

import { connectAgentTargetBroker, connectClientTargetBroker, createTargetBroker } from '../../packages/core/src/index.js';
import { connectNodeClientWebSocket, createStandaloneAuthenticatedWebSocketBridge } from '../../packages/websocket/src/node.js';
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

interface ClientTestConnection {
  onMessage: (listener: (message: BrokerToClientMessage) => void) => () => void;
  send: (message: ClientToBrokerMessage) => Promise<void>;
}

async function sendClientRequest(connection: ClientTestConnection, request: Extract<ClientToBrokerMessage, { readonly kind: 'request' }>): Promise<Extract<BrokerToClientMessage, { readonly requestId: string }>> {
  const response = new Promise<Extract<BrokerToClientMessage, { readonly requestId: string }>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${request.method}.`)), 5_000);
    const removeListener = connection.onMessage((message) => {
      if ('requestId' in message && message.requestId === request.requestId) {
        removeListener();
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  await connection.send(request);
  return response;
}

async function waitForClientNotification(connection: ClientTestConnection, method: Extract<BrokerToClientMessage, { readonly kind: 'notification' }>['method']): Promise<Extract<BrokerToClientMessage, { readonly kind: 'notification' }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), 5_000);
    const removeListener = connection.onMessage((message) => {
      if (message.kind === 'notification' && message.method === method) {
        removeListener();
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
}

it('runs the authenticated browser transport inside an MV3 service worker', async () => {
  expect.assertions(6);
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
        readonly resumedConnectionId: string;
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
  expect(result.resumedConnectionId).toMatch(/^[\da-f-]{36}$/u);
  expect(result.resumedConnectionId).not.toBe(result.connectionId);
  expect(result.responseKind).toBe('response');
  expect(result.responseMethod).toBe('agent.hello');
}, 20_000);

it('validates a Devframe offer in a real MV3 worker before direct broker traffic', async () => {
  expect.assertions(5);
  const brokerId = crypto.randomUUID();
  const pairingCode = '846201';
  const bridge = await createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({ brokerId, pairingCode, pairingCodeExpiresAt: Date.now() + 300_000, principal: { id: crypto.randomUUID(), role: 'agent' as const } }),
    brokerId,
    clientAuthentication: createStaticClientAuthenticationAdapter('Bearer devframe-bootstrap-client', { id: crypto.randomUUID(), role: 'client' as const }),
    onAgentConnection({ connection }) {
      connection.onMessage((message) => {
        if (message.kind !== 'request' || message.method !== 'agent.hello') return;
        void connection.send({
          kind: 'response',
          method: 'agent.hello',
          protocolVersion: 1,
          requestId: message.requestId,
          result: {
            broker: { instanceId: brokerId, name: 'devframe-bootstrap-test', role: 'broker', version: '0.0.0' },
            connectionGeneration: 1,
            features: ['bridge.cdp.read'],
            heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
            limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 16_384 },
            protocolVersion: 1,
          },
        });
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
  await build({ build: { emptyOutDir: true, lib: { entry: resolve('tests/e2e/fixtures/authenticated-service-worker.ts'), fileName: () => 'service-worker.js', formats: ['es'] }, outDir: extensionDirectory }, configFile: false, logLevel: 'silent' });
  await writeFile(join(extensionDirectory, 'manifest.json'), `${JSON.stringify({ background: { service_worker: 'service-worker.js', type: 'module' }, manifest_version: 3, name: 'Chrome Debugger Bridge Devframe Bootstrap Test', permissions: ['storage'], version: '0.0.0' }, null, 2)}\n`, 'utf8');
  const context = await chromium.launchPersistentContext(userDataDirectory, { args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`], channel: 'chromium', headless: true });
  cleanupTasks.push(async () => context.close());
  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const result = await serviceWorker.evaluate(async ({ endpoint, pairingCode: code }) => (globalThis as unknown as {
    runDevframeBootstrapTest: (input: { readonly endpoint: string; readonly pairingCode: string }) => Promise<{ readonly brokerId: string; readonly malformedRejected: boolean; readonly responseMethod: string; readonly wrongOriginRejected: boolean }>;
  }).runDevframeBootstrapTest({ endpoint, pairingCode: code }), { endpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`, pairingCode });

  expect(result.brokerId).toBe(brokerId);
  expect(result.malformedRejected).toBe(true);
  expect(result.wrongOriginRejected).toBe(true);
  expect(result.responseMethod).toBe('agent.hello');
  expect(bridge.host).toBe('127.0.0.1');
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

it('arbitrates authenticated clients and routes shared real-Chrome events through the MV3 agent', async () => {
  expect.assertions(27);
  const brokerId = crypto.randomUUID();
  const pairingCode = '147258';
  const server = createServer((_request, response) => {
    response.end('<title>Broker command target</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test server did not expose a TCP address.');
  cleanupTasks.push(async () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))));
  let currentTime = Date.now();
  const targetBroker = createTargetBroker({ now: () => currentTime });
  const receivedAgentEvents: Array<{ readonly method: string; readonly targetGeneration: number; readonly targetId: string }> = [];
  const targetWatcher = targetBroker.watchTargets()[Symbol.asyncIterator]();
  await targetWatcher.next();
  const bridge = await createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({ brokerId, pairingCode, pairingCodeExpiresAt: Date.now() + 300_000, principal: { id: crypto.randomUUID(), role: 'agent' as const } }),
    brokerId,
    clientAuthentication: createStaticClientAuthenticationAdapter('Bearer mv3-agent-test-client', { id: crypto.randomUUID(), role: 'client' as const }),
    onAgentConnection({ connection }) {
      const disconnect = connectAgentTargetBroker(connection, targetBroker);
      connection.onMessage((message) => {
        if (message.kind === 'notification' && message.method === 'cdp.event') {
          receivedAgentEvents.push({
            method: message.parameters.method,
            targetGeneration: message.parameters.targetGeneration,
            targetId: message.parameters.targetId,
          });
        }
      });
      cleanupTasks.push(async () => disconnect());
    },
    onClientConnection({ connection }) {
      const disconnect = connectClientTargetBroker(connection, targetBroker);
      void connection.closed.then(disconnect);
    },
    originPolicy({ origin }) {
      return origin === undefined || origin.startsWith('chrome-extension://');
    },
  });
  cleanupTasks.push(async () => bridge.close());
  const extensionDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-extension-'));
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-profile-'));
  cleanupTasks.push(async () => rm(extensionDirectory, { force: true, recursive: true }));
  cleanupTasks.push(async () => rm(userDataDirectory, { force: true, recursive: true }));
  await build({ build: { emptyOutDir: true, lib: { entry: resolve('tests/e2e/fixtures/authenticated-service-worker.ts'), fileName: () => 'service-worker.js', formats: ['es'] }, outDir: extensionDirectory }, configFile: false, logLevel: 'silent' });
  await writeFile(join(extensionDirectory, 'manifest.json'), `${JSON.stringify({ background: { service_worker: 'service-worker.js', type: 'module' }, manifest_version: 3, name: 'Chrome Debugger Bridge MV3 Test', permissions: ['debugger', 'storage', 'tabs'], version: '0.0.0' }, null, 2)}\n`, 'utf8');
  const context = await chromium.launchPersistentContext(userDataDirectory, { args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`], channel: 'chromium', headless: true });
  cleanupTasks.push(async () => context.close());
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/target`);
  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const target = await serviceWorker.evaluate(async ({ endpoint, pairingCode: code }) => (globalThis as unknown as { runPublishedTargetAgentTest: (input: { readonly endpoint: string; readonly pairingCode: string }) => Promise<{ readonly generation: number; readonly id: string }> }).runPublishedTargetAgentTest({ endpoint, pairingCode: code }), { endpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`, pairingCode });
  const publication = await targetWatcher.next();
  const clientEndpoint = `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/client`;
  const firstReader = await connectNodeClientWebSocket({ authorization: 'Bearer mv3-agent-test-client', endpoint: clientEndpoint });
  const secondReader = await connectNodeClientWebSocket({ authorization: 'Bearer mv3-agent-test-client', endpoint: clientEndpoint });
  const controller = await connectNodeClientWebSocket({ authorization: 'Bearer mv3-agent-test-client', endpoint: clientEndpoint });
  const competingController = await connectNodeClientWebSocket({ authorization: 'Bearer mv3-agent-test-client', endpoint: clientEndpoint });
  cleanupTasks.push(async () => firstReader.close());
  cleanupTasks.push(async () => secondReader.close());
  cleanupTasks.push(async () => controller.close());
  cleanupTasks.push(async () => competingController.close());
  const firstReaderTargets = await sendClientRequest(firstReader, { kind: 'request', method: 'targets.list', parameters: {}, protocolVersion: 1, requestId: crypto.randomUUID() });
  const secondReaderTargets = await sendClientRequest(secondReader, { kind: 'request', method: 'targets.list', parameters: {}, protocolVersion: 1, requestId: crypto.randomUUID() });
  const unexposedTarget = await sendClientRequest(firstReader, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'shared-read', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: 1, targetId: crypto.randomUUID() }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const forbiddenMethod = await sendClientRequest(firstReader, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'exclusive-control', requestedMethods: ['Target.attachToTarget'], targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const staleGeneration = await sendClientRequest(firstReader, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'shared-read', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation + 1, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const firstReaderLeaseResponse = await sendClientRequest(firstReader, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'shared-read', requestedMethods: ['Bridge.childSessionAttached', 'Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const secondReaderLeaseResponse = await sendClientRequest(secondReader, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'shared-read', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const controllerLeaseResponse = await sendClientRequest(controller, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const competingLeaseResponse = await sendClientRequest(competingController, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const firstReaderLease = firstReaderLeaseResponse.kind === 'response' && firstReaderLeaseResponse.method === 'leases.acquire' ? firstReaderLeaseResponse.result.lease : undefined;
  const secondReaderLease = secondReaderLeaseResponse.kind === 'response' && secondReaderLeaseResponse.method === 'leases.acquire' ? secondReaderLeaseResponse.result.lease : undefined;
  const lease = controllerLeaseResponse.kind === 'response' && controllerLeaseResponse.method === 'leases.acquire' ? controllerLeaseResponse.result.lease : undefined;
  const firstSubscription = await sendClientRequest(firstReader, { kind: 'request', method: 'cdp.subscribe', parameters: { buffer: { capacity: 2, overflowStrategy: 'drop-oldest' }, leaseId: firstReaderLease!.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const childSessionSubscription = await sendClientRequest(firstReader, { kind: 'request', method: 'cdp.subscribe', parameters: { buffer: { capacity: 2, overflowStrategy: 'drop-oldest' }, leaseId: firstReaderLease!.id, match: { method: 'Bridge.childSessionAttached' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const secondSubscription = await sendClientRequest(secondReader, { kind: 'request', method: 'cdp.subscribe', parameters: { buffer: { capacity: 2, overflowStrategy: 'drop-oldest' }, leaseId: secondReaderLease!.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const overflowSubscription = await targetBroker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: firstReaderLease!.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  const firstEvent = waitForClientNotification(firstReader, 'cdp.event');
  const secondEvent = waitForClientNotification(secondReader, 'cdp.event');
  const result = await sendClientRequest(controller, { kind: 'request', method: 'cdp.send', parameters: { leaseId: lease!.id, method: 'Runtime.evaluate', operationId: crypto.randomUUID(), parameters: { expression: 'console.log("bridge event one"); console.log("bridge event two"); document.title' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const [firstReaderEvent, secondReaderEvent] = await Promise.all([firstEvent, secondEvent]);
  await sendClientRequest(controller, { kind: 'request', method: 'cdp.send', parameters: { leaseId: lease!.id, method: 'Runtime.evaluate', operationId: crypto.randomUUID(), parameters: { expression: 'globalThis.__bridgeWorker = new Worker(URL.createObjectURL(new Blob(["setTimeout(() => console.log(\\\"child bridge event\\\"), 1000)"], { type: "text/javascript" }))); "worker created"' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  await new Promise(resolve => setTimeout(resolve, 2_000));
  currentTime += 5_000;
  const expiredCommand = await sendClientRequest(controller, { kind: 'request', method: 'cdp.send', parameters: { leaseId: lease!.id, method: 'Runtime.evaluate', operationId: crypto.randomUUID(), parameters: { expression: 'document.title' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  const renewedTarget = await serviceWorker.evaluate(async ({ endpoint, pairingCode: code }) => (globalThis as unknown as { recoverPublishedTargetAgentTest: (input: { readonly endpoint: string; readonly pairingCode: string }) => Promise<{ readonly generation: number; readonly id: string }> }).recoverPublishedTargetAgentTest({ endpoint, pairingCode: code }), { endpoint: `ws://${bridge.host}:${bridge.port}/__chrome_debugger_bridge/agent`, pairingCode });
  const revocation = await targetWatcher.next();
  const renewedPublication = await targetWatcher.next();
  const staleTargetAfterRecovery = await sendClientRequest(firstReader, { kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 5_000, mode: 'shared-read', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: crypto.randomUUID() });
  await serviceWorker.evaluate(async () => (globalThis as unknown as { interruptPublishedTargetAgentTest: () => Promise<void> }).interruptPublishedTargetAgentTest());
  const renewedRevocation = await targetWatcher.next();

  expect(publication).toMatchObject({ done: false, value: { kind: 'published', target: { generation: target.generation, id: target.id } } });
  expect(firstReaderTargets).toMatchObject({ kind: 'response', method: 'targets.list', result: { targets: [{ id: target.id }] } });
  expect(secondReaderTargets).toMatchObject({ kind: 'response', method: 'targets.list', result: { targets: [{ id: target.id }] } });
  expect(unexposedTarget).toMatchObject({ kind: 'error', method: 'leases.acquire', error: { code: 'TARGET_NOT_FOUND' } });
  expect(forbiddenMethod).toMatchObject({ kind: 'error', method: 'leases.acquire', error: { code: 'CAPABILITY_DENIED' } });
  expect(staleGeneration).toMatchObject({ kind: 'error', method: 'leases.acquire', error: { code: 'TARGET_GENERATION_STALE' } });
  expect(firstReaderLease?.mode).toBe('shared-read');
  expect(secondReaderLease?.mode).toBe('shared-read');
  expect(lease?.mode).toBe('exclusive-control');
  expect(competingLeaseResponse).toMatchObject({ kind: 'error', method: 'leases.acquire', error: { code: 'LEASE_CONFLICT' } });
  expect(firstSubscription).toMatchObject({ kind: 'response', method: 'cdp.subscribe' });
  expect(childSessionSubscription).toMatchObject({ kind: 'response', method: 'cdp.subscribe' });
  expect(secondSubscription).toMatchObject({ kind: 'response', method: 'cdp.subscribe' });
  expect(result).toMatchObject({ kind: 'response', method: 'cdp.send', result: { value: { result: { type: 'string', value: 'Broker command target' } } } });
  expect(firstReaderEvent).toMatchObject({ method: 'cdp.event', parameters: { method: 'Runtime.consoleAPICalled' } });
  expect(secondReaderEvent).toMatchObject({ method: 'cdp.event', parameters: { method: 'Runtime.consoleAPICalled' } });
  expect(receivedAgentEvents).toContainEqual(expect.objectContaining({ method: 'Runtime.consoleAPICalled', targetGeneration: target.generation, targetId: target.id }));
  expect(overflowSubscription.overflowed).toBe(true);
  expect(overflowSubscription.droppedCount).toBeGreaterThan(0);
  expect(expiredCommand).toMatchObject({ kind: 'error', method: 'cdp.send', error: { code: 'LEASE_EXPIRED' } });
  expect(JSON.stringify(result)).not.toContain('tabId');
  expect(revocation).toMatchObject({ done: false, value: { kind: 'revoked', reason: 'detached', targetGeneration: target.generation, targetId: target.id } });
  expect(renewedPublication).toMatchObject({ done: false, value: { kind: 'published', target: { generation: renewedTarget.generation, id: renewedTarget.id } } });
  expect(renewedTarget.id).not.toBe(target.id);
  expect(staleTargetAfterRecovery).toMatchObject({ kind: 'error', method: 'leases.acquire', error: { code: 'TARGET_NOT_FOUND' } });
  expect(renewedRevocation).toMatchObject({ done: false, value: { kind: 'revoked', reason: 'detached', targetGeneration: renewedTarget.generation, targetId: renewedTarget.id } });
  expect(targetBroker.listTargets()).toEqual([]);
}, 20_000);

it('reissues fresh target authority after a broker restart on the same endpoint', async () => {
  expect.assertions(6);
  const brokerId = crypto.randomUUID();
  const pairingCode = '852741';
  const agentAuthentication = createMemoryAgentAuthenticationAdapter({ brokerId, pairingCode, pairingCodeExpiresAt: Date.now() + 300_000, principal: { id: crypto.randomUUID(), role: 'agent' as const } });
  const clientAuthentication = createStaticClientAuthenticationAdapter('Bearer broker-restart-client', { id: crypto.randomUUID(), role: 'client' as const });
  const server = createServer((_request, response) => response.end('<title>Broker restart target</title>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test server did not expose a TCP address.');
  cleanupTasks.push(async () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))));
  const createBroker = async (targetBroker: ReturnType<typeof createTargetBroker>, port?: number) => createStandaloneAuthenticatedWebSocketBridge({
    agentAuthentication,
    brokerId,
    clientAuthentication,
    ...(port === undefined ? {} : { port }),
    onAgentConnection({ connection }) {
      const disconnect = connectAgentTargetBroker(connection, targetBroker);
      void connection.closed.then(disconnect);
    },
    onClientConnection({ connection }) {
      const disconnect = connectClientTargetBroker(connection, targetBroker);
      void connection.closed.then(disconnect);
    },
    originPolicy({ origin }) {
      return origin === undefined || origin.startsWith('chrome-extension://');
    },
  });
  const firstBroker = createTargetBroker();
  const firstBridge = await createBroker(firstBroker);
  const extensionDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-extension-'));
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-profile-'));
  cleanupTasks.push(async () => rm(extensionDirectory, { force: true, recursive: true }));
  cleanupTasks.push(async () => rm(userDataDirectory, { force: true, recursive: true }));
  await build({ build: { emptyOutDir: true, lib: { entry: resolve('tests/e2e/fixtures/authenticated-service-worker.ts'), fileName: () => 'service-worker.js', formats: ['es'] }, outDir: extensionDirectory }, configFile: false, logLevel: 'silent' });
  await writeFile(join(extensionDirectory, 'manifest.json'), `${JSON.stringify({ background: { service_worker: 'service-worker.js', type: 'module' }, manifest_version: 3, name: 'Chrome Debugger Bridge Broker Restart Test', permissions: ['debugger', 'storage', 'tabs'], version: '0.0.0' }, null, 2)}\n`, 'utf8');
  const context = await chromium.launchPersistentContext(userDataDirectory, { args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`], channel: 'chromium', headless: true });
  cleanupTasks.push(async () => context.close());
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/target`);
  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const endpoint = `ws://${firstBridge.host}:${firstBridge.port}/__chrome_debugger_bridge/agent`;
  const initialTarget = await serviceWorker.evaluate(async ({ endpoint: agentEndpoint, pairingCode: code }) => (globalThis as unknown as { runPublishedTargetAgentTest: (input: { readonly endpoint: string; readonly pairingCode: string }) => Promise<{ readonly generation: number; readonly id: string }> }).runPublishedTargetAgentTest({ endpoint: agentEndpoint, pairingCode: code }), { endpoint, pairingCode });
  await firstBridge.close();
  const secondBroker = createTargetBroker();
  const secondBridge = await createBroker(secondBroker, firstBridge.port);
  cleanupTasks.push(async () => secondBridge.close());
  const secondTargetWatcher = secondBroker.watchTargets()[Symbol.asyncIterator]();
  await secondTargetWatcher.next();
  const renewedTarget = await serviceWorker.evaluate(async ({ endpoint: agentEndpoint, pairingCode: code }) => (globalThis as unknown as { recoverPublishedTargetAgentTest: (input: { readonly endpoint: string; readonly pairingCode: string }) => Promise<{ readonly generation: number; readonly id: string }> }).recoverPublishedTargetAgentTest({ endpoint: agentEndpoint, pairingCode: code }), { endpoint: `ws://${secondBridge.host}:${secondBridge.port}/__chrome_debugger_bridge/agent`, pairingCode });
  const recoveredPublication = await secondTargetWatcher.next();
  await serviceWorker.evaluate(async () => (globalThis as unknown as { interruptPublishedTargetAgentTest: () => Promise<void> }).interruptPublishedTargetAgentTest());

  expect(firstBroker.listTargets()).toEqual([]);
  expect(renewedTarget.id).not.toBe(initialTarget.id);
  expect(recoveredPublication).toMatchObject({ done: false, value: { kind: 'published', target: { generation: renewedTarget.generation, id: renewedTarget.id } } });
  expect(secondBroker.listTargets()).toEqual([]);
  expect(initialTarget.generation).toBe(1);
  expect(renewedTarget.generation).toBe(1);
}, 20_000);
