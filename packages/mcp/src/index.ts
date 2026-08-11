import type { CdpEvent, ChromeDebuggerBridgeClient, Lease } from '@dvcol/chrome-debugger-bridge';
import type { JsonObject } from '@dvcol/chrome-debugger-bridge/protocol';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';

import { randomUUID } from 'node:crypto';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

export const supportedMcpProtocolVersions = ['2026-07-28'] as const;
export const supportedMcpSdkVersion = '2.0.0';
const cdpMethodPattern = /^[A-Za-z]+\.[A-Za-z]+$/u;

class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MountMcpStreamableHttpOptions {
  readonly client: McpChromeDebuggerBridgeClient;
  readonly path?: string;
  readonly server: HttpServer;
}

export interface McpChromeDebuggerBridgeClient extends ChromeDebuggerBridgeClient {
  cancelCommand: (request: { readonly operationId: string; readonly targetGeneration: number; readonly targetId: string }) => Promise<void>;
}

export interface MountedMcpStreamableHttp {
  close: () => Promise<void>;
}

function jsonContent(value: unknown): CallToolResult {
  return { content: [{ text: JSON.stringify(value), type: 'text' }] };
}

function toolError(error: unknown): CallToolResult {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'MCP_TOOL_FAILED';
  return { content: [{ text: JSON.stringify({ code }), type: 'text' }], isError: true };
}

const targetInput = {
  targetGeneration: z.number().int().nonnegative(),
  targetId: z.string().uuid(),
};

async function withLease<Value>(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  mode: Lease['mode'],
  requestedMethods: readonly string[],
  action: (lease: Lease) => Promise<Value>,
): Promise<Value> {
  const lease = await client.acquireLease({ durationMilliseconds: 30_000, mode, requestedMethods, targetGeneration: input.targetGeneration, targetId: input.targetId });
  try {
    return await action(lease);
  } finally {
    await client.releaseLease({ leaseId: lease.id, targetGeneration: input.targetGeneration, targetId: input.targetId });
  }
}

async function executeSemanticCommand(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  mode: Lease['mode'],
  method: string,
  parameters: JsonObject,
): Promise<unknown> {
  return withLease(client, input, mode, [method], async lease => client.executeCommand({ leaseId: lease.id, method, operationId: randomUUID(), parameters, targetGeneration: input.targetGeneration, targetId: input.targetId }));
}

async function executeSemanticCommands(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  mode: Lease['mode'],
  commands: readonly { readonly method: string; readonly parameters: JsonObject }[],
): Promise<unknown[]> {
  return withLease(client, input, mode, [...new Set(commands.map(command => command.method))], async (lease) => {
    const results: unknown[] = [];
    for (const command of commands) {
      results.push(await client.executeCommand({
        leaseId: lease.id,
        method: command.method,
        operationId: randomUUID(),
        parameters: command.parameters,
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      }));
    }
    return results;
  });
}

async function waitForEvent(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly method: string; readonly targetGeneration: number; readonly targetId: string; readonly timeoutMilliseconds: number },
  signal: AbortSignal,
): Promise<CdpEvent> {
  return withLease(client, input, 'shared-read', [input.method], async (lease) => {
    const subscription = await client.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: input.method }, targetGeneration: input.targetGeneration, targetId: input.targetId });
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let subscriptionClosed = false;
    const closeSubscription = (): void => {
      if (subscriptionClosed) return;
      subscriptionClosed = true;
      subscription.close();
    };
    const abort = (): void => closeSubscription();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const nextEvent = subscription[Symbol.asyncIterator]().next();
      const expiry = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new McpToolError('MCP_WAIT_TIMEOUT', 'MCP wait timed out.')), input.timeoutMilliseconds);
      });
      const result = await Promise.race([nextEvent, expiry]);
      if (result.done) throw new McpToolError('MCP_WAIT_CANCELLED', 'MCP wait was cancelled.');
      return result.value;
    } finally {
      signal.removeEventListener('abort', abort);
      if (timeout !== undefined) clearTimeout(timeout);
      closeSubscription();
    }
  });
}

function createMcpServer(client: McpChromeDebuggerBridgeClient): McpServer {
  const server = new McpServer({ name: 'chrome-debugger-bridge', version: '0.0.0' });
  server.registerTool('browser.list_targets', { description: 'List opaque published Chrome targets.', inputSchema: z.object({}) }, async () => {
    try {
      return jsonContent(await client.listTargets());
    } catch (error) {
      return toolError(error);
    }
  });
  const leaseInput = {
    durationMilliseconds: z.number().int().positive(),
    targetGeneration: z.number().int().nonnegative(),
    targetId: z.string().uuid(),
  };
  server.registerTool('browser.acquire', { description: 'Acquire an explicit target lease.', inputSchema: z.object({ ...leaseInput, mode: z.enum(['exclusive-control', 'shared-read']).optional(), requestedMethods: z.array(z.string()).min(1) }) }, async (input) => {
    try {
      return jsonContent(await client.acquireLease({
        durationMilliseconds: input.durationMilliseconds,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        requestedMethods: input.requestedMethods,
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      }));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.renew', { description: 'Renew an explicit target lease.', inputSchema: z.object({ ...leaseInput, leaseId: z.string().uuid() }) }, async (input) => {
    try {
      return jsonContent(await client.renewLease(input));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.release', { description: 'Release an explicit target lease.', inputSchema: z.object({ targetGeneration: z.number().int().nonnegative(), targetId: z.string().uuid(), leaseId: z.string().uuid() }) }, async (input) => {
    try {
      await client.releaseLease(input);
      return jsonContent({ released: true });
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.release_artifact', { description: 'Release an authorized artifact through its owning lease.', inputSchema: z.object({ artifactId: z.string().uuid(), targetGeneration: z.number().int().nonnegative(), targetId: z.string().uuid(), leaseId: z.string().uuid() }) }, async (input) => {
    try {
      await client.releaseArtifact(input);
      return jsonContent({ released: true });
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.inspect', { description: 'Evaluate a read-only inspection expression through an authorized lease.', inputSchema: z.object({ expression: z.string().min(1), leaseId: z.string().uuid(), targetGeneration: z.number().int().nonnegative(), targetId: z.string().uuid() }) }, async (input, ctx) => {
    const operationId = randomUUID();
    const abort = (): void => {
      void client.cancelCommand({ operationId, targetGeneration: input.targetGeneration, targetId: input.targetId }).catch(() => {});
    };
    ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
    try {
      return jsonContent(await client.executeCommand({ leaseId: input.leaseId, method: 'Runtime.evaluate', operationId, parameters: { expression: input.expression, returnByValue: true }, targetGeneration: input.targetGeneration, targetId: input.targetId }));
    } catch (error) {
      return toolError(error);
    } finally {
      ctx.mcpReq.signal.removeEventListener('abort', abort);
    }
  });
  server.registerTool('browser.snapshot', { description: 'Capture a structural DOM snapshot through a read lease.', inputSchema: z.object(targetInput) }, async (input) => {
    try {
      return jsonContent(await executeSemanticCommand(client, input, 'shared-read', 'DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: true, includePaintOrder: true }));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.screenshot', { description: 'Capture a screenshot, returning the bridge inline-or-artifact result without base64 expansion.', inputSchema: z.object({ ...targetInput, format: z.enum(['jpeg', 'png', 'webp']).default('png') }) }, async (input) => {
    try {
      const result = await executeSemanticCommand(client, input, 'shared-read', 'Page.captureScreenshot', { format: input.format });
      return jsonContent((result as { readonly value: unknown }).value);
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.network_body', { description: 'Read a network response body, returning the bridge inline-or-artifact result without base64 expansion.', inputSchema: z.object({ ...targetInput, requestId: z.string().min(1) }) }, async (input) => {
    try {
      const result = await executeSemanticCommand(client, input, 'shared-read', 'Network.getResponseBody', { requestId: input.requestId });
      return jsonContent((result as { readonly value: unknown }).value);
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.evaluate', { description: 'Evaluate a read-only expression through a read lease.', inputSchema: z.object({ ...targetInput, expression: z.string().min(1) }) }, async (input) => {
    try {
      return jsonContent(await executeSemanticCommand(client, input, 'shared-read', 'Runtime.evaluate', { expression: input.expression, returnByValue: true }));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.navigate', { description: 'Navigate an authorized target through an exclusive lease.', inputSchema: z.object({ ...targetInput, url: z.url() }) }, async (input) => {
    try {
      return jsonContent(await executeSemanticCommand(client, input, 'exclusive-control', 'Page.navigate', { url: input.url }));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.click', { description: 'Dispatch an explicit click through an exclusive lease.', inputSchema: z.object({ ...targetInput, x: z.number().nonnegative(), y: z.number().nonnegative() }) }, async (input) => {
    try {
      return jsonContent(await executeSemanticCommands(client, input, 'exclusive-control', [
        { method: 'Input.dispatchMouseEvent', parameters: { button: 'left', clickCount: 1, type: 'mousePressed', x: input.x, y: input.y } },
        { method: 'Input.dispatchMouseEvent', parameters: { button: 'left', clickCount: 1, type: 'mouseReleased', x: input.x, y: input.y } },
      ]));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.type', { description: 'Insert text through an exclusive lease.', inputSchema: z.object({ ...targetInput, text: z.string().min(1) }) }, async (input) => {
    try {
      return jsonContent(await executeSemanticCommand(client, input, 'exclusive-control', 'Input.insertText', { text: input.text }));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.press', { description: 'Dispatch a key through an exclusive lease.', inputSchema: z.object({ ...targetInput, key: z.string().min(1) }) }, async (input) => {
    try {
      return jsonContent(await executeSemanticCommands(client, input, 'exclusive-control', [
        { method: 'Input.dispatchKeyEvent', parameters: { key: input.key, text: input.key, type: 'keyDown' } },
        { method: 'Input.dispatchKeyEvent', parameters: { key: input.key, type: 'keyUp' } },
      ]));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.console', { description: 'Wait for one console event through a bounded read subscription.', inputSchema: z.object({ ...targetInput, timeoutMilliseconds: z.number().int().positive().max(30_000).default(5_000) }) }, async (input, ctx) => {
    try {
      return jsonContent(await waitForEvent(client, { ...input, method: 'Runtime.consoleAPICalled' }, ctx.mcpReq.signal));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.network', { description: 'Wait for one network event through a bounded read subscription.', inputSchema: z.object({ ...targetInput, timeoutMilliseconds: z.number().int().positive().max(30_000).default(5_000) }) }, async (input, ctx) => {
    try {
      return jsonContent(await waitForEvent(client, { ...input, method: 'Network.responseReceived' }, ctx.mcpReq.signal));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.wait_for', { description: 'Wait for an explicitly named CDP event through a bounded read subscription.', inputSchema: z.object({ ...targetInput, method: z.string().regex(cdpMethodPattern), timeoutMilliseconds: z.number().int().positive().max(30_000).default(5_000) }) }, async (input, ctx) => {
    try {
      return jsonContent(await waitForEvent(client, input, ctx.mcpReq.signal));
    } catch (error) {
      return toolError(error);
    }
  });
  return server;
}

/** Mounts the official MCP SDK Streamable HTTP transport without taking ownership of the broker or HTTP server. */
export function mountMcpStreamableHttp(options: MountMcpStreamableHttpOptions): MountedMcpStreamableHttp {
  const path = options.path ?? '/mcp';
  const handler = createMcpHandler(() => createMcpServer(options.client), { legacy: 'reject', responseMode: 'sse' });
  const nodeHandler = toNodeHandler(handler);
  let closed = false;
  const listener = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closed || new URL(request.url ?? '/', 'http://localhost').pathname !== path) return;
    await nodeHandler(request as never, response);
  };
  options.server.on('request', listener);
  return {
    async close() {
      if (closed) return;
      closed = true;
      options.server.off('request', listener);
      await handler.close();
    },
  };
}
