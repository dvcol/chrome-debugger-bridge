import type { JsonObject, WebMcpToolList } from '@dvcol/cdb';

import type { WebMcpController, WebMcpOptions } from '../src/webmcp.js';

import { webMcpMethods } from '@dvcol/cdb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebMcpController, validateWebMcpOptions } from '../src/webmcp.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

function harness(policy?: WebMcpOptions, maximumResultBytes = 16_777_216) {
  const state = {
    tools: [{ name: 'search', description: 'Search products', frameId: 'main', inputSchema: { type: 'object' }, annotations: { readOnly: true } }] as JsonObject[],
    loaderId: 'document-1',
    unsupported: false,
    completeImmediately: true,
    output: null as import('@dvcol/cdb').JsonValue,
    lastInvocation: '',
  };
  const dispatched = Promise.withResolvers<void>();
  let controller: WebMcpController;
  const sendCommand = vi.fn(async (method: string, _parameters?: JsonObject): Promise<JsonObject> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: state.loaderId, url: 'https://example.com/' } } };
    if (method === 'WebMCP.enable') {
      if (state.unsupported) throw new Error('Method not found');
      if (state.tools.length > 0) controller.event('WebMCP.toolsAdded', { tools: state.tools });
    }
    if (method === 'WebMCP.invokeTool') {
      state.lastInvocation = crypto.randomUUID();
      dispatched.resolve();
      if (state.completeImmediately) controller.event('WebMCP.toolResponded', { invocationId: state.lastInvocation, status: 'Completed', output: state.output });
      return { invocationId: state.lastInvocation };
    }
    return {};
  });
  controller = createWebMcpController({ target: { id: crypto.randomUUID(), generation: 1 }, maximumResultBytes, sendCommand, ...(policy === undefined ? {} : { policy }) });
  disposals.push(controller.dispose);
  return {
    controller,
    dispatched: dispatched.promise,
    sendCommand,
    state,
    list: async (signal = new AbortController().signal) => controller.execute(webMcpMethods.list, {}, signal) as unknown as Promise<WebMcpToolList>,
    invoke: async (parameters: JsonObject, signal = new AbortController().signal) => controller.execute(webMcpMethods.invoke, parameters, signal),
  };
}

describe('native main-document WebMCP', () => {
  it('lists native descriptors while excluding same-process iframe registrations', async () => {
    expect.assertions(4);
    const fixture = harness();
    fixture.state.tools.push({ name: 'frame_tool', frameId: 'child', description: 'iframe' });
    const result = await fixture.list();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({ name: 'search', inputSchema: { type: 'object' }, annotations: { readOnly: true } });
    expect(result.tools[0]).not.toHaveProperty('frameId');
    expect(fixture.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.getFrameTree', 'WebMCP.enable', 'Page.getFrameTree']);
  });

  it('completes an empty catalogue without waiting for a registration event', async () => {
    expect.assertions(2);
    const fixture = harness();
    fixture.state.tools = [];
    expect(await fixture.list()).toMatchObject({ tools: [], enabled: true });
    fixture.state.unsupported = true;
    await fixture.controller.setActive(false);
    await expect(fixture.list()).rejects.toMatchObject({ code: 'FEATURE_UNSUPPORTED', retryable: false });
  });

  it('reevaluates inclusion and exclusion callbacks without making hidden tools uncallable', async () => {
    expect.assertions(4);
    let hidden = true;
    const fixture = harness({ discovery: { include: ['search'], exclude: [({ tool }) => hidden && tool.inputSchema?.type === 'object'] } });
    expect((await fixture.list()).tools).toEqual([]);
    expect(await fixture.invoke({ toolName: 'search', input: {} })).toEqual({ status: 'completed', output: null });
    hidden = false;
    const listed = await fixture.list();
    expect(listed.tools).toHaveLength(1);
    fixture.state.output = 'plain text';
    expect(await fixture.invoke({ toolRef: listed.tools[0]!.toolRef, input: {} })).toEqual({ status: 'completed', output: 'plain text' });
  });

  it('does not mutate stateful regexes and lets exclusions win', async () => {
    expect.assertions(3);
    const pattern = /search/g;
    pattern.lastIndex = 3;
    const fixture = harness({ discovery: { include: [pattern], exclude: [/search/u] } });
    expect((await fixture.list()).tools).toEqual([]);
    expect((await fixture.list()).tools).toEqual([]);
    expect(pattern.lastIndex).toBe(3);
  });

  it('keeps disabled discovery separate from invocation and surfaces callback failures', async () => {
    expect.assertions(4);
    const fixture = harness({ discovery: { enabled: false } });
    expect(await fixture.list()).toMatchObject({ tools: [], enabled: false });
    expect(await fixture.invoke({ toolName: 'search', input: {} })).toMatchObject({ status: 'completed' });
    const failing = harness({ discovery: { enabled: () => {
      throw new Error('host policy unavailable');
    } } });
    await expect(failing.list()).rejects.toMatchObject({ code: 'WEBMCP_DISCOVERY_FAILED' });
    expect(() => validateWebMcpOptions({ discovery: { exclude: [123] } } as unknown as WebMcpOptions)).toThrow(TypeError);
  });

  it('rejects old document references even without a navigation event', async () => {
    expect.assertions(3);
    const fixture = harness();
    const first = await fixture.list();
    fixture.state.loaderId = 'document-2';
    await expect(fixture.invoke({ toolRef: first.tools[0]!.toolRef, input: {} })).rejects.toMatchObject({ code: 'WEBMCP_TOOL_STALE', retryable: true });
    expect(fixture.sendCommand.mock.calls.some(([method]) => method === 'WebMCP.invokeTool')).toBe(false);
    expect((await fixture.list()).documentRef).not.toBe(first.documentRef);
  });

  it('retains document references while domain demand is released and reacquired', async () => {
    expect.assertions(2);
    const fixture = harness();
    const first = await fixture.list();
    await fixture.controller.setActive(false);
    expect((await fixture.list()).tools[0]!.toolRef).toBe(first.tools[0]!.toolRef);
    fixture.controller.event('WebMCP.toolsRemoved', { tools: [{ name: 'search', frameId: 'main' }] });
    await expect(fixture.invoke({ toolRef: first.tools[0]!.toolRef, input: {} })).rejects.toMatchObject({ code: 'WEBMCP_TOOL_STALE' });
  });

  it('correlates completion and ignores another invocation result', async () => {
    expect.assertions(2);
    const fixture = harness();
    fixture.state.completeImmediately = false;
    const invocation = fixture.invoke({ toolName: 'search', input: {} });
    await fixture.dispatched;
    fixture.controller.event('WebMCP.toolResponded', { invocationId: 'foreign', status: 'Completed', output: 'foreign' });
    fixture.controller.event('WebMCP.toolResponded', { invocationId: fixture.state.lastInvocation, status: 'Completed', output: [1, true, null] });
    expect(await invocation).toEqual({ status: 'completed', output: [1, true, null] });
    expect(fixture.sendCommand.mock.calls.filter(([method]) => method === 'WebMCP.invokeTool')).toHaveLength(1);
  });

  it('cancels a dispatched tool without claiming its effects were rolled back', async () => {
    expect.assertions(3);
    const fixture = harness();
    fixture.state.completeImmediately = false;
    const cancellation = new AbortController();
    const invocation = fixture.invoke({ toolName: 'search', input: {} }, cancellation.signal);
    const rejected = expect(invocation).rejects.toMatchObject({ code: 'WEBMCP_OUTCOME_UNKNOWN', retryable: false });
    await fixture.dispatched;
    cancellation.abort();
    await rejected;
    expect(fixture.sendCommand).toHaveBeenCalledWith('WebMCP.cancelInvocation', { invocationId: fixture.state.lastInvocation });
    expect(fixture.sendCommand.mock.calls.filter(([method]) => method === 'WebMCP.invokeTool')).toHaveLength(1);
  });

  it('fences a result when the main document navigates during execution', async () => {
    expect.assertions(2);
    const fixture = harness();
    fixture.state.completeImmediately = false;
    const invocation = fixture.invoke({ toolName: 'search', input: {} });
    const rejected = expect(invocation).rejects.toMatchObject({ code: 'WEBMCP_OUTCOME_UNKNOWN' });
    await fixture.dispatched;
    fixture.controller.event('Page.frameNavigated', { frame: { id: 'main', loaderId: 'new-document' } });
    await rejected;
    expect(fixture.sendCommand).toHaveBeenCalledWith('WebMCP.cancelInvocation', { invocationId: fixture.state.lastInvocation });
  });

  it('cancels waiting on a host callback and rejects incomplete native catalogues', async () => {
    expect.assertions(2);
    const callbackStarted = Promise.withResolvers<void>();
    const callbackResult = Promise.withResolvers<boolean>();
    const fixture = harness({ discovery: { enabled: async () => {
      callbackStarted.resolve();
      return callbackResult.promise;
    } } });
    const cancellation = new AbortController();
    const listing = fixture.list(cancellation.signal);
    const rejected = expect(listing).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    await callbackStarted.promise;
    cancellation.abort();
    await rejected;
    callbackResult.resolve(true);
    const bounded = harness(undefined, 8);
    await expect(bounded.list()).rejects.toMatchObject({ code: 'WEBMCP_DISCOVERY_FAILED' });
  });
  it('rejects malformed selectors and oversized early completions without dispatch replay', async () => {
    expect.assertions(5);
    const fixture = harness(undefined, 512);
    await expect(fixture.invoke({ toolName: 'search', toolRef: 123, input: {} })).rejects.toMatchObject({ code: 'CDP_COMMAND_FAILED' });
    await expect(fixture.invoke({ toolName: 'search', frameId: 'child', input: {} })).rejects.toMatchObject({ code: 'CDP_COMMAND_FAILED' });
    expect(fixture.sendCommand.mock.calls.filter(([method]) => method === 'WebMCP.invokeTool')).toHaveLength(0);
    fixture.state.output = 'x'.repeat(1_000);
    await expect(fixture.invoke({ toolName: 'search', input: {} })).rejects.toMatchObject({ code: 'WEBMCP_OUTCOME_UNKNOWN' });
    expect(fixture.sendCommand.mock.calls.filter(([method]) => method === 'WebMCP.invokeTool')).toHaveLength(1);
  });

  it('does not let policy callbacks mutate native schema metadata', async () => {
    expect.assertions(1);
    let mutate = true;
    const fixture = harness({ discovery: { exclude: [({ tool }) => {
      if (mutate && tool.inputSchema !== undefined) tool.inputSchema.type = 'string';
      return false;
    }] } });
    await fixture.list();
    mutate = false;
    expect((await fixture.list()).tools[0]?.inputSchema).toEqual({ type: 'object' });
  });
  it('does not claim a native transport rejection means that no side effect occurred', async () => {
    expect.assertions(1);
    const fixture = harness();
    const nativePort = fixture.sendCommand.getMockImplementation()!;
    fixture.sendCommand.mockImplementation(async (method, parameters) => {
      if (method === 'WebMCP.invokeTool') throw new Error('Debugger transport closed after send');
      return nativePort(method, parameters);
    });
    await expect(fixture.invoke({ toolName: 'search', input: {} })).rejects.toMatchObject({ code: 'WEBMCP_OUTCOME_UNKNOWN', retryable: false });
  });
});
