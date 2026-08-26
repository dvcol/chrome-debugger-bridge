import type {
  ArtifactAccessRequest,
  ArtifactDescriptor,
  CdpEvent,
  ChromeDebuggerBridgeClient,
  Lease,
} from '@dvcol/cdb';
import type { JsonObject } from '@dvcol/cdb/protocol';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ServeStdioOptions } from '@modelcontextprotocol/server/stdio';
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from 'node:http';

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
const maximumReadableSnapshotBytes = 16_777_216;
const maximumSnapshotCharacters = 120_000;
const omittedTextElementNames = new Set(['noscript', 'script', 'style']);
const whitespacePattern = /\s+/gu;

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
  cancelCommand: (request: {
    readonly operationId: string;
    readonly targetGeneration: number;
    readonly targetId: string;
  }) => Promise<void>;
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

export interface MountMcpStdioOptions extends Pick<
  MountMcpStreamableHttpOptions,
  'client' | 'enableRawCdp'
> {
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

function textContent(value: string): CallToolResult {
  return { content: [{ text: value, type: 'text' }] };
}

function property(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key);
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toolError(error: unknown): CallToolResult {
  const record
    = error !== null && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  const payload = {
    code: typeof record.code === 'string' ? record.code : 'MCP_TOOL_FAILED',
    message:
      error instanceof Error ? error.message : 'The browser tool failed.',
    retryable: typeof record.retryable === 'boolean' ? record.retryable : false,
    ...(typeof record.retryAfterMs === 'number'
      ? { retryAfterMs: record.retryAfterMs }
      : {}),
    ...(record.details !== null && typeof record.details === 'object'
      ? { details: record.details }
      : {}),
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

async function withLease<Value>(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  mode: Lease['mode'],
  requestedMethods: readonly string[],
  action: (lease: Lease) => Promise<Value>,
): Promise<Value> {
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
    try {
      await client.releaseLease({
        leaseId: lease.id,
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      });
    } catch {
      /** Navigation can fence this short-lived lease before cleanup; expiry remains the fallback. */
    }
  }
}

async function executeSemanticCommand(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  mode: Lease['mode'],
  method: string,
  parameters: JsonObject,
  signal?: AbortSignal,
): Promise<unknown> {
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

function artifactDescriptor(value: unknown): ArtifactDescriptor | undefined {
  const id = stringValue(property(value, 'id'));
  const expiresAt = stringValue(property(value, 'expiresAt'));
  const mediaType = stringValue(property(value, 'mediaType'));
  const lengthValue = property(value, 'length');
  const length = numberValue(lengthValue);
  const digestValue = property(value, 'digest');
  const digest = stringValue(digestValue);
  if (
    id === undefined
    || expiresAt === undefined
    || mediaType === undefined
    || (lengthValue !== undefined && length === undefined)
    || (digestValue !== undefined && digest === undefined)
  )
    return undefined;
  return {
    id,
    expiresAt,
    mediaType,
    ...(length === undefined ? {} : { length }),
    ...(digest === undefined ? {} : { digest }),
  };
}

function artifactFromCommandResult(
  result: unknown,
): ArtifactDescriptor | undefined {
  if (typeof result !== 'object' || result === null || !('value' in result))
    return undefined;
  const value = result.value;
  if (typeof value !== 'object' || value === null || !('artifact' in value))
    return undefined;
  return artifactDescriptor(value.artifact);
}

interface RetainedArtifactResult {
  readonly artifact: ArtifactDescriptor;
  readonly lease: Lease;
}

async function executeArtifactCommand(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  method: string,
  parameters: JsonObject,
): Promise<RetainedArtifactResult | unknown> {
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
    if (artifact === undefined)
      return typeof result === 'object' && result !== null && 'value' in result
        ? result.value
        : result;
    retainLease = true;
    return { artifact, lease };
  } finally {
    if (!retainLease) {
      try {
        await client.releaseLease({
          leaseId: lease.id,
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        });
      } catch {
        /** A fenced or disconnected temporary lease expires without replacing the command result. */
      }
    }
  }
}

function retainedArtifactResult(
  value: unknown,
): RetainedArtifactResult | undefined {
  const artifact = artifactDescriptor(property(value, 'artifact'));
  const leaseValue = property(value, 'lease');
  const leaseId = stringValue(property(leaseValue, 'id'));
  const expiresAt = stringValue(property(leaseValue, 'expiresAt'));
  const issuedAt = stringValue(property(leaseValue, 'issuedAt'));
  const methodValues = arrayValue(property(leaseValue, 'methods'));
  const methods: string[] = [];
  for (const methodValue of methodValues) {
    const method = stringValue(methodValue);
    if (method === undefined) return undefined;
    methods.push(method);
  }
  const modeValue = property(leaseValue, 'mode');
  const mode
    = modeValue === 'exclusive-control' || modeValue === 'shared-read'
      ? modeValue
      : undefined;
  const targetGeneration = numberValue(
    property(leaseValue, 'targetGeneration'),
  );
  const targetId = stringValue(property(leaseValue, 'targetId'));
  if (
    artifact === undefined
    || leaseId === undefined
    || expiresAt === undefined
    || issuedAt === undefined
    || mode === undefined
    || targetGeneration === undefined
    || targetId === undefined
  )
    return undefined;
  return {
    artifact,
    lease: {
      expiresAt,
      id: leaseId,
      issuedAt,
      methods,
      mode,
      targetGeneration,
      targetId,
    },
  };
}

async function readRetainedArtifact(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  retained: RetainedArtifactResult,
  signal: AbortSignal,
): Promise<unknown> {
  const { artifact, lease } = retained;
  const chunks: Uint8Array[] = [];
  let offset = 0;
  try {
    if (artifact.length === undefined)
      throw new McpToolError(
        'MCP_ARTIFACT_LENGTH_REQUIRED',
        'The readable snapshot artifact has no declared length.',
      );
    if (artifact.length > maximumReadableSnapshotBytes)
      throw new McpToolError(
        'MCP_SNAPSHOT_TOO_LARGE',
        `The readable snapshot exceeds ${maximumReadableSnapshotBytes} bytes. Use browser.raw_cdp for a lossless artifact.`,
      );
    while (offset < artifact.length) {
      const bytes = await client.readArtifact(
        {
          artifactId: artifact.id,
          leaseId: lease.id,
          range: {
            length: Math.min(
              maximumArtifactReadBytes,
              artifact.length - offset,
            ),
            offset,
          },
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        },
        signal,
      );
      if (bytes.byteLength === 0)
        throw new McpToolError(
          'MCP_ARTIFACT_RANGE_INVALID',
          'The readable snapshot artifact returned an empty range.',
        );
      chunks.push(bytes);
      offset += bytes.byteLength;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    try {
      await client.releaseArtifact({
        artifactId: artifact.id,
        leaseId: lease.id,
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      });
    } catch {
      /** A disconnected provider may already have discarded the temporary artifact. */
    } finally {
      try {
        await client.releaseLease({
          leaseId: lease.id,
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        });
      } catch {
        /** A navigation can fence cleanup after the artifact was already consumed. */
      }
    }
  }
}

async function readableCommandValue(
  client: McpChromeDebuggerBridgeClient,
  input: { readonly targetGeneration: number; readonly targetId: string },
  value: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const retained = retainedArtifactResult(value);
  return retained === undefined
    ? value
    : readRetainedArtifact(client, input, retained, signal);
}

function tableString(strings: readonly unknown[], index: unknown): string {
  const selectedIndex = numberValue(index);
  if (selectedIndex === undefined) return '';
  return stringValue(strings[selectedIndex]) ?? '';
}

function compactText(value: string, maximumLength = 160): string {
  const compacted = value.replaceAll(whitespacePattern, ' ').trim();
  if (compacted.length <= maximumLength) return compacted;
  return `${compacted.slice(0, maximumLength - 1)}…`;
}

function quoted(value: string): string {
  return JSON.stringify(compactText(value));
}

function formatAttributes(strings: readonly unknown[], value: unknown): string {
  const indexes = arrayValue(value);
  const attributes: string[] = [];
  for (let index = 0; index + 1 < indexes.length; index += 2) {
    const name = tableString(strings, indexes[index]);
    if (name.length === 0) continue;
    attributes.push(
      `${name}=${quoted(tableString(strings, indexes[index + 1]))}`,
    );
  }
  const joined = attributes.join(' ');
  return joined.length <= 360 ? joined : `${joined.slice(0, 359)}…`;
}

function formatDomSnapshot(
  value: unknown,
  options: { readonly maximumDepth: number; readonly maximumNodes: number },
): string {
  const strings = arrayValue(property(value, 'strings'));
  const documents = arrayValue(property(value, 'documents'));
  const lines = ['# DOM snapshot'];
  let renderedCharacters = lines[0]?.length ?? 0;
  let renderedNodes = 0;
  let truncated = false;
  const appendLines = (...nextLines: string[]): void => {
    lines.push(...nextLines);
    renderedCharacters += nextLines.reduce(
      (total, line) => total + line.length + 1,
      0,
    );
  };

  for (const [documentIndex, documentValue] of documents.entries()) {
    if (renderedNodes >= options.maximumNodes) {
      truncated = true;
      break;
    }
    const documentUrl = tableString(
      strings,
      property(documentValue, 'documentURL'),
    );
    appendLines(
      '',
      `## Document ${documentIndex + 1}${documentUrl.length === 0 ? '' : ` · ${documentUrl}`}`,
    );
    const nodes = property(documentValue, 'nodes');
    const nodeNames = arrayValue(property(nodes, 'nodeName'));
    const nodeValues = arrayValue(property(nodes, 'nodeValue'));
    const parentIndexes = arrayValue(property(nodes, 'parentIndex'));
    const backendNodeIds = arrayValue(property(nodes, 'backendNodeId'));
    const attributeLists = arrayValue(property(nodes, 'attributes'));
    const childIndexesByParent = new Map<number, number[]>();
    const roots: number[] = [];
    for (let index = 0; index < nodeNames.length; index += 1) {
      const parentIndex = numberValue(parentIndexes[index]);
      if (parentIndex === undefined || parentIndex < 0) {
        roots.push(index);
        continue;
      }
      const children = childIndexesByParent.get(parentIndex) ?? [];
      children.push(index);
      childIndexesByParent.set(parentIndex, children);
    }

    const visit = (nodeIndex: number, depth: number): void => {
      if (
        renderedNodes >= options.maximumNodes
        || renderedCharacters >= maximumSnapshotCharacters
      ) {
        truncated = true;
        return;
      }
      if (depth > options.maximumDepth) {
        truncated = true;
        return;
      }
      const nodeName = tableString(strings, nodeNames[nodeIndex]);
      const nodeValue = compactText(
        tableString(strings, nodeValues[nodeIndex]),
      );
      const indentation = '  '.repeat(depth);
      if (nodeName === '#text') {
        const parentIndex = numberValue(parentIndexes[nodeIndex]);
        const parentName
          = parentIndex === undefined
            ? ''
            : tableString(strings, nodeNames[parentIndex]).toLowerCase();
        if (nodeValue.length > 0 && !omittedTextElementNames.has(parentName)) {
          appendLines(`${indentation}- ${quoted(nodeValue)}`);
          renderedNodes += 1;
        }
      } else if (nodeName !== '#comment') {
        const normalizedName
          = nodeName.length === 0 ? 'unknown' : nodeName.toLowerCase();
        const attributes = formatAttributes(strings, attributeLists[nodeIndex]);
        const backendNodeId = numberValue(backendNodeIds[nodeIndex]);
        appendLines(
          `${indentation}- <${normalizedName}${attributes.length === 0 ? '' : ` ${attributes}`}>${backendNodeId === undefined ? '' : ` [backendNodeId=${backendNodeId}]`}${nodeValue.length === 0 ? '' : ` ${quoted(nodeValue)}`}`,
        );
        renderedNodes += 1;
      }
      for (const childIndex of childIndexesByParent.get(nodeIndex) ?? []) {
        visit(childIndex, depth + 1);
        if (truncated && renderedNodes >= options.maximumNodes) return;
      }
    };
    for (const root of roots) visit(root, 0);
  }
  if (documents.length === 0)
    appendLines('', 'No document was returned by Chrome.');
  if (truncated)
    appendLines(
      '',
      `… snapshot truncated after ${renderedNodes} rendered nodes. Increase maximumNodes/maximumDepth or use browser.raw_cdp for the lossless response.`,
    );
  return lines.join('\n').slice(0, maximumSnapshotCharacters);
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
  return withLease(
    client,
    input,
    mode,
    [...new Set(commands.map(command => command.method))],
    async (lease) => {
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
    },
  );
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
        timeout = setTimeout(
          () =>
            reject(new McpToolError('MCP_WAIT_TIMEOUT', 'MCP wait timed out.')),
          input.timeoutMilliseconds,
        );
      });
      const result = await Promise.race([nextEvent, expiry]);
      if (result.done)
        throw new McpToolError('MCP_WAIT_CANCELLED', 'MCP wait was cancelled.');
      retainSubscription = input.leaseId !== undefined;
      return result.value;
    } finally {
      signal.removeEventListener('abort', abort);
      if (timeout !== undefined) clearTimeout(timeout);
      if (!retainSubscription) closeSubscription();
    }
  };
  if (input.leaseId !== undefined) return waitUsingLease(input.leaseId);
  const target = (await client.listTargets()).find(
    candidate =>
      candidate.id === input.targetId
      && candidate.generation === input.targetGeneration,
  );
  const mode
    = target === undefined
      ? 'shared-read'
      : requiredLeaseMode(target.capabilities, [input.method]);
  return withLease(client, input, mode, [input.method], async lease =>
    waitUsingLease(lease.id));
}

export interface CdbToolInvocationContext {
  readonly signal: AbortSignal;
}

export interface CdbToolDefinition {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly mcpInputSchema: z.ZodObject;
  readonly name: string;
  invoke: (
    input: unknown,
    context?: CdbToolInvocationContext,
  ) => Promise<CallToolResult>;
}

/** Builds the canonical CDB tool catalogue without taking ownership of an MCP server or transport. */
export function createCdbToolDefinitions(
  options: RegisterCdbToolsOptions,
): CdbToolDefinition[] {
  const definitions: CdbToolDefinition[] = [];
  const register = <InputSchema extends z.ZodObject>(
    name: string,
    config: { readonly description: string; readonly inputSchema: InputSchema },
    handler: (
      input: z.output<InputSchema>,
      context: { readonly mcpReq: { readonly signal: AbortSignal } },
    ) => Promise<CallToolResult>,
  ): void => {
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
      description:
        'List currently granted Chrome targets. A target generation can change after navigation without revoking its grant; retry with the returned generation when a tool reports TARGET_GENERATION_STALE.',
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
      description:
        'Acquire an explicit target lease for exact Chrome DevTools Protocol command or event names (for example, "Runtime.evaluate"). Semantic browser tool names such as "evaluate" are not valid requested methods. Do not request or call domain enable/disable methods: CDB owns domain lifecycle and activates a leased domain before its first command or subscription.',
      inputSchema: z.object({
        ...leaseInput,
        mode: z.enum(['exclusive-control', 'shared-read']).optional(),
        requestedMethods: z
          .array(z.string())
          .min(1)
          .describe(
            'Exact Chrome DevTools Protocol method or event names, such as "Runtime.evaluate".',
          ),
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
        maximumBytes: z
          .number()
          .int()
          .positive()
          .max(maximumArtifactReadBytes)
          .default(maximumArtifactReadBytes),
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
        if (bytes.byteLength > input.maximumBytes)
          throw new McpToolError(
            'MCP_ARTIFACT_RANGE_INVALID',
            'The artifact range exceeded the requested limit.',
          );
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
      description:
        'Evaluate a read-only inspection expression through an authorized lease.',
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
        description:
          'Execute any catalogued Chrome DevTools Protocol command allowed by the grant through an explicit lease. Domain enable/disable methods are broker-owned and must be omitted; CDB activates the domain before the first leased command.',
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
              ...(input.sessionId === undefined
                ? {}
                : { sessionId: input.sessionId }),
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
      description:
        'Capture an agent-readable structural DOM tree through a read lease, including backendNodeId references for targeted raw DOM inspection. Large CDP responses are read and released internally; use browser.raw_cdp with DOMSnapshot.captureSnapshot only when the lossless response is required.',
      inputSchema: z.object({
        ...targetInput,
        maximumDepth: z.number().int().nonnegative().max(50).default(20),
        maximumNodes: z.number().int().positive().max(5_000).default(1_500),
      }),
    },
    async (input, context) => {
      try {
        const commandValue = await executeArtifactCommand(
          client,
          input,
          'DOMSnapshot.captureSnapshot',
          {
            computedStyles: [],
            includeDOMRects: false,
            includePaintOrder: false,
          },
        );
        return textContent(
          formatDomSnapshot(
            await readableCommandValue(
              client,
              input,
              commandValue,
              context.mcpReq.signal,
            ),
            {
              maximumDepth: input.maximumDepth,
              maximumNodes: input.maximumNodes,
            },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.screenshot',
    {
      description:
        'Capture a screenshot, returning the bridge inline-or-artifact result without base64 expansion.',
      inputSchema: z.object({
        ...targetInput,
        format: z.enum(['jpeg', 'png', 'webp']).default('png'),
      }),
    },
    async (input) => {
      try {
        return jsonContent(
          await executeArtifactCommand(
            client,
            input,
            'Page.captureScreenshot',
            { format: input.format },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.network_body',
    {
      description:
        'Read a network response body, returning the bridge inline-or-artifact result without base64 expansion.',
      inputSchema: z.object({ ...targetInput, requestId: z.string().min(1) }),
    },
    async (input) => {
      try {
        return jsonContent(
          await executeArtifactCommand(
            client,
            input,
            'Network.getResponseBody',
            { requestId: input.requestId },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.evaluate',
    {
      description:
        'Evaluate page JavaScript, which may mutate page state, through an exclusive interact lease.',
      inputSchema: z.object({ ...targetInput, expression: z.string().min(1) }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(
          await executeSemanticCommand(
            client,
            input,
            'exclusive-control',
            'Runtime.evaluate',
            { expression: input.expression, returnByValue: true },
            ctx.mcpReq.signal,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.navigate',
    {
      description:
        'Navigate an authorized target through an exclusive lease. Navigation can advance the target generation without revoking the grant; list targets before the next command and use the current generation.',
      inputSchema: z.object({ ...targetInput, url: z.url() }),
    },
    async (input) => {
      try {
        return jsonContent(
          await executeSemanticCommand(
            client,
            input,
            'exclusive-control',
            'Page.navigate',
            { url: input.url },
          ),
        );
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
        return jsonContent(
          await executeSemanticCommand(
            client,
            input,
            'exclusive-control',
            'Input.insertText',
            { text: input.text },
          ),
        );
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
      description:
        'Wait for one console event through a bounded subscription. An explicit lease keeps its event domain active until that lease is released.',
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
      description:
        'Wait for one network event through a bounded subscription. An explicit lease keeps its event domain active until that lease is released.',
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
      description:
        'Wait for an explicitly named CDP event through a bounded subscription. An explicit lease keeps its event domain active until that lease is released.',
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
export function registerCdbTools(
  server: McpServer,
  options: RegisterCdbToolsOptions,
): void {
  const definitions = createCdbToolDefinitions(options);
  const registeredTools = (
    server as unknown as { readonly _registeredTools?: Record<string, unknown> }
  )._registeredTools;
  const conflictingToolName = definitions.find(
    definition => registeredTools?.[definition.name] !== undefined,
  )?.name;
  if (conflictingToolName !== undefined) {
    throw new Error(
      `Cannot register Chrome Debugger Bridge tools because ${conflictingToolName} is already registered.`,
    );
  }
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.mcpInputSchema,
      },
      async (input, context) =>
        definition.invoke(input, { signal: context.mcpReq.signal }),
    );
  }
}

function createMcpServer(
  client: McpChromeDebuggerBridgeClient,
  enableRawCdp = false,
): McpServer {
  const server = new McpServer({
    name: 'chrome-debugger-bridge',
    version: '0.0.0',
  });
  registerCdbTools(server, { client, enableRawCdp });
  return server;
}

/** Mounts the official MCP SDK Streamable HTTP transport without taking ownership of the broker or HTTP server. */
export function mountMcpStreamableHttp(
  options: MountMcpStreamableHttpOptions,
): MountedMcpStreamableHttp {
  const path = options.path ?? '/cdb/mcp';
  const handler = createMcpHandler(
    () => createMcpServer(options.client, options.enableRawCdp),
    { legacy: 'reject', responseMode: 'sse' },
  );
  const nodeHandler = toNodeHandler(handler);
  let closed = false;
  const listener = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (
      closed
      || new URL(request.url ?? '/', 'http://localhost').pathname !== path
    )
      return;
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
  return serveStdio(
    () => createMcpServer(options.client, options.enableRawCdp),
    { ...options.stdio, legacy: 'reject' },
  );
}
