import type { McpChromeDebuggerBridgeClient } from '../src/index.js';

import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';

import { mountMcpStreamableHttp, supportedMcpProtocolVersions, supportedMcpSdkVersion } from '../src/index.js';

const target = {
  availability: 'available',
  capabilities: { level: 'observe' },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
} as const;

it('serves target discovery through the official SDK Streamable HTTP client', async () => {
  expect.assertions(14);
  const server = createServer();
  const acquiredLeases: unknown[] = [];
  const executedMethods: string[] = [];
  const releasedLeases: unknown[] = [];
  let closedSubscriptions = 0;
  const bridgeClient = {
    async cancelCommand() {},
    async acquireLease(request: unknown) {
      acquiredLeases.push(request);
      return { expiresAt: '2030-01-01T00:00:00.000Z', id: '017c10a7-e0af-40ec-879f-cd87dffaf036', mode: 'shared-read' as const, targetGeneration: target.generation, targetId: target.id };
    },
    async executeCommand(command: { readonly method: string }) {
      if (command.method === 'Runtime.evaluate') throw Object.assign(new Error('Denied.'), { code: 'CAPABILITY_DENIED' });
      executedMethods.push(command.method);
      return { operationId: '017c10a7-e0af-40ec-879f-cd87dffaf036', value: { result: { type: 'string', value: command.method } } };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease(request: unknown) {
      releasedLeases.push(request);
    },
    async subscribe() {
      return {
        close() {
          closedSubscriptions += 1;
        },
        droppedCount: 0,
        id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        lastDeliveredSequence: 1,
        overflowed: false,
        targetGeneration: target.generation,
        targetId: target.id,
        async* [Symbol.asyncIterator]() {
          yield { method: 'Runtime.consoleAPICalled', parameters: { type: 'log' }, sequence: 1, subscriptionId: '017c10a7-e0af-40ec-879f-cd87dffaf036', targetGeneration: target.generation, targetId: target.id };
        },
      };
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const mounted = mountMcpStreamableHttp({ client: bridgeClient, path: '/bridge-mcp', server });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/bridge-mcp`));
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(['browser.list_targets', 'browser.acquire', 'browser.renew', 'browser.release', 'browser.inspect', 'browser.snapshot', 'browser.evaluate', 'browser.navigate', 'browser.click', 'browser.type', 'browser.press', 'browser.console', 'browser.network', 'browser.wait_for']);
    const result = await client.callTool({ arguments: {}, name: 'browser.list_targets' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ text: JSON.stringify([target]), type: 'text' }]);
    const snapshot = await client.callTool({ arguments: { targetGeneration: target.generation, targetId: target.id }, name: 'browser.snapshot' });
    expect(snapshot.isError).toBeUndefined();
    const navigation = await client.callTool({ arguments: { targetGeneration: target.generation, targetId: target.id, url: 'https://example.test/' }, name: 'browser.navigate' });
    expect(navigation.isError).toBeUndefined();
    const consoleEvent = await client.callTool({ arguments: { targetGeneration: target.generation, targetId: target.id, timeoutMilliseconds: 100 }, name: 'browser.console' });
    expect(consoleEvent.isError).toBeUndefined();
    const deniedEvaluation = await client.callTool({ arguments: { expression: 'document.title', targetGeneration: target.generation, targetId: target.id }, name: 'browser.evaluate' });
    expect(deniedEvaluation.isError).toBe(true);
    expect(deniedEvaluation.content).toEqual([{ text: JSON.stringify({ code: 'CAPABILITY_DENIED' }), type: 'text' }]);
    expect(acquiredLeases).toMatchObject([{ mode: 'shared-read', requestedMethods: ['DOMSnapshot.captureSnapshot'] }, { mode: 'exclusive-control', requestedMethods: ['Page.navigate'] }, { mode: 'shared-read', requestedMethods: ['Runtime.consoleAPICalled'] }, { mode: 'shared-read', requestedMethods: ['Runtime.evaluate'] }]);
    expect(executedMethods).toEqual(['DOMSnapshot.captureSnapshot', 'Page.navigate']);
    expect(releasedLeases).toHaveLength(4);
    expect(closedSubscriptions).toBe(1);
    expect(supportedMcpSdkVersion).toBe('2.0.0');
    expect(supportedMcpProtocolVersions).toEqual(['2026-07-28']);
  } finally {
    await transport.terminateSession();
    await mounted.close();
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  }
});
