import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createEmbeddedChromeDebuggerBridge } from '@dvcol/cdb';
import { mountMcpStdio, mountMcpStreamableHttp, supportedMcpProtocolVersions, supportedMcpSdkVersion } from '@dvcol/cdb-mcp';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const target = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
};

async function main() {
  const bridge = createEmbeddedChromeDebuggerBridge();
  const httpServer = createServer();
  let stdioClosed = false;
  let stdioStarted = false;
  let startCancellation;
  const cancellationStarted = new Promise((resolve) => {
    startCancellation = resolve;
  });

  bridge.broker.publishTarget(target);
  bridge.registerTargetExecutor(target, {
    async execute(command, abortSignal) {
      if (command.method === 'Runtime.evaluate' && command.parameters?.expression === 'await-cancellation') {
        startCancellation();
        await new Promise((_resolve, reject) => abortSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      }
      if (command.method === 'Page.captureScreenshot') return { data: 'A'.repeat(70_000) };
      return { method: command.method };
    },
  });

  const bridgeClient = {
    ...bridge.client,
    async cancelCommand({ operationId }) {
      bridge.broker.cancelCommand(operationId);
    },
  };
  const mountedHttp = mountMcpStreamableHttp({ client: bridgeClient, path: '/mcp', server: httpServer });
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

  await new Promise((resolve, reject) => {
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
    assert.equal(tools.tools.some(tool => tool.name === 'browser.raw_cdp'), false);
    assert.deepEqual(JSON.parse((await client.callTool({ arguments: {}, name: 'browser.list_targets' })).content[0].text), [target]);

    const inspectionLease = JSON.parse((await client.callTool({ arguments: { durationMilliseconds: 30_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }, name: 'browser.acquire' })).content[0].text);
    assert.equal(JSON.parse((await client.callTool({ arguments: { expression: 'document.title', leaseId: inspectionLease.id, targetGeneration: target.generation, targetId: target.id }, name: 'browser.inspect' })).content[0].text).value.method, 'Runtime.evaluate');
    await client.callTool({ arguments: { leaseId: inspectionLease.id, targetGeneration: target.generation, targetId: target.id }, name: 'browser.release' });

    assert.equal(JSON.parse((await client.callTool({ arguments: { targetGeneration: target.generation, targetId: target.id, url: 'https://example.test/' }, name: 'browser.navigate' })).content[0].text).value.method, 'Page.navigate');
    const screenshot = JSON.parse((await client.callTool({ arguments: { targetGeneration: target.generation, targetId: target.id }, name: 'browser.screenshot' })).content[0].text);
    assert.equal(typeof screenshot.artifact.id, 'string');
    const artifact = JSON.parse((await client.callTool({ arguments: { artifactId: screenshot.artifact.id, leaseId: screenshot.lease.id, maximumBytes: 8, targetGeneration: target.generation, targetId: target.id }, name: 'browser.read_artifact' })).content[0].text);
    assert.equal(artifact.bytes.length, 12);
    await client.callTool({ arguments: { artifactId: screenshot.artifact.id, leaseId: screenshot.lease.id, targetGeneration: target.generation, targetId: target.id }, name: 'browser.release_artifact' });
    await client.callTool({ arguments: { leaseId: screenshot.lease.id, targetGeneration: target.generation, targetId: target.id }, name: 'browser.release' });

    const cancellationLease = JSON.parse((await client.callTool({ arguments: { durationMilliseconds: 30_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }, name: 'browser.acquire' })).content[0].text);
    const cancellation = new AbortController();
    const cancelledInspection = client.callTool({ arguments: { expression: 'await-cancellation', leaseId: cancellationLease.id, targetGeneration: target.generation, targetId: target.id }, name: 'browser.inspect' }, { signal: cancellation.signal });
    await cancellationStarted;
    cancellation.abort();
    await assert.rejects(cancelledInspection);
    await client.callTool({ arguments: { leaseId: cancellationLease.id, targetGeneration: target.generation, targetId: target.id }, name: 'browser.release' });
    assert.equal(stdioStarted, true);
  } finally {
    await transport.terminateSession();
    await mountedHttp.close();
    await mountedStdio.close();
    await new Promise((resolve, reject) => httpServer.close(error => error === undefined ? resolve() : reject(error)));
    bridge.dispose();
  }

  assert.equal(stdioClosed, true);
}

void main();
