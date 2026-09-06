import type { BrowserContext, Frame, Page } from 'playwright';

import type { PublishedTarget } from '../../../packages/core/src/protocol.js';
import type { NodeChromeDebuggerBridgeClient, StandaloneChromeDebuggerBridgeHost } from '../../../packages/websocket/src/node.js';
import type { DeepDomProfile } from './deep-dom-page.js';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { chromium } from 'playwright';
import { build } from 'vite';

import { registerCdbTools } from '../../../packages/mcp/src/index.js';
import { createNodeChromeDebuggerBridgeClient, createStandaloneChromeDebuggerBridgeHost } from '../../../packages/websocket/src/node.js';
import { deepDomPage } from './deep-dom-page.js';

interface FixtureWorker {
  runPublishedTargetAgentTest: (input: { readonly endpoint: string; readonly pairingCode: string }) => Promise<Pick<PublishedTarget, 'generation' | 'id'>>;
  revokePublishedTargetAgentTest: () => Promise<void>;
  readPublishedTargetConnectionClose: () => Promise<{ readonly code: number; readonly reason: string } | null>;
}

export interface NativeMcpHarness {
  readonly client: NodeChromeDebuggerBridgeClient;
  readonly context: BrowserContext;
  readonly fixtureUrl: string;
  readonly host: StandaloneChromeDebuggerBridgeHost;
  readonly leafFrame: Frame;
  readonly mcpClient: Client;
  readonly page: Page;
  readonly target: Pick<PublishedTarget, 'generation' | 'id'>;
  readonly targetRef: string;
  close: () => Promise<void>;
  revoke: () => Promise<void>;
}

/** Exercises the public extension, authenticated transports, broker, and native MCP catalogue. */
export async function createNativeMcpHarness(options: { readonly frames?: 'cross-origin' | 'same-origin'; readonly inlineResultBytes?: number; readonly mcpModule?: string; readonly profile?: DeepDomProfile; readonly shadow?: 'closed' | 'mixed' | 'open' } = {}): Promise<NativeMcpHarness> {
  const cleanups: Array<() => Promise<unknown>> = [];
  const close = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'The fixture failed to dispose.');
  };
  try {
    const pageServer = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(deepDomPage(new URL(request.url ?? '/', `http://${request.headers.host}`)));
    });
    await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => new Promise<void>((resolve, reject) => pageServer.close(error => error === undefined ? resolve() : reject(error))));
    const address = pageServer.address();
    if (address === null || typeof address === 'string') throw new Error('The fixture server has no TCP address.');
    let pairingCode = '';
    let grantedTarget: Pick<PublishedTarget, 'generation' | 'id'> | undefined;
    const host = await createStandaloneChromeDebuggerBridgeHost({
      ...(options.inlineResultBytes === undefined ? {} : { maximumInlineResultBytes: options.inlineResultBytes }),
      clientAuthentication: { async authenticate(input) {
        return input.authorization === 'Bearer public-fixture-client' ? { id: 'public-fixture-client', role: 'client' as const } : undefined;
      } },
      onPairingPresentation(presentation) {
        pairingCode = presentation.code;
      },
      resolveClientAuthority({ connectionId, principal }) {
        return {
          connectionId,
          principalId: principal.id,
          targetGrants: grantedTarget === undefined
            ? []
            : [{
                bindingId: 'public-fixture-grant',
                capabilities: { level: 'interact' },
                targetGeneration: grantedTarget.generation,
                targetId: grantedTarget.id,
              }],
        };
      },
      webSocketLimits: { maximumMessageBytes: 64 * 1_024 * 1_024 },
    });
    cleanups.push(async () => host.dispose());
    const extensionDirectory = await mkdtemp(join(tmpdir(), 'cdb-public-fixture-extension-'));
    const profileDirectory = await mkdtemp(join(tmpdir(), 'cdb-public-fixture-profile-'));
    cleanups.push(async () => rm(extensionDirectory, { force: true, recursive: true }));
    cleanups.push(async () => rm(profileDirectory, { force: true, recursive: true }));
    await build({ build: { emptyOutDir: true, lib: { entry: resolve('tests/e2e/fixtures/authenticated-service-worker.ts'), fileName: () => 'service-worker.js', formats: ['es'] }, outDir: extensionDirectory }, configFile: false, logLevel: 'silent' });
    await writeFile(join(extensionDirectory, 'manifest.json'), JSON.stringify({
      background: { service_worker: 'service-worker.js', type: 'module' },
      manifest_version: 3,
      name: 'CDB public native MCP fixture',
      permissions: ['debugger', 'storage', 'tabs'],
      version: '0.0.0',
    }));
    const context = await chromium.launchPersistentContext(profileDirectory, {
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--site-per-process', '--host-resolver-rules=MAP *.test 127.0.0.1', '--no-proxy-server'],
      channel: 'chromium',
      headless: true,
      viewport: { height: 900, width: 1280 },
    });
    cleanups.push(async () => context.close());
    const page = await context.newPage();
    const fixtureUrl = `http://cdb-root.test:${address.port}/?profile=${options.profile ?? 'normal'}&shadow=${options.shadow ?? 'closed'}&frames=${options.frames ?? 'cross-origin'}`;
    await page.goto(fixtureUrl);
    const leafFrame = page.frames().find(frame => new URL(frame.url()).searchParams.get('frame') === '3');
    if (leafFrame === undefined) throw new Error('The nested cross-origin fixture did not load.');
    await leafFrame.waitForSelector('html[data-fixture-ready="true"]');
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    grantedTarget = await worker.evaluate(async input => (globalThis as unknown as FixtureWorker).runPublishedTargetAgentTest(input), { endpoint: host.agentEndpoint, pairingCode });
    const publicationDeadline = Date.now() + 5_000;
    while (!host.broker.listTargets().some(target => target.id === grantedTarget?.id)) {
      if (Date.now() >= publicationDeadline) {
        const closed = await worker.evaluate(async () => (globalThis as unknown as FixtureWorker).readPublishedTargetConnectionClose());
        throw new Error(`The extension did not publish its target to the broker: ${JSON.stringify(closed)}.`);
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const client = await createNodeChromeDebuggerBridgeClient({ artifactEndpoint: host.artifactEndpoint, authorization: 'Bearer public-fixture-client', endpoint: host.clientEndpoint });
    cleanups.push(async () => {
      client.dispose();
      await client.closed;
    });
    const mcpServer = new McpServer({ name: 'public-native-fixture', version: '0.0.0' });
    const registerTools = options.mcpModule === undefined ? registerCdbTools : (await import(pathToFileURL(options.mcpModule).href) as { readonly registerCdbTools: typeof registerCdbTools }).registerCdbTools;
    registerTools(mcpServer, { client });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'public-fixture-agent', version: '0.0.0' });
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    cleanups.push(async () => {
      await mcpClient.close();
      await mcpServer.close();
    });
    const targets = await mcpClient.callTool({ arguments: {}, name: 'browser.list_targets' });
    const targetContent = targets.content[0];
    if (targetContent?.type !== 'text') throw new Error('The fixture target list is not text.');
    const targetRef = (JSON.parse(targetContent.text) as Array<{ readonly targetRef: string }>)[0]?.targetRef;
    if (targetRef === undefined) throw new Error('The granted fixture target is not visible.');
    return {
      client,
      close,
      context,
      fixtureUrl,
      host,
      leafFrame,
      mcpClient,
      page,
      target: grantedTarget,
      targetRef,
      async revoke() {
        await worker.evaluate(async () => (globalThis as unknown as FixtureWorker).revokePublishedTargetAgentTest());
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n');
}
