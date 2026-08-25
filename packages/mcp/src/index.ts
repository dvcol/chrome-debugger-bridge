import type { ArtifactAccessRequest, CdpEvent, ChromeDebuggerBridgeClient, Lease } from '@dvcol/cdb';
import type { JsonObject } from '@dvcol/cdb/protocol';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ServeStdioOptions } from '@modelcontextprotocol/server/stdio';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { requiredLeaseMode } from '@dvcol/cdb/cdp-catalogue';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

export const supportedMcpProtocolVersions = ['2026-07-28'] as const;
export const supportedMcpSdkVersion = '2.0.0';
const cdpMethodPattern = /^[A-Za-z]+\.[A-Za-z]+$/u;
const maximumArtifactReadBytes = 49_152;

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
  readonly enableRawCdp?: boolean;
  readonly path?: string;
  readonly server: HttpServer;
}

export interface McpChromeDebuggerBridgeClient extends ChromeDebuggerBridgeClient {
  cancelCommand: (request: { readonly operationId: string; readonly targetGeneration: number; readonly targetId: string }) => Promise<void>;
  readArtifact: (
    request: ArtifactAccessRequest & {
      readonly range?: { readonly length: number; readonly offset: number };
    },
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
}

export interface MountedMcpStreamableHttp {
  close: () => Promise<void>;
}

export interface MountedMcpStdio {
  close: () => Promise<void>;
}

export interface MountMcpStdioOptions extends Pick<MountMcpStreamableHttpOptions, 'client' | 'enableRawCdp'> {
  /** Allows hosts to provide an isolated stdio-compatible transport without coupling it to HTTP lifecycle. */
  readonly stdio?: Omit<ServeStdioOptions, 'legacy'>;
}

/** Registers the canonical CDB tool surface on an application-owned official MCP server. */
export interface RegisterCdbToolsOptions {
  readonly client: McpChromeDebuggerBridgeClient;
  readonly enableRawCdp?: boolean;
}

function jsonContent(value: unknown): CallToolResult {
  return { content: [{ text: JSON.stringify(value), type: 'text' }] };
}

function toolError(error: unknown): CallToolResult {
  const record = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const payload = {
    code: typeof record.code === 'string' ? record.code : 'MCP_TOOL_FAILED',
    message: error instanceof Error ? error.message : 'The browser tool failed.',
    retryable: typeof record.retryable === 'boolean' ? record.retryable : false,
    ...(typeof record.retryAfterMs === 'number' ? { retryAfterMs: record.retryAfterMs } : {}),
    ...(record.details !== null && typeof record.details === 'object' ? { details: record.details } : {}),
  };
  return {
    content: [{ text: JSON.stringify(payload), type: 'text' }],
    isError: true,
  };
}

const targetInput = {
  targetGeneration: z.number().int().nonnegative(),
  targetId: z.string().uuid(),
};

async function withLease<Value>(client: McpChromeDebuggerBridgeClient, input: { readonly targetGeneration: number; readonly targetId: string }, mode: Lease['mode'], requestedMethods: readonly string[], action: (lease: Lease) => Promise<Value>): Promise<Value> {
  const lease = await client.acquireLease({
    durationMilliseconds: 30_000,
    mode,
    requestedMethods,
    targetGeneration: input.targetGeneration,
    targetId: input.targetId,
  });
  try {
    return await action(lease);
  } finally {
    await client.releaseLease({
      leaseId: lease.id,
      targetGeneration: input.targetGeneration,
      targetId: input.targetId,
    });
  }
}

async function executeSemanticCommand(client: McpChromeDebuggerBridgeClient, input: { readonly targetGeneration: number; readonly targetId: string }, mode: Lease['mode'], method: string, parameters: JsonObject, signal?: AbortSignal): Promise<unknown> {
  return withLease(client, input, mode, [method], async (lease) => {
    const operationId = randomUUID();
    const abort = (): void => {
      void client
        .cancelCommand({
          operationId,
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        })
        .catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await client.executeCommand({
        leaseId: lease.id,
        method,
        operationId,
        parameters,
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  });
}

function artifactFromCommandResult(result: unknown): unknown | undefined {
  if (typeof result !== 'object' || result === null || !('value' in result)) return undefined;
  const value = result.value;
  if (typeof value !== 'object' || value === null || !('artifact' in value)) return undefined;
  return value.artifact;
}

async function executeArtifactCommand(client: McpChromeDebuggerBridgeClient, input: { readonly targetGeneration: number; readonly targetId: string }, method: string, parameters: JsonObject): Promise<unknown> {
  const lease = await client.acquireLease({
    durationMilliseconds: 30_000,
    mode: 'shared-read',
    requestedMethods: [method],
    targetGeneration: input.targetGeneration,
    targetId: input.targetId,
  });
  let retainLease = false;
  try {
    const result = await client.executeCommand({
      leaseId: lease.id,
      method,
      operationId: randomUUID(),
      parameters,
      targetGeneration: input.targetGeneration,
      targetId: input.targetId,
    });
    const artifact = artifactFromCommandResult(result);
    if (artifact === undefined) return typeof result === 'object' && result !== null && 'value' in result ? result.value : result;
    retainLease = true;
    return { artifact, lease };
  } finally {
    if (!retainLease)
      await client.releaseLease({
        leaseId: lease.id,
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      });
  }
}

async function executeSemanticCommands(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  mode: Lease['mode'],
  commands: readonly {
    readonly method: string;
    readonly parameters: JsonObject;
  }[],
): Promise<unknown[]> {
  return withLease(client, input, mode, [...new Set(commands.map(command => command.method))], async (lease) => {
    const results: unknown[] = [];
    for (const command of commands) {
      results.push(
        await client.executeCommand({
          leaseId: lease.id,
          method: command.method,
          operationId: randomUUID(),
          parameters: command.parameters,
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        }),
      );
    }
    return results;
  });
}

async function waitForEvent(
  client: McpChromeDebuggerBridgeClient,
  input: {
    readonly leaseId?: string;
    readonly method: string;
    readonly targetGeneration: number;
    readonly targetId: string;
    readonly timeoutMilliseconds: number;
  },
  signal: AbortSignal,
): Promise<CdpEvent> {
  const waitUsingLease = async (leaseId: string): Promise<CdpEvent> => {
    const subscription = await client.subscribe({
      buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
      leaseId,
      match: { method: input.method },
      targetGeneration: input.targetGeneration,
      targetId: input.targetId,
    });
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let retainSubscription = false;
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
      retainSubscription = input.leaseId !== undefined;
      return result.value;
    } finally {
      signal.removeEventListener('abort', abort);
      if (timeout !== undefined) clearTimeout(timeout);
      if (!retainSubscription) closeSubscription();
    }
  };
  if (input.leaseId !== undefined) return waitUsingLease(input.leaseId);
  const target = (await client.listTargets()).find(candidate => candidate.id === input.targetId && candidate.generation === input.targetGeneration);
  const mode = target === undefined ? 'shared-read' : requiredLeaseMode(target.capabilities, [input.method]);
  return withLease(client, input, mode, [input.method], async lease => waitUsingLease(lease.id));
}

export interface CdbToolInvocationContext {
  readonly signal: AbortSignal;
}

export interface CdbToolDefinition {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly mcpInputSchema: z.ZodObject;
  readonly name: string;
  invoke: (input: unknown, context?: CdbToolInvocationContext) => Promise<CallToolResult>;
}

/** Builds the canonical CDB tool catalogue without taking ownership of an MCP server or transport. */
export function createCdbToolDefinitions(options: RegisterCdbToolsOptions): CdbToolDefinition[] {
  const definitions: CdbToolDefinition[] = [];
  const register = <InputSchema extends z.ZodObject>(name: string, config: { readonly description: string; readonly inputSchema: InputSchema }, handler: (input: z.output<InputSchema>, context: { readonly mcpReq: { readonly signal: AbortSignal } }) => Promise<CallToolResult>): void => {
    definitions.push({
      description: config.description,
      inputSchema: z.toJSONSchema(config.inputSchema, { io: 'input' }),
      async invoke(input, context = { signal: new AbortController().signal }) {
        const parsedInput = await config.inputSchema.parseAsync(input);
        return handler(parsedInput, { mcpReq: { signal: context.signal } });
      },
      mcpInputSchema: config.inputSchema,
      name,
    });
  };
  const { client } = options;
  const enableRawCdp = options.enableRawCdp ?? false;
  register(
    'browser.list_targets',
    {
      description: 'List opaque published Chrome targets.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return jsonContent(await client.listTargets());
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const leaseInput = {
    durationMilliseconds: z.number().int().positive(),
    targetGeneration: z.number().int().nonnegative(),
    targetId: z.string().uuid(),
  };
  register(
    'browser.acquire',
    {
      description: 'Acquire an explicit target lease.',
      inputSchema: z.object({
        ...leaseInput,
        mode: z.enum(['exclusive-control', 'shared-read']).optional(),
        requestedMethods: z.array(z.string()).min(1),
      }),
    },
    async (input) => {
      try {
        return jsonContent(
          await client.acquireLease({
            durationMilliseconds: input.durationMilliseconds,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            requestedMethods: input.requestedMethods,
            targetGeneration: input.targetGeneration,
            targetId: input.targetId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.renew',
    {
      description: 'Renew an explicit target lease.',
      inputSchema: z.object({ ...leaseInput, leaseId: z.string().uuid() }),
    },
    async (input) => {
      try {
        return jsonContent(await client.renewLease(input));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.release',
    {
      description: 'Release an explicit target lease.',
      inputSchema: z.object({
        targetGeneration: z.number().int().nonnegative(),
        targetId: z.string().uuid(),
        leaseId: z.string().uuid(),
      }),
    },
    async (input) => {
      try {
        await client.releaseLease(input);
        return jsonContent({ released: true });
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.release_artifact',
    {
      description: 'Release an authorized artifact through its owning lease.',
      inputSchema: z.object({
        artifactId: z.string().uuid(),
        targetGeneration: z.number().int().nonnegative(),
        targetId: z.string().uuid(),
        leaseId: z.string().uuid(),
      }),
    },
    async (input) => {
      try {
        await client.releaseArtifact(input);
        return jsonContent({ released: true });
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.read_artifact',
    {
      description: 'Read one bounded, authorized artifact range as base64.',
      inputSchema: z.object({
        artifactId: z.string().uuid(),
        leaseId: z.string().uuid(),
        maximumBytes: z.number().int().positive().max(maximumArtifactReadBytes).default(maximumArtifactReadBytes),
        offset: z.number().int().nonnegative().default(0),
        targetGeneration: z.number().int().nonnegative(),
        targetId: z.string().uuid(),
      }),
    },
    async (input, ctx) => {
      try {
        const bytes = await client.readArtifact(
          {
            artifactId: input.artifactId,
            leaseId: input.leaseId,
            range: { length: input.maximumBytes, offset: input.offset },
            targetGeneration: input.targetGeneration,
            targetId: input.targetId,
          },
          ctx.mcpReq.signal,
        );
        if (bytes.byteLength > input.maximumBytes) throw new McpToolError('MCP_ARTIFACT_RANGE_INVALID', 'The artifact range exceeded the requested limit.');
        return jsonContent({
          bytes: Buffer.from(bytes).toString('base64'),
          encoding: 'base64',
          offset: input.offset,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.inspect',
    {
      description: 'Evaluate a read-only inspection expression through an authorized lease.',
      inputSchema: z.object({
        expression: z.string().min(1),
        leaseId: z.string().uuid(),
        targetGeneration: z.number().int().nonnegative(),
        targetId: z.string().uuid(),
      }),
    },
    async (input, ctx) => {
      const operationId = randomUUID();
      const abort = (): void => {
        void client
          .cancelCommand({
            operationId,
            targetGeneration: input.targetGeneration,
            targetId: input.targetId,
          })
          .catch(() => {});
      };
      ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
      try {
        return jsonContent(
          await client.executeCommand({
            leaseId: input.leaseId,
            method: 'Runtime.evaluate',
            operationId,
            parameters: { expression: input.expression, returnByValue: true },
            targetGeneration: input.targetGeneration,
            targetId: input.targetId,
          }),
        );
      } catch (error) {
        return toolError(error);
      } finally {
        ctx.mcpReq.signal.removeEventListener('abort', abort);
      }
    },
  );
  if (enableRawCdp)
    register(
      'browser.raw_cdp',
      {
        description: 'Execute a trusted raw CDP command through an explicitly authorized lease.',
        inputSchema: z.object({
          leaseId: z.string().uuid(),
          method: z.string().regex(cdpMethodPattern),
          parameters: z.record(z.string(), z.json()),
          sessionId: z.string().min(1).optional(),
          targetGeneration: z.number().int().nonnegative(),
          targetId: z.string().uuid(),
        }),
      },
      async (input, ctx) => {
        const operationId = randomUUID();
        const abort = (): void => {
          void client
            .cancelCommand({
              operationId,
              targetGeneration: input.targetGeneration,
              targetId: input.targetId,
            })
            .catch(() => {});
        };
        ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
        try {
          return jsonContent(
            await client.executeCommand({
              leaseId: input.leaseId,
              method: input.method,
              operationId,
              parameters: input.parameters,
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
              targetGeneration: input.targetGeneration,
              targetId: input.targetId,
            }),
          );
        } catch (error) {
          return toolError(error);
        } finally {
          ctx.mcpReq.signal.removeEventListener('abort', abort);
        }
      },
    );
  register(
    'browser.snapshot',
    {
      description: 'Capture a structural DOM snapshot through a read lease.',
      inputSchema: z.object(targetInput),
    },
    async (input) => {
      try {
        return jsonContent(
          await executeSemanticCommand(client, input, 'shared-read', 'DOMSnapshot.captureSnapshot', {
            computedStyles: [],
            includeDOMRects: true,
            includePaintOrder: true,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.screenshot',
    {
      description: 'Capture a screenshot, returning the bridge inline-or-artifact result without base64 expansion.',
      inputSchema: z.object({
        ...targetInput,
        format: z.enum(['jpeg', 'png', 'webp']).default('png'),
      }),
    },
    async (input) => {
      try {
        return jsonContent(await executeArtifactCommand(client, input, 'Page.captureScreenshot', { format: input.format }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.network_body',
    {
      description: 'Read a network response body, returning the bridge inline-or-artifact result without base64 expansion.',
      inputSchema: z.object({ ...targetInput, requestId: z.string().min(1) }),
    },
    async (input) => {
      try {
        return jsonContent(await executeArtifactCommand(client, input, 'Network.getResponseBody', { requestId: input.requestId }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.evaluate',
    {
      description: 'Evaluate page JavaScript, which may mutate page state, through an exclusive interact lease.',
      inputSchema: z.object({ ...targetInput, expression: z.string().min(1) }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await executeSemanticCommand(client, input, 'exclusive-control', 'Runtime.evaluate', { expression: input.expression, returnByValue: true }, ctx.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.navigate',
    {
      description: 'Navigate an authorized target through an exclusive lease.',
      inputSchema: z.object({ ...targetInput, url: z.url() }),
    },
    async (input) => {
      try {
        return jsonContent(await executeSemanticCommand(client, input, 'exclusive-control', 'Page.navigate', { url: input.url }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.click',
    {
      description: 'Dispatch an explicit click through an exclusive lease.',
      inputSchema: z.object({
        ...targetInput,
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    },
    async (input) => {
      try {
        return jsonContent(
          await executeSemanticCommands(client, input, 'exclusive-control', [
            {
              method: 'Input.dispatchMouseEvent',
              parameters: {
                button: 'left',
                clickCount: 1,
                type: 'mousePressed',
                x: input.x,
                y: input.y,
              },
            },
            {
              method: 'Input.dispatchMouseEvent',
              parameters: {
                button: 'left',
                clickCount: 1,
                type: 'mouseReleased',
                x: input.x,
                y: input.y,
              },
            },
          ]),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.type',
    {
      description: 'Insert text through an exclusive lease.',
      inputSchema: z.object({ ...targetInput, text: z.string().min(1) }),
    },
    async (input) => {
      try {
        return jsonContent(await executeSemanticCommand(client, input, 'exclusive-control', 'Input.insertText', { text: input.text }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.press',
    {
      description: 'Dispatch a key through an exclusive lease.',
      inputSchema: z.object({ ...targetInput, key: z.string().min(1) }),
    },
    async (input) => {
      try {
        return jsonContent(
          await executeSemanticCommands(client, input, 'exclusive-control', [
            {
              method: 'Input.dispatchKeyEvent',
              parameters: { key: input.key, text: input.key, type: 'keyDown' },
            },
            {
              method: 'Input.dispatchKeyEvent',
              parameters: { key: input.key, type: 'keyUp' },
            },
          ]),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const eventWaitInput = {
    ...targetInput,
    leaseId: z.string().uuid().optional(),
    timeoutMilliseconds: z.number().int().positive().max(30_000).default(5_000),
  };
  register(
    'browser.console',
    {
      description: 'Wait for one console event through a bounded subscription. An explicit lease keeps its event domain active until that lease is released.',
      inputSchema: z.object(eventWaitInput),
    },
    async (input, ctx) => {
      try {
        const { leaseId, ...eventInput } = input;
        return jsonContent(
          await waitForEvent(
            client,
            {
              ...eventInput,
              ...(leaseId === undefined ? {} : { leaseId }),
              method: 'Runtime.consoleAPICalled',
            },
            ctx.mcpReq.signal,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.network',
    {
      description: 'Wait for one network event through a bounded subscription. An explicit lease keeps its event domain active until that lease is released.',
      inputSchema: z.object(eventWaitInput),
    },
    async (input, ctx) => {
      try {
        const { leaseId, ...eventInput } = input;
        return jsonContent(
          await waitForEvent(
            client,
            {
              ...eventInput,
              ...(leaseId === undefined ? {} : { leaseId }),
              method: 'Network.responseReceived',
            },
            ctx.mcpReq.signal,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.wait_for',
    {
      description: 'Wait for an explicitly named CDP event through a bounded subscription. An explicit lease keeps its event domain active until that lease is released.',
      inputSchema: z.object({
        ...eventWaitInput,
        method: z.string().regex(cdpMethodPattern),
      }),
    },
    async (input, ctx) => {
      try {
        const { leaseId, ...eventInput } = input;
        return jsonContent(
          await waitForEvent(
            client,
            { ...eventInput, ...(leaseId === undefined ? {} : { leaseId }) },
            ctx.mcpReq.signal,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  return definitions;
}

/**
 * Registers CDB tools only after confirming every requested name is available.
 * This preflight keeps a name collision from leaving an application server with
 * a partial CDB surface.
 */
export function registerCdbTools(server: McpServer, options: RegisterCdbToolsOptions): void {
  const definitions = createCdbToolDefinitions(options);
  const registeredTools = (server as unknown as { readonly _registeredTools?: Record<string, unknown> })._registeredTools;
  const conflictingToolName = definitions.find(definition => registeredTools?.[definition.name] !== undefined)?.name;
  if (conflictingToolName !== undefined) {
    throw new Error(`Cannot register Chrome Debugger Bridge tools because ${conflictingToolName} is already registered.`);
  }
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.mcpInputSchema,
      },
      async (input, context) => definition.invoke(input, { signal: context.mcpReq.signal }),
    );
  }
}

function createMcpServer(client: McpChromeDebuggerBridgeClient, enableRawCdp = false): McpServer {
  const server = new McpServer({
    name: 'chrome-debugger-bridge',
    version: '0.0.0',
  });
  registerCdbTools(server, { client, enableRawCdp });
  return server;
}

/** Mounts the official MCP SDK Streamable HTTP transport without taking ownership of the broker or HTTP server. */
export function mountMcpStreamableHttp(options: MountMcpStreamableHttpOptions): MountedMcpStreamableHttp {
  const path = options.path ?? '/cdb/mcp';
  const handler = createMcpHandler(() => createMcpServer(options.client, options.enableRawCdp), { legacy: 'reject', responseMode: 'sse' });
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

/** Starts an optional stdio adapter around the same MCP tool surface without owning broker lifecycle. */
export function mountMcpStdio(options: MountMcpStdioOptions): MountedMcpStdio {
  return serveStdio(() => createMcpServer(options.client, options.enableRawCdp), { ...options.stdio, legacy: 'reject' });
}
