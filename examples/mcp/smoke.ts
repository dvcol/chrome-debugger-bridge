import type { PublishedTarget } from '@dvcol/cdb';
import type { McpChromeDebuggerBridgeClient } from '@dvcol/cdb-mcp';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createEmbeddedChromeDebuggerBridge } from '@dvcol/cdb';
import { createPlaywrightAutomationProvider } from '@dvcol/cdb-automation-playwright';
import { createCdbToolSession, mountMcpStdio, mountMcpStreamableHttp, supportedMcpProtocolVersions, supportedMcpSdkVersion } from '@dvcol/cdb-mcp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const target: PublishedTarget = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
};

function requireRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function parseTextResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content[0];
  assert.ok(content?.type === 'text');
  return JSON.parse(content.text) as unknown;
}

async function main(): Promise<void> {
  const bridge = createEmbeddedChromeDebuggerBridge();
  const playwrightAutomationProvider = createPlaywrightAutomationProvider();
  const httpServer = createServer();
  let stdioClosed = false;
  let stdioStarted = false;
  const { promise: cancellationStarted, resolve: startCancellation } = Promise.withResolvers<void>();

  bridge.broker.publishTarget(target);
  bridge.registerTargetExecutor(target, {
    async execute(command, abortSignal) {
      if (command.method === 'Runtime.evaluate' && command.parameters?.expression === 'await-cancellation') {
        startCancellation();
        await new Promise((_resolve, reject) => abortSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      }
      if (command.method === 'Page.navigate')
        bridge.broker.publishEvent(
          target,
          'Page.navigatedWithinDocument',
          { frameId: 'frame-1', navigationType: 'fragment', url: 'https://example.test/#packed-smoke' },
        );
      if (command.method === 'Page.captureScreenshot') return { data: 'A'.repeat(70_000) };
      return { method: command.method };
    },
  });

  const bridgeClient: McpChromeDebuggerBridgeClient = {
    ...bridge.client,
    async cancelCommand({ operationId }) {
      bridge.broker.cancelCommand(operationId);
    },
  };
  const toolSession = createCdbToolSession({ client: bridgeClient });
  assert.equal(
    toolSession.definitions.some(toolDefinition => toolDefinition.name === 'browser.list_targets'),
    true,
  );
  toolSession.dispose();
  const mountedHttp = mountMcpStreamableHttp({
    client: bridgeClient,
    enableRawCdp: true,
    path: '/mcp',
    server: httpServer,
  });
  const mountedStdio = mountMcpStdio({
    client: bridgeClient,
    stdio: {
      transport: {
        async close() {
          stdioClosed = true;
        },
        async send() {},
        async start() {
          stdioStarted = true;
        },
      },
    },
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', resolve);
    httpServer.once('error', reject);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  const client = new Client({ name: 'chrome-debugger-bridge-packed-example', version: '0.0.0' }, { versionNegotiation: { mode: { pin: supportedMcpProtocolVersions[0] } } });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(supportedMcpSdkVersion, '2.0.0');
    assert.deepEqual(supportedMcpProtocolVersions, ['2026-07-28']);
    assert.equal(
      tools.tools.some(tool => tool.name === 'browser.raw_cdp'),
      true,
    );
    const semanticTargets = parseTextResult(await client.callTool({ arguments: {}, name: 'browser.list_targets' }));
    assert.ok(Array.isArray(semanticTargets));
    assert.equal(semanticTargets.length, 1);
    const semanticTarget = requireRecord(semanticTargets[0]);
    assert.equal(semanticTarget.targetRef, 't1');
    assert.equal('generation' in semanticTarget, false);
    const targetRef = semanticTarget.targetRef;
    assert.ok(typeof targetRef === 'string');
    const evaluation = requireRecord(parseTextResult(await client.callTool({
      arguments: { expression: 'document.title', targetRef },
      name: 'browser.evaluate',
    })));
    assert.equal(requireRecord(evaluation.value).method, 'Runtime.evaluate');
    const navigation = requireRecord(parseTextResult(await client.callTool({
      arguments: { targetRef, url: 'https://example.test/' },
      name: 'browser.navigate',
    })));
    assert.equal(requireRecord(navigation.command).method, 'Page.navigate');
    const screenshot = requireRecord(parseTextResult(await client.callTool({
      arguments: { targetRef },
      name: 'browser.screenshot',
    })));
    const artifactId = requireRecord(screenshot.artifact).id;
    const leaseId = requireRecord(screenshot.lease).id;
    assert.ok(typeof artifactId === 'string');
    assert.ok(typeof leaseId === 'string');
    const access = { artifactId, leaseId, targetGeneration: target.generation, targetId: target.id };
    const artifact = requireRecord(parseTextResult(await client.callTool({
      arguments: { ...access, maximumBytes: 8 },
      name: 'browser.read_artifact',
    })));
    assert.ok(typeof artifact.bytes === 'string');
    assert.equal(artifact.bytes.length, 12);
    await client.callTool({ arguments: access, name: 'browser.release_artifact' });
    await client.callTool({ arguments: { leaseId, targetGeneration: target.generation, targetId: target.id }, name: 'browser.release' });

    const cancellation = new AbortController();
    const cancelledInspection = client.callTool(
      {
        arguments: {
          expression: 'await-cancellation',
          targetRef,
        },
        name: 'browser.evaluate',
      },
      { signal: cancellation.signal },
    );
    await cancellationStarted;
    cancellation.abort();
    await assert.rejects(cancelledInspection);
    assert.equal(stdioStarted, true);
  } finally {
    await transport.terminateSession();
    await mountedHttp.close();
    await mountedStdio.close();
    await playwrightAutomationProvider.dispose();
    await new Promise<void>((resolve, reject) => httpServer.close(error => (error === undefined ? resolve() : reject(error))));
    bridge.dispose();
  }

  assert.equal(stdioClosed, true);
}

void main();
