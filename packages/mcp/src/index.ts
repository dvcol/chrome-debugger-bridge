import type { ChromeDebuggerBridgeClient } from '@dvcol/chrome-debugger-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';

import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

export const supportedMcpProtocolVersions = ['2025-03-26', '2025-06-18', '2025-11-25'] as const;
export const supportedMcpSdkVersion = '1.30.0';

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

interface Session {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

function jsonContent(value: unknown): CallToolResult {
  return { content: [{ text: JSON.stringify(value), type: 'text' }] };
}

function toolError(error: unknown): CallToolResult {
  return { content: [{ text: JSON.stringify({ code: error instanceof Error ? error.name : 'MCP_TOOL_FAILED' }), type: 'text' }], isError: true };
}

function createMcpServer(client: McpChromeDebuggerBridgeClient): McpServer {
  const server = new McpServer({ name: 'chrome-debugger-bridge', version: '0.0.0' });
  server.registerTool('browser.list_targets', { description: 'List opaque published Chrome targets.', inputSchema: {} }, async () => {
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
  server.registerTool('browser.acquire', { description: 'Acquire an explicit target lease.', inputSchema: { ...leaseInput, mode: z.enum(['exclusive-control', 'shared-read']).optional(), requestedMethods: z.array(z.string()).min(1) } }, async (input) => {
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
  server.registerTool('browser.renew', { description: 'Renew an explicit target lease.', inputSchema: { ...leaseInput, leaseId: z.string().uuid() } }, async (input) => {
    try {
      return jsonContent(await client.renewLease(input));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.release', { description: 'Release an explicit target lease.', inputSchema: { targetGeneration: z.number().int().nonnegative(), targetId: z.string().uuid(), leaseId: z.string().uuid() } }, async (input) => {
    try {
      await client.releaseLease(input);
      return jsonContent({ released: true });
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool('browser.inspect', { description: 'Evaluate a read-only inspection expression through an authorized lease.', inputSchema: { expression: z.string().min(1), leaseId: z.string().uuid(), targetGeneration: z.number().int().nonnegative(), targetId: z.string().uuid() } }, async (input, extra) => {
    const operationId = randomUUID();
    const abort = (): void => {
      void client.cancelCommand({ operationId, targetGeneration: input.targetGeneration, targetId: input.targetId }).catch(() => {});
    };
    extra.signal?.addEventListener('abort', abort, { once: true });
    try {
      return jsonContent(await client.executeCommand({ leaseId: input.leaseId, method: 'Runtime.evaluate', operationId, parameters: { expression: input.expression, returnByValue: true }, targetGeneration: input.targetGeneration, targetId: input.targetId }));
    } catch (error) {
      return toolError(error);
    } finally {
      extra.signal?.removeEventListener('abort', abort);
    }
  });
  return server;
}

function reject(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'MCP endpoint not found' }));
}

/** Mounts the official MCP SDK Streamable HTTP transport without taking ownership of the broker or HTTP server. */
export function mountMcpStreamableHttp(options: MountMcpStreamableHttpOptions): MountedMcpStreamableHttp {
  const path = options.path ?? '/mcp';
  const sessions = new Map<string, Session>();
  let closed = false;
  const listener = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closed || new URL(request.url ?? '/', 'http://localhost').pathname !== path) return;
    const sessionId = request.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing !== undefined) {
      void existing.transport.handleRequest(request, response).catch(() => reject(response, 500));
      return;
    }
    if (typeof sessionId === 'string' || request.method !== 'POST') {
      reject(response, 400);
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.once('end', async () => {
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        reject(response, 400);
        return;
      }
      if (!isInitializeRequest(message)) {
        reject(response, 400);
        return;
      }
      const server = createMcpServer(options.client);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        onsessioninitialized(initializedSessionId) {
          sessions.set(initializedSessionId, { server, transport });
        },
        sessionIdGenerator: randomUUID,
      });
      await server.connect(transport as never).then(async () => transport.handleRequest(request, response, message)).catch(() => reject(response, 500));
    });
  };
  options.server.on('request', listener);
  return {
    async close() {
      if (closed) return;
      closed = true;
      options.server.off('request', listener);
      await Promise.all(Array.from(sessions.values(), async (session) => {
        await session.server.close();
        await session.transport.close();
      }));
      sessions.clear();
    },
  };
}
