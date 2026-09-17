import type { WebMcpToolList, WebMcpToolResult } from '@dvcol/cdb';

import type { NativeMcpHarness } from './fixtures/native-mcp-harness.js';

import { afterEach, expect, it } from 'vitest';

import { createNativeMcpHarness, toolText } from './fixtures/native-mcp-harness.js';

interface NativeModelContext {
  registerTool: (tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (input: { value?: string }) => Promise<string>;
  }, options: { signal: AbortSignal }) => Promise<void>;
}

let harness: NativeMcpHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Native registration is fixture setup; every agent operation uses the public MCP transport. */
it('discovers and invokes a native main-document tool through the real extension debugger', async () => {
  expect.assertions(9);
  harness = await createNativeMcpHarness({ frames: 'same-origin', browserArguments: ['--enable-experimental-web-platform-features'] });
  const secureFixture = new URL(harness.fixtureUrl);
  secureFixture.hostname = '127.0.0.1';
  await harness.page.goto(secureFixture.href);
  await harness.page.evaluate(async () => {
    const modelContext = (document as Document & { modelContext?: NativeModelContext }).modelContext;
    if (modelContext === undefined) throw new Error('This Chromium build does not expose native document.modelContext.');
    await modelContext.registerTool({
      name: 'set_fixture_value',
      description: 'Set the fixture value.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      async execute(input) {
        document.documentElement.dataset.webmcpValue = input.value;
        return JSON.stringify({ value: input.value });
      },
    }, { signal: new AbortController().signal });
    const iframe = document.createElement('iframe');
    iframe.srcdoc = '<!doctype html><title>WebMCP child</title>';
    const loaded = new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
    });
    document.body.append(iframe);
    await loaded;
    const childContext = (iframe.contentDocument as Document & { modelContext: NativeModelContext }).modelContext;
    await childContext.registerTool({ name: 'child_only', description: 'Iframe tool', inputSchema: { type: 'object' }, execute: async () => 'child' }, { signal: new AbortController().signal });
  });

  const listed = await harness.mcpClient.callTool({ name: 'browser.list_webmcp_tools', arguments: { targetRef: harness.targetRef } });
  expect(listed.isError, toolText(listed)).toBeUndefined();
  const catalogue = JSON.parse(toolText(listed)) as WebMcpToolList;
  expect(catalogue.tools.map(tool => tool.name)).toEqual(['set_fixture_value']);
  const invoked = await harness.mcpClient.callTool({ name: 'browser.invoke_webmcp_tools', arguments: { targetRef: harness.targetRef, toolRef: catalogue.tools[0]!.toolRef, input: { value: 'native proof' } } });
  expect(invoked.isError, toolText(invoked)).toBeUndefined();
  expect(JSON.parse(toolText(invoked)) as WebMcpToolResult).toEqual({ status: 'completed', output: { value: 'native proof' } });
  expect(await harness.page.locator('html').getAttribute('data-webmcp-value')).toBe('native proof');

  const exported = await harness.mcpClient.listTools();
  expect(exported.tools.some(tool => tool.name === 'set_fixture_value')).toBe(false);
  await harness.page.reload();
  const stale = await harness.mcpClient.callTool({ name: 'browser.invoke_webmcp_tools', arguments: { targetRef: harness.targetRef, toolRef: catalogue.tools[0]!.toolRef, input: { value: 'replay' } } });
  expect(toolText(stale)).toContain('WEBMCP_TOOL_STALE');
  const empty = await harness.mcpClient.callTool({ name: 'browser.list_webmcp_tools', arguments: { targetRef: harness.targetRef } });
  expect(empty.isError, toolText(empty)).toBeUndefined();
  expect((JSON.parse(toolText(empty)) as WebMcpToolList).tools).toEqual([]);
}, 90_000);
