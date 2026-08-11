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
  expect.assertions(5);
  const server = createServer();
  const bridgeClient = {
    async cancelCommand() {},
    async listTargets() {
      return [target];
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
    expect(supportedMcpSdkVersion).toBe('2.0.0');
    expect(supportedMcpProtocolVersions).toEqual(['2026-07-28']);
  } finally {
    await transport.terminateSession();
    await mounted.close();
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  }
});
