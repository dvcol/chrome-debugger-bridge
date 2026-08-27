import type {
  ArtifactAccessRequest,
  ArtifactDescriptor,
  CdpEvent,
  CdpSubscription,
  ChromeDebuggerBridgeClient,
  Lease,
  PublishedTarget,
  TargetChange,
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
const maximumInputActionDurationMilliseconds = 10_000;
const maximumInputActionSteps = 120;
const omittedTextElementNames = new Set(['noscript', 'script', 'style']);
const whitespacePattern = /\s+/gu;

const inputModifierValues = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
} as const;
const pointerButtonValues = {
  back: 8,
  forward: 16,
  left: 1,
  middle: 4,
  right: 2,
} as const;

type InputModifier = keyof typeof inputModifierValues;

interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonObject,
    readonly retryable = false,
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
  input: {
    readonly sessionId?: string | undefined;
    readonly targetGeneration: number;
    readonly targetId: string;
  },
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
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
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
  input: {
    readonly sessionId?: string | undefined;
    readonly targetGeneration: number;
    readonly targetId: string;
  },
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
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
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

interface ChildSessionReference {
  readonly generation: number;
  readonly id: string;
  readonly type: string;
}

function childSessionReferences(value: unknown): ChildSessionReference[] {
  const commandValue = property(value, 'value') ?? value;
  const sessions = arrayValue(property(commandValue, 'sessions'));
  return sessions.flatMap((session) => {
    const generation = numberValue(property(session, 'generation'));
    const id = stringValue(property(session, 'id'));
    const type = stringValue(property(session, 'type'));
    return generation === undefined || id === undefined || type === undefined
      ? []
      : [{ generation, id, type }];
  });
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

interface FormattedDomSnapshot {
  readonly renderedNodes: number;
  readonly text: string;
}

function formatDomSnapshot(
  value: unknown,
  options: { readonly maximumDepth: number; readonly maximumNodes: number },
): FormattedDomSnapshot {
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
  return {
    renderedNodes,
    text: lines.join('\n').slice(0, maximumSnapshotCharacters),
  };
}

function encodeInputModifiers(modifiers: readonly InputModifier[]): number {
  return modifiers.reduce(
    (encodedModifiers, modifier) => encodedModifiers | inputModifierValues[modifier],
    0,
  );
}

function interpolateViewportPoints(
  from: ViewportPoint,
  to: ViewportPoint,
  steps: number,
): ViewportPoint[] {
  return Array.from({ length: steps }, (_value, index) => {
    const progress = (index + 1) / steps;
    return {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    };
  });
}

function pointerPositionKey(input: {
  readonly targetGeneration: number;
  readonly targetId: string;
}): string {
  return `${input.targetId}:${input.targetGeneration}`;
}

async function waitForInputStep(
  durationMilliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    throw new McpToolError('MCP_WAIT_CANCELLED', 'The input action was cancelled.');
  if (durationMilliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(new McpToolError('MCP_WAIT_CANCELLED', 'The input action was cancelled.'));
    };
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    timeout = setTimeout(finish, durationMilliseconds);
    signal.addEventListener('abort', abort, { once: true });
    timeout.unref?.();
    if (signal.aborted) abort();
  });
}

async function executeInputAction(
  client: McpChromeDebuggerBridgeClient,
  input: {
    readonly sessionId?: string | undefined;
    readonly targetGeneration: number;
    readonly targetId: string;
  },
  requestedMethods: readonly string[],
  signal: AbortSignal,
  action: (
    execute: (method: string, parameters: JsonObject) => Promise<unknown>,
    executeCleanup: (method: string, parameters: JsonObject) => Promise<void>,
    lease: Lease,
  ) => Promise<unknown>,
): Promise<unknown> {
  return withLease(
    client,
    input,
    'exclusive-control',
    [...new Set(requestedMethods)],
    async (lease) => {
      let activeOperationId: string | undefined;
      const abort = (): void => {
        if (activeOperationId === undefined) return;
        void client.cancelCommand({
          operationId: activeOperationId,
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        }).catch(() => {});
      };
      const execute = async (method: string, parameters: JsonObject): Promise<unknown> => {
        if (signal.aborted)
          throw new McpToolError('MCP_WAIT_CANCELLED', 'The input action was cancelled.');
        activeOperationId = randomUUID();
        try {
          return await client.executeCommand({
            leaseId: lease.id,
            method,
            operationId: activeOperationId,
            parameters,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            targetGeneration: input.targetGeneration,
            targetId: input.targetId,
          });
        } catch (error) {
          if (signal.aborted)
            throw new McpToolError('MCP_WAIT_CANCELLED', 'The input action was cancelled.');
          throw error;
        } finally {
          activeOperationId = undefined;
        }
      };
      const executeCleanup = async (method: string, parameters: JsonObject): Promise<void> => {
        try {
          await client.executeCommand({
            leaseId: lease.id,
            method,
            operationId: randomUUID(),
            parameters,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            targetGeneration: input.targetGeneration,
            targetId: input.targetId,
          });
        } catch {
          /** The original cancellation or target fence is the actionable failure. */
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        return await action(execute, executeCleanup, lease);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  );
}

type NodeAction = 'click' | 'focus' | 'hover' | 'type';

interface NodeActionInput {
  readonly backendNodeId: number;
  readonly button?: keyof typeof pointerButtonValues;
  readonly clickCount?: number;
  readonly modifiers?: readonly InputModifier[];
  readonly sessionId?: string | undefined;
  readonly targetGeneration: number;
  readonly targetId: string;
  readonly text?: string;
}

interface NodeProbe {
  readonly connected: boolean;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly visible: boolean;
}

const nodeProbeFunction = `function () {
  const style = globalThis.getComputedStyle(this);
  const inputTypes = new Set(['date', 'datetime-local', 'email', 'month', 'number', 'password', 'search', 'tel', 'text', 'time', 'url', 'week']);
  const editable = this.isContentEditable
    || this instanceof HTMLTextAreaElement
    || (this instanceof HTMLInputElement && inputTypes.has(this.type));
  return {
    connected: this.isConnected,
    disabled: Boolean(this.disabled) || this.getAttribute('aria-disabled') === 'true',
    editable: editable && !this.readOnly,
    viewportHeight: globalThis.innerHeight,
    viewportWidth: globalThis.innerWidth,
    visible: style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.visibility !== 'collapse'
      && Number.parseFloat(style.opacity || '1') > 0
      && this.getClientRects().length > 0,
  };
}`;

function commandResultValue(value: unknown): unknown {
  return property(value, 'value') ?? value;
}

function runtimeResultValue(value: unknown): unknown {
  const commandValue = commandResultValue(value);
  return property(property(commandValue, 'result'), 'value');
}

function parseNodeProbe(value: unknown): NodeProbe | undefined {
  const probe = runtimeResultValue(value);
  const connected = property(probe, 'connected');
  const disabled = property(probe, 'disabled');
  const editable = property(probe, 'editable');
  const viewportHeight = property(probe, 'viewportHeight');
  const viewportWidth = property(probe, 'viewportWidth');
  const visible = property(probe, 'visible');
  if (
    typeof connected !== 'boolean'
    || typeof disabled !== 'boolean'
    || typeof editable !== 'boolean'
    || typeof viewportHeight !== 'number'
    || typeof viewportWidth !== 'number'
    || typeof visible !== 'boolean'
  ) return undefined;
  return {
    connected,
    disabled,
    editable,
    viewportHeight,
    viewportWidth,
    visible,
  };
}

function remoteObjectId(value: unknown): string | undefined {
  const commandValue = commandResultValue(value);
  return stringValue(property(property(commandValue, 'object'), 'objectId'));
}

function contentQuadPoint(
  value: unknown,
  viewportWidth: number,
  viewportHeight: number,
): ViewportPoint | undefined {
  const commandValue = commandResultValue(value);
  const quads = arrayValue(property(commandValue, 'quads'));
  const candidates = quads.flatMap((quadValue) => {
    const quad = arrayValue(quadValue);
    const coordinates = quad.map(coordinate => typeof coordinate === 'number' ? coordinate : Number.NaN);
    if (coordinates.length !== 8 || coordinates.some(coordinate => !Number.isFinite(coordinate))) return [];
    const [firstX, firstY, secondX, secondY, thirdX, thirdY, fourthX, fourthY] = coordinates;
    if (
      firstX === undefined || firstY === undefined
      || secondX === undefined || secondY === undefined
      || thirdX === undefined || thirdY === undefined
      || fourthX === undefined || fourthY === undefined
    ) return [];
    const xValues = [firstX, secondX, thirdX, fourthX];
    const yValues = [firstY, secondY, thirdY, fourthY];
    const left = Math.max(0, Math.min(...xValues));
    const right = Math.min(viewportWidth, Math.max(...xValues));
    const top = Math.max(0, Math.min(...yValues));
    const bottom = Math.min(viewportHeight, Math.max(...yValues));
    if (right <= left || bottom <= top) return [];
    const minimumX = Math.ceil(left);
    const maximumX = Math.ceil(right) - 1;
    const minimumY = Math.ceil(top);
    const maximumY = Math.ceil(bottom) - 1;
    if (maximumX < minimumX || maximumY < minimumY) return [];
    return [{
      area: (right - left) * (bottom - top),
      x: Math.round((minimumX + maximumX) / 2),
      y: Math.round((minimumY + maximumY) / 2),
    }];
  });
  candidates.sort((first, second) => second.area - first.area);
  const selected = candidates[0];
  return selected === undefined ? undefined : { x: selected.x, y: selected.y };
}

function nodeActionError(
  code: string,
  message: string,
  input: NodeActionInput,
): McpToolError {
  return new McpToolError(code, message, {
    backendNodeId: input.backendNodeId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  }, code === 'MCP_NODE_STALE');
}

async function executeNodeAction(
  client: McpChromeDebuggerBridgeClient,
  input: NodeActionInput,
  action: NodeAction,
  signal: AbortSignal,
): Promise<unknown> {
  const methods = [
    'DOM.describeNode',
    'DOM.getContentQuads',
    'DOM.getNodeForLocation',
    'DOM.resolveNode',
    'DOM.scrollIntoViewIfNeeded',
    'Runtime.callFunctionOn',
    'Runtime.releaseObjectGroup',
    ...(action === 'click' || action === 'hover' ? ['Input.dispatchMouseEvent'] : []),
    ...(action === 'focus' || action === 'type' ? ['DOM.focus'] : []),
    ...(action === 'type' ? ['Input.insertText'] : []),
  ];
  const objectGroup = `cdb-node-${randomUUID()}`;
  return executeInputAction(client, input, methods, signal, async (execute, executeCleanup) => {
    const results: unknown[] = [];
    try {
      try {
        results.push(await execute('DOM.describeNode', {
          backendNodeId: input.backendNodeId,
          depth: 0,
          pierce: true,
        }));
      } catch {
        throw nodeActionError('MCP_NODE_STALE', 'The snapshot node is detached or stale.', input);
      }
      let resolvedNode: unknown;
      try {
        resolvedNode = await execute('DOM.resolveNode', {
          backendNodeId: input.backendNodeId,
          objectGroup,
        });
      } catch {
        throw nodeActionError('MCP_NODE_STALE', 'The snapshot node is detached or stale.', input);
      }
      results.push(resolvedNode);
      const objectId = remoteObjectId(resolvedNode);
      if (objectId === undefined)
        throw nodeActionError('MCP_NODE_STALE', 'The snapshot node cannot be resolved.', input);
      let probeResult: unknown;
      try {
        probeResult = await execute('Runtime.callFunctionOn', {
          functionDeclaration: nodeProbeFunction,
          objectId,
          returnByValue: true,
        });
      } catch {
        throw nodeActionError('MCP_NODE_STALE', 'The snapshot node is detached or stale.', input);
      }
      results.push(probeResult);
      const probe = parseNodeProbe(probeResult);
      if (probe === undefined || !probe.connected)
        throw nodeActionError('MCP_NODE_STALE', 'The snapshot node is detached or stale.', input);
      if (!probe.visible)
        throw nodeActionError('MCP_NODE_NOT_VISIBLE', 'The snapshot node is not visible.', input);
      if (action !== 'hover' && probe.disabled)
        throw nodeActionError('MCP_NODE_DISABLED', 'The snapshot node is disabled.', input);
      if (action === 'type' && !probe.editable)
        throw nodeActionError('MCP_NODE_NOT_EDITABLE', 'The snapshot node does not accept text.', input);
      try {
        results.push(await execute('DOM.scrollIntoViewIfNeeded', {
          backendNodeId: input.backendNodeId,
        }));
      } catch {
        throw nodeActionError('MCP_NODE_STALE', 'The snapshot node became stale before scrolling.', input);
      }
      let quadResult: unknown;
      try {
        quadResult = await execute('DOM.getContentQuads', {
          backendNodeId: input.backendNodeId,
        });
      } catch {
        throw nodeActionError('MCP_NODE_NO_GEOMETRY', 'The snapshot node has no usable geometry.', input);
      }
      results.push(quadResult);
      const point = contentQuadPoint(quadResult, probe.viewportWidth, probe.viewportHeight);
      if (point === undefined)
        throw nodeActionError('MCP_NODE_NO_GEOMETRY', 'The snapshot node has no visible viewport geometry.', input);
      let hitResult: unknown;
      try {
        hitResult = await execute('DOM.getNodeForLocation', {
          includeUserAgentShadowDOM: true,
          x: point.x,
          y: point.y,
        });
      } catch {
        throw nodeActionError('MCP_NODE_OBSCURED', 'Chrome could not hit-test the snapshot node.', input);
      }
      results.push(hitResult);
      const hitBackendNodeId = numberValue(property(commandResultValue(hitResult), 'backendNodeId'));
      if (hitBackendNodeId === undefined)
        throw nodeActionError('MCP_NODE_OBSCURED', 'Chrome could not hit-test the snapshot node.', input);
      if (hitBackendNodeId !== input.backendNodeId) {
        let hitNode: unknown;
        try {
          hitNode = await execute('DOM.resolveNode', {
            backendNodeId: hitBackendNodeId,
            objectGroup,
          });
        } catch {
          throw nodeActionError('MCP_NODE_OBSCURED', 'Another element obscures the snapshot node.', input);
        }
        results.push(hitNode);
        const hitObjectId = remoteObjectId(hitNode);
        if (hitObjectId === undefined)
          throw nodeActionError('MCP_NODE_OBSCURED', 'Another element obscures the snapshot node.', input);
        const containsResult = await execute('Runtime.callFunctionOn', {
          arguments: [{ objectId: hitObjectId }],
          functionDeclaration: 'function (hit) { return this === hit || this.contains(hit); }',
          objectId,
          returnByValue: true,
        });
        results.push(containsResult);
        if (runtimeResultValue(containsResult) !== true)
          throw nodeActionError('MCP_NODE_OBSCURED', 'Another element obscures the snapshot node.', input);
      }
      if (action === 'hover') {
        results.push(await execute('Input.dispatchMouseEvent', {
          modifiers: encodeInputModifiers(input.modifiers ?? []),
          type: 'mouseMoved',
          ...point,
        }));
        return results;
      }
      if (action === 'click') {
        const button = input.button ?? 'left';
        const requestedClickCount = input.clickCount ?? 1;
        let buttonPressed = false;
        try {
          for (let clickCount = 1; clickCount <= requestedClickCount; clickCount += 1) {
            results.push(await execute('Input.dispatchMouseEvent', {
              button,
              clickCount,
              modifiers: encodeInputModifiers(input.modifiers ?? []),
              type: 'mousePressed',
              ...point,
            }));
            buttonPressed = true;
            results.push(await execute('Input.dispatchMouseEvent', {
              button,
              clickCount,
              modifiers: encodeInputModifiers(input.modifiers ?? []),
              type: 'mouseReleased',
              ...point,
            }));
            buttonPressed = false;
          }
        } finally {
          if (buttonPressed) {
            await executeCleanup('Input.dispatchMouseEvent', {
              button,
              clickCount: requestedClickCount,
              modifiers: encodeInputModifiers(input.modifiers ?? []),
              type: 'mouseReleased',
              ...point,
            });
          }
        }
        return results;
      }
      results.push(await execute('DOM.focus', { backendNodeId: input.backendNodeId }));
      if (action === 'type')
        results.push(await execute('Input.insertText', { text: input.text ?? '' }));
      return results;
    } finally {
      await executeCleanup('Runtime.releaseObjectGroup', { objectGroup });
    }
  });
}

type NavigationWaitUntil = 'commit' | 'domcontentloaded' | 'load';

interface LifecycleInput {
  readonly sessionId?: string | undefined;
  readonly targetGeneration: number;
  readonly targetId: string;
  readonly timeoutMilliseconds: number;
  readonly waitUntil: NavigationWaitUntil;
}

function navigationMilestoneMethods(waitUntil: NavigationWaitUntil): string[] {
  if (waitUntil === 'commit')
    return ['Page.frameNavigated', 'Page.navigatedWithinDocument'];
  return [
    waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired',
    'Page.navigatedWithinDocument',
  ];
}

function targetFromChange(
  change: TargetChange,
  targetId: string,
  priorGeneration: number,
): PublishedTarget | undefined {
  if (change.kind === 'snapshot')
    return change.targets.find(target => target.id === targetId && target.generation > priorGeneration);
  if (
    (change.kind === 'published' || change.kind === 'updated')
    && change.target.id === targetId
    && change.target.generation > priorGeneration
  ) return change.target;
  return undefined;
}

async function waitForRenewedTarget(
  client: McpChromeDebuggerBridgeClient,
  input: Pick<LifecycleInput, 'targetGeneration' | 'targetId' | 'timeoutMilliseconds'>,
  signal: AbortSignal,
): Promise<PublishedTarget> {
  const existingTarget = (await client.listTargets()).find(
    target => target.id === input.targetId && target.generation > input.targetGeneration,
  );
  if (existingTarget !== undefined) return existingTarget;
  const iterator = client.watchTargets()[Symbol.asyncIterator]();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortRenewal = (): void => rejectAbort?.(
    new McpToolError('MCP_WAIT_CANCELLED', 'The navigation wait was cancelled.'),
  );
  signal.addEventListener('abort', abortRenewal, { once: true });
  if (signal.aborted) abortRenewal();
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new McpToolError(
        'MCP_TARGET_RENEWAL_TIMEOUT',
        'The target did not publish renewed authority before the navigation timeout.',
        { targetId: input.targetId },
        true,
      )),
      input.timeoutMilliseconds,
    );
  });
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), abortPromise, timeoutPromise]);
      if (result.done)
        throw new McpToolError('MCP_TARGET_RENEWAL_TIMEOUT', 'Target watching ended before authority renewal.', { targetId: input.targetId }, true);
      const target = targetFromChange(result.value, input.targetId, input.targetGeneration);
      if (target !== undefined) return target;
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener('abort', abortRenewal);
    await iterator.return?.();
  }
}

async function waitForSubscriptions(
  milestoneSubscriptions: readonly CdpSubscription[],
  dialogSubscription: CdpSubscription,
  timeoutMilliseconds: number,
  signal: AbortSignal,
): Promise<CdpEvent> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const milestonePromises = milestoneSubscriptions.map(async (subscription) => {
    const result = await subscription[Symbol.asyncIterator]().next();
    if (result.done)
      throw new McpToolError('MCP_TARGET_RENEWAL_TIMEOUT', 'The navigation subscription ended during authority renewal.', undefined, true);
    return result.value;
  });
  const dialogPromise = dialogSubscription[Symbol.asyncIterator]().next().then((result): never => {
    if (result.done)
      throw new McpToolError('MCP_TARGET_RENEWAL_TIMEOUT', 'The dialog subscription ended during authority renewal.', undefined, true);
    throw new McpToolError(
      'MCP_JAVASCRIPT_DIALOG_OPEN',
      'A JavaScript dialog interrupted navigation.',
      result.value.parameters,
    );
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortWait = (): void => rejectAbort?.(
    new McpToolError('MCP_WAIT_CANCELLED', 'The navigation wait was cancelled.'),
  );
  signal.addEventListener('abort', abortWait, { once: true });
  if (signal.aborted) abortWait();
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new McpToolError('MCP_NAVIGATION_TIMEOUT', 'Navigation did not reach the requested milestone.', undefined, true)),
      timeoutMilliseconds,
    );
  });
  try {
    return await Promise.race([
      ...milestonePromises,
      dialogPromise,
      abortPromise,
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener('abort', abortWait);
  }
}

async function executeLifecycleAction(
  client: McpChromeDebuggerBridgeClient,
  input: LifecycleInput,
  commandMethods: readonly string[],
  runCommand: (
    execute: (method: string, parameters: JsonObject) => Promise<unknown>,
  ) => Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const milestoneMethods = navigationMilestoneMethods(input.waitUntil);
  const requestedMethods = [
    ...commandMethods,
    ...milestoneMethods,
    'Page.javascriptDialogOpening',
  ];
  const deadline = Date.now() + input.timeoutMilliseconds;
  const renewalAbortController = new AbortController();
  const relayAbort = (): void => renewalAbortController.abort();
  signal.addEventListener('abort', relayAbort, { once: true });
  const renewedTarget = waitForRenewedTarget(
    client,
    input,
    renewalAbortController.signal,
  );
  renewedTarget.catch(() => {});
  try {
    const result = await executeInputAction(
      client,
      input,
      requestedMethods,
      signal,
      async (execute, _executeCleanup, lease) => {
        const milestoneSubscriptions = await Promise.all(milestoneMethods.map(async method => client.subscribe({
          buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
          leaseId: lease.id,
          match: { method },
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        })));
        const dialogSubscription = await client.subscribe({
          buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
          leaseId: lease.id,
          match: { method: 'Page.javascriptDialogOpening' },
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          targetGeneration: input.targetGeneration,
          targetId: input.targetId,
        });
        try {
          const commandResult = await runCommand(execute);
          const navigationValue = commandResultValue(commandResult);
          const errorText = stringValue(property(navigationValue, 'errorText'));
          if (errorText !== undefined && errorText.length > 0)
            throw new McpToolError('MCP_NAVIGATION_FAILED', errorText);
          const remainingMilliseconds = Math.max(1, deadline - Date.now());
          const waitAfterAuthorityRenewal = async (target: PublishedTarget): Promise<CdpEvent | 'authority-renewed'> => {
            if (input.waitUntil === 'commit') return 'authority-renewed';
            return waitForEvent(client, {
              method: input.waitUntil === 'load'
                ? 'Page.loadEventFired'
                : 'Page.domContentEventFired',
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
              targetGeneration: target.generation,
              targetId: input.targetId,
              timeoutMilliseconds: Math.max(1, deadline - Date.now()),
            }, signal);
          };
          const loaderId = stringValue(property(navigationValue, 'loaderId'));
          if (input.sessionId === undefined && loaderId !== undefined) {
            const target = await renewedTarget;
            return { command: commandResult, milestone: await waitAfterAuthorityRenewal(target) };
          }
          const milestoneWait = waitForSubscriptions(
            milestoneSubscriptions,
            dialogSubscription,
            remainingMilliseconds,
            signal,
          ).catch(async (error: unknown) => {
            if (property(error, 'code') !== 'MCP_TARGET_RENEWAL_TIMEOUT') throw error;
            return { renewedTarget: await renewedTarget };
          });
          const milestone = await Promise.race([
            milestoneWait,
            renewedTarget.then(target => ({ renewedTarget: target })),
          ]);
          if ('renewedTarget' in milestone) {
            return {
              command: commandResult,
              milestone: await waitAfterAuthorityRenewal(milestone.renewedTarget),
            };
          }
          return { command: commandResult, milestone };
        } finally {
          for (const subscription of milestoneSubscriptions) subscription.close();
          dialogSubscription.close();
        }
      },
    );
    let currentTarget = (await client.listTargets()).find(target => target.id === input.targetId);
    if (currentTarget === undefined)
      throw new McpToolError('TARGET_NOT_FOUND', 'The navigated target is no longer available.');
    const milestone = property(result, 'milestone');
    const sameDocument = property(milestone, 'method') === 'Page.navigatedWithinDocument';
    if (
      input.sessionId === undefined
      && !sameDocument
      && currentTarget.generation <= input.targetGeneration
    ) currentTarget = await renewedTarget;
    return { ...result as JsonObject, target: currentTarget };
  } finally {
    renewalAbortController.abort();
    signal.removeEventListener('abort', relayAbort);
  }
}

async function waitForEvent(
  client: McpChromeDebuggerBridgeClient,
  input: {
    readonly leaseId?: string;
    readonly method: string;
    readonly sessionId?: string | undefined;
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
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
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

async function waitForNavigationEvent(
  client: McpChromeDebuggerBridgeClient,
  input: LifecycleInput,
  signal: AbortSignal,
): Promise<CdpEvent> {
  const milestoneMethods = navigationMilestoneMethods(input.waitUntil);
  return withLease(
    client,
    input,
    'shared-read',
    [...milestoneMethods, 'Page.javascriptDialogOpening'],
    async (lease) => {
      const milestoneSubscriptions = await Promise.all(milestoneMethods.map(async method => client.subscribe({
        buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
        leaseId: lease.id,
        match: { method },
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      })));
      const dialogSubscription = await client.subscribe({
        buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
        leaseId: lease.id,
        match: { method: 'Page.javascriptDialogOpening' },
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        targetGeneration: input.targetGeneration,
        targetId: input.targetId,
      });
      try {
        return await waitForSubscriptions(
          milestoneSubscriptions,
          dialogSubscription,
          input.timeoutMilliseconds,
          signal,
        );
      } finally {
        for (const subscription of milestoneSubscriptions) subscription.close();
        dialogSubscription.close();
      }
    },
  );
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
  const pointerPositions = new Map<string, ViewportPoint>();
  const inputModifiersSchema = z
    .array(z.enum(['alt', 'control', 'meta', 'shift']))
    .max(4)
    .default([]);
  const pointerButtonSchema = z
    .enum(['back', 'forward', 'left', 'middle', 'right'])
    .default('left');
  const nodeReferenceSchema = z.object({
    backendNodeId: z.number().int().positive(),
    sessionId: z.string().uuid().optional(),
  });
  const inputActionTiming = {
    durationMilliseconds: z
      .number()
      .int()
      .nonnegative()
      .max(maximumInputActionDurationMilliseconds)
      .default(0),
    steps: z
      .number()
      .int()
      .positive()
      .max(maximumInputActionSteps)
      .default(1),
  };
  const lifecycleInput = {
    ...targetInput,
    sessionId: z.string().uuid().optional(),
    timeoutMilliseconds: z.number().int().positive().max(30_000).default(10_000),
    waitUntil: z.enum(['commit', 'domcontentloaded', 'load']).default('load'),
  };
  const navigateHistory = async (
    input: LifecycleInput,
    offset: -1 | 1,
    signal: AbortSignal,
  ): Promise<unknown> => executeLifecycleAction(
    client,
    input,
    ['Page.getNavigationHistory', 'Page.navigateToHistoryEntry'],
    async (execute) => {
      const historyResult = await execute('Page.getNavigationHistory', {});
      const history = commandResultValue(historyResult);
      const currentIndex = numberValue(property(history, 'currentIndex'));
      const entries = arrayValue(property(history, 'entries'));
      const entry = currentIndex === undefined ? undefined : entries[currentIndex + offset];
      const entryId = numberValue(property(entry, 'id'));
      if (entryId === undefined)
        throw new McpToolError('MCP_HISTORY_UNAVAILABLE', 'There is no navigation history entry in that direction.');
      return execute('Page.navigateToHistoryEntry', { entryId });
    },
    signal,
  );
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
        'Capture an agent-readable structural DOM tree through read leases, including backendNodeId and opaque child-session references for semantic node actions. Large CDP responses are read and released internally; use browser.raw_cdp with DOMSnapshot.captureSnapshot only when the lossless response is required.',
      inputSchema: z.object({
        ...targetInput,
        maximumDepth: z.number().int().nonnegative().max(50).default(20),
        maximumNodes: z.number().int().positive().max(5_000).default(1_500),
      }),
    },
    async (input, context) => {
      try {
        const listedSessions = await executeSemanticCommand(
          client,
          input,
          'shared-read',
          'Bridge.listChildSessions',
          {},
          context.mcpReq.signal,
        );
        const iframeSessions = childSessionReferences(listedSessions)
          .filter(session => session.type === 'iframe')
          .slice(0, 16);
        const capture = async (
          maximumNodes: number,
          sessionId?: string,
        ): Promise<FormattedDomSnapshot> => {
          const commandValue = await executeArtifactCommand(
            client,
            { ...input, ...(sessionId === undefined ? {} : { sessionId }) },
            'DOMSnapshot.captureSnapshot',
            {
              computedStyles: [],
              includeDOMRects: false,
              includePaintOrder: false,
            },
          );
          return formatDomSnapshot(
            await readableCommandValue(
              client,
              input,
              commandValue,
              context.mcpReq.signal,
            ),
            {
              maximumDepth: input.maximumDepth,
              maximumNodes,
            },
          );
        };
        const rootSnapshot = await capture(input.maximumNodes);
        const sections = [`# Root session\n${rootSnapshot.text}`];
        let remainingNodes = Math.max(
          0,
          input.maximumNodes - rootSnapshot.renderedNodes,
        );
        for (const [sessionIndex, session] of iframeSessions.entries()) {
          if (remainingNodes === 0) break;
          const remainingSessions = iframeSessions.length - sessionIndex;
          const sessionMaximumNodes = Math.max(
            1,
            Math.floor(remainingNodes / remainingSessions),
          );
          const sessionSnapshot = await capture(sessionMaximumNodes, session.id);
          sections.push(
            `# Child session [sessionId=${session.id}] [sessionGeneration=${session.generation}] [type=${session.type}]\n${sessionSnapshot.text}`,
          );
          remainingNodes = Math.max(
            0,
            remainingNodes - sessionSnapshot.renderedNodes,
          );
        }
        return textContent(
          sections.join('\n\n').slice(0, maximumSnapshotCharacters),
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
        'Navigate an authorized target, wait for a bounded lifecycle milestone, and return the current target generation.',
      inputSchema: z.object({ ...lifecycleInput, url: z.url() }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(
          await executeLifecycleAction(
            client,
            input,
            ['Page.navigate'],
            async execute => execute('Page.navigate', { url: input.url }),
            ctx.mcpReq.signal,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.back',
    {
      description: 'Navigate one entry back and return the current target generation after a bounded lifecycle wait.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await navigateHistory(input, -1, ctx.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.forward',
    {
      description: 'Navigate one entry forward and return the current target generation after a bounded lifecycle wait.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await navigateHistory(input, 1, ctx.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.reload',
    {
      description: 'Reload an authorized target and return its current generation after a bounded lifecycle wait.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await executeLifecycleAction(
          client,
          input,
          ['Page.reload'],
          async execute => execute('Page.reload', {}),
          ctx.mcpReq.signal,
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.click',
    {
      description:
        'Click explicit viewport coordinates. Prefer browser.click_node when a snapshot reference is available.',
      inputSchema: z.object({
        ...targetInput,
        button: pointerButtonSchema,
        clickCount: z.number().int().positive().max(3).default(1),
        modifiers: inputModifiersSchema,
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    },
    async (input, ctx) => {
      try {
        const results: unknown[] = [];
        let buttonPressed = false;
        const modifiers = encodeInputModifiers(input.modifiers);
        await executeInputAction(
          client,
          input,
          ['Input.dispatchMouseEvent'],
          ctx.mcpReq.signal,
          async (execute, executeCleanup) => {
            try {
              for (let clickCount = 1; clickCount <= input.clickCount; clickCount += 1) {
                results.push(await execute('Input.dispatchMouseEvent', {
                  button: input.button,
                  clickCount,
                  modifiers,
                  type: 'mousePressed',
                  x: input.x,
                  y: input.y,
                }));
                buttonPressed = true;
                results.push(await execute('Input.dispatchMouseEvent', {
                  button: input.button,
                  clickCount,
                  modifiers,
                  type: 'mouseReleased',
                  x: input.x,
                  y: input.y,
                }));
                buttonPressed = false;
              }
            } finally {
              if (buttonPressed) {
                await executeCleanup('Input.dispatchMouseEvent', {
                  button: input.button,
                  clickCount: input.clickCount,
                  modifiers,
                  type: 'mouseReleased',
                  x: input.x,
                  y: input.y,
                });
              }
            }
          },
        );
        pointerPositions.set(pointerPositionKey(input), { x: input.x, y: input.y });
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.move',
    {
      description:
        'Move or hover the pointer at explicit viewport coordinates. Prefer browser.hover_node when a snapshot reference is available.',
      inputSchema: z.object({
        ...targetInput,
        ...inputActionTiming,
        modifiers: inputModifiersSchema,
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    },
    async (input, ctx) => {
      try {
        const destination = { x: input.x, y: input.y };
        const points = interpolateViewportPoints(
          pointerPositions.get(pointerPositionKey(input)) ?? destination,
          destination,
          input.steps,
        );
        const modifiers = encodeInputModifiers(input.modifiers);
        const stepDuration = input.durationMilliseconds / input.steps;
        const results: unknown[] = [];
        await executeInputAction(
          client,
          input,
          ['Input.dispatchMouseEvent'],
          ctx.mcpReq.signal,
          async (execute) => {
            for (const point of points) {
              results.push(await execute('Input.dispatchMouseEvent', {
                modifiers,
                type: 'mouseMoved',
                ...point,
              }));
              await waitForInputStep(stepDuration, ctx.mcpReq.signal);
            }
          },
        );
        pointerPositions.set(pointerPositionKey(input), destination);
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.scroll',
    {
      description: 'Dispatch a bounded mouse-wheel scroll at explicit viewport coordinates.',
      inputSchema: z.object({
        ...targetInput,
        ...inputActionTiming,
        deltaX: z.number().finite(),
        deltaY: z.number().finite(),
        modifiers: inputModifiersSchema,
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    },
    async (input, ctx) => {
      try {
        if (input.deltaX === 0 && input.deltaY === 0)
          throw new McpToolError('MCP_TOOL_FAILED', 'At least one scroll delta must be non-zero.');
        const modifiers = encodeInputModifiers(input.modifiers);
        const stepDuration = input.durationMilliseconds / input.steps;
        const results: unknown[] = [];
        await executeInputAction(
          client,
          input,
          ['Input.dispatchMouseEvent'],
          ctx.mcpReq.signal,
          async (execute) => {
            let dispatchedDeltaX = 0;
            let dispatchedDeltaY = 0;
            for (let step = 1; step <= input.steps; step += 1) {
              const deltaX = step === input.steps
                ? input.deltaX - dispatchedDeltaX
                : input.deltaX / input.steps;
              const deltaY = step === input.steps
                ? input.deltaY - dispatchedDeltaY
                : input.deltaY / input.steps;
              dispatchedDeltaX += deltaX;
              dispatchedDeltaY += deltaY;
              results.push(await execute('Input.dispatchMouseEvent', {
                deltaX,
                deltaY,
                modifiers,
                type: 'mouseWheel',
                x: input.x,
                y: input.y,
              }));
              await waitForInputStep(stepDuration, ctx.mcpReq.signal);
            }
          },
        );
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.drag',
    {
      description: 'Drag the pointer along a bounded viewport path.',
      inputSchema: z.object({
        ...targetInput,
        button: pointerButtonSchema,
        durationMilliseconds: inputActionTiming.durationMilliseconds,
        modifiers: inputModifiersSchema,
        path: z.array(z.object({
          x: z.number().nonnegative(),
          y: z.number().nonnegative(),
        })).min(2).max(maximumInputActionSteps),
      }),
    },
    async (input, ctx) => {
      try {
        const firstPoint = input.path[0];
        const lastPoint = input.path.at(-1);
        if (firstPoint === undefined || lastPoint === undefined)
          throw new McpToolError('MCP_TOOL_FAILED', 'The drag path is empty.');
        const modifiers = encodeInputModifiers(input.modifiers);
        const stepDuration = input.durationMilliseconds / (input.path.length - 1);
        const results: unknown[] = [];
        let buttonPressed = false;
        let currentPoint = firstPoint;
        await executeInputAction(
          client,
          input,
          ['Input.cancelDragging', 'Input.dispatchMouseEvent'],
          ctx.mcpReq.signal,
          async (execute, executeCleanup) => {
            try {
              results.push(await execute('Input.dispatchMouseEvent', {
                modifiers,
                type: 'mouseMoved',
                ...firstPoint,
              }));
              results.push(await execute('Input.dispatchMouseEvent', {
                button: input.button,
                buttons: pointerButtonValues[input.button],
                clickCount: 1,
                modifiers,
                type: 'mousePressed',
                ...firstPoint,
              }));
              buttonPressed = true;
              for (const point of input.path.slice(1)) {
                currentPoint = point;
                results.push(await execute('Input.dispatchMouseEvent', {
                  button: input.button,
                  buttons: pointerButtonValues[input.button],
                  modifiers,
                  type: 'mouseMoved',
                  ...point,
                }));
                await waitForInputStep(stepDuration, ctx.mcpReq.signal);
              }
              results.push(await execute('Input.dispatchMouseEvent', {
                button: input.button,
                clickCount: 1,
                modifiers,
                type: 'mouseReleased',
                ...lastPoint,
              }));
              buttonPressed = false;
            } finally {
              if (buttonPressed) {
                await executeCleanup('Input.dispatchMouseEvent', {
                  button: input.button,
                  clickCount: 1,
                  modifiers,
                  type: 'mouseReleased',
                  ...currentPoint,
                });
              }
              if (ctx.mcpReq.signal.aborted)
                await executeCleanup('Input.cancelDragging', {});
            }
          },
        );
        pointerPositions.set(pointerPositionKey(input), lastPoint);
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.click_node',
    {
      description:
        'Click a fresh, visible snapshot node after scrolling and hit-testing it. Prefer this over coordinate clicks.',
      inputSchema: z.object({
        ...targetInput,
        button: pointerButtonSchema,
        clickCount: z.number().int().positive().max(3).default(1),
        modifiers: inputModifiersSchema,
        node: nodeReferenceSchema,
      }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await executeNodeAction(client, {
          ...input,
          ...input.node,
        }, 'click', ctx.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.hover_node',
    {
      description:
        'Move the pointer to a fresh, visible snapshot node after scrolling and hit-testing it.',
      inputSchema: z.object({
        ...targetInput,
        modifiers: inputModifiersSchema,
        node: nodeReferenceSchema,
      }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await executeNodeAction(client, {
          ...input,
          ...input.node,
        }, 'hover', ctx.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.focus_node',
    {
      description:
        'Focus a fresh, visible snapshot node after scrolling and hit-testing it.',
      inputSchema: z.object({
        ...targetInput,
        node: nodeReferenceSchema,
      }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await executeNodeAction(client, {
          ...input,
          ...input.node,
        }, 'focus', ctx.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.type_node',
    {
      description:
        'Focus a fresh, visible editable snapshot node and insert text into it.',
      inputSchema: z.object({
        ...targetInput,
        node: nodeReferenceSchema,
        text: z.string().min(1),
      }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await executeNodeAction(client, {
          ...input,
          ...input.node,
        }, 'type', ctx.mcpReq.signal));
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
    async (input, ctx) => {
      try {
        const results: unknown[] = [];
        let keyPressed = false;
        await executeInputAction(
          client,
          input,
          ['Input.dispatchKeyEvent'],
          ctx.mcpReq.signal,
          async (execute, executeCleanup) => {
            try {
              results.push(await execute('Input.dispatchKeyEvent', {
                key: input.key,
                text: input.key,
                type: 'keyDown',
              }));
              keyPressed = true;
              results.push(await execute('Input.dispatchKeyEvent', {
                key: input.key,
                type: 'keyUp',
              }));
              keyPressed = false;
            } finally {
              if (keyPressed) {
                await executeCleanup('Input.dispatchKeyEvent', {
                  key: input.key,
                  type: 'keyUp',
                });
              }
            }
          },
        );
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const eventWaitInput = {
    ...targetInput,
    leaseId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    timeoutMilliseconds: z.number().int().positive().max(30_000).default(5_000),
  };
  register(
    'browser.wait_for_navigation',
    {
      description: 'Wait for a bounded root or child-session navigation milestone and fail promptly on JavaScript dialogs.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      const renewalAbortController = new AbortController();
      const renewedTarget = input.sessionId === undefined
        ? waitForRenewedTarget(client, input, renewalAbortController.signal)
        : undefined;
      renewedTarget?.catch(() => {});
      try {
        const event = await waitForNavigationEvent(client, input, ctx.mcpReq.signal);
        let currentTarget = (await client.listTargets()).find(target => target.id === input.targetId);
        if (currentTarget === undefined)
          throw new McpToolError('TARGET_NOT_FOUND', 'The navigated target is no longer available.');
        if (
          renewedTarget !== undefined
          && event.method !== 'Page.navigatedWithinDocument'
          && currentTarget.generation <= input.targetGeneration
        ) currentTarget = await renewedTarget;
        return jsonContent({ event, target: currentTarget });
      } catch (error) {
        return toolError(error);
      } finally {
        renewalAbortController.abort();
      }
    },
  );
  register(
    'browser.wait_for_dialog',
    {
      description: 'Wait for one JavaScript dialog in a root or opaque child session.',
      inputSchema: z.object(eventWaitInput),
    },
    async (input, ctx) => {
      try {
        const { leaseId, ...eventInput } = input;
        return jsonContent(await waitForEvent(client, {
          ...eventInput,
          ...(leaseId === undefined ? {} : { leaseId }),
          method: 'Page.javascriptDialogOpening',
        }, ctx.mcpReq.signal));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.handle_dialog',
    {
      description: 'Accept or dismiss the current JavaScript dialog through an exclusive lease.',
      inputSchema: z.object({
        ...targetInput,
        accept: z.boolean(),
        promptText: z.string().optional(),
        sessionId: z.string().uuid().optional(),
      }),
    },
    async (input, ctx) => {
      try {
        return jsonContent(await executeSemanticCommand(
          client,
          input,
          'exclusive-control',
          'Page.handleJavaScriptDialog',
          {
            accept: input.accept,
            ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
          },
          ctx.mcpReq.signal,
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  );
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
