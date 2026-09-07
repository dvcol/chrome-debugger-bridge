import type {
  ArtifactAccessRequest,
  ArtifactDescriptor,
  AutomationElementHandle,
  AutomationExecutionRequest,
  AutomationExecutionResult,
  AutomationLocator,
  AutomationLocatorStrategy,
  AutomationOperation,
  AutomationTextMatcher,
  CdpEvent,
  CdpSubscription,
  ChromeDebuggerBridgeClient,
  Lease,
  PublishedTarget,
  TargetChange,
} from '@dvcol/cdb';
import type { AgentSession } from '@dvcol/cdb/agent';
import type { JsonObject } from '@dvcol/cdb/protocol';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ServeStdioOptions } from '@modelcontextprotocol/server/stdio';
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from 'node:http';

import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { createAgentSession } from '@dvcol/cdb/agent';
import { requiredLeaseMode } from '@dvcol/cdb/cdp-catalogue';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

import packageManifest from '../package.json' with { type: 'json' };

export const supportedMcpProtocolVersions = ['2026-07-28'] as const;
export const supportedMcpSdkVersion = '2.0.0';
const cdpMethodPattern = /^[A-Za-z]+\.[A-Za-z]+$/u;
const detachedNodeMessagePattern = /No node with given|Could not find node|Node is detached/iu;
const providerReferenceAnnotationPattern = /\[ref=([^\]]+)\]/gu;
const elementReferencePattern = /^e[1-9]\d*$/u;
const maximumArtifactReadBytes = 49_152;
const maximumReadableSnapshotBytes = 16_777_216;
const maximumSnapshotCharacters = 120_000;
const maximumInteractiveSnapshotCharacters = 6_000;
const maximumInputActionSteps = 120;
const omittedTextElementNames = new Set(['noscript', 'script', 'style']);
const whitespacePattern = /\s+/gu;
const targetReferencePattern = /^t[1-9]\d*$/u;

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
  cancelAutomation?: (request: {
    readonly operationId: string;
    readonly targetGeneration: number;
    readonly targetId: string;
  }) => Promise<void>;
  cancelCommand: (request: {
    readonly operationId: string;
    readonly targetGeneration: number;
    readonly targetId: string;
  }) => Promise<void>;
  executeAutomation?: (
    request: AutomationExecutionRequest,
  ) => Promise<AutomationExecutionResult>;
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
  /** Routes semantic tools through the provider registered by the embedding broker. */
  readonly automationProvider?: 'registered';
  readonly client: McpChromeDebuggerBridgeClient;
  readonly enableRawCdp?: boolean;
  readonly timing?: Partial<McpTimingPolicy>;
}

export interface McpTimingPolicy {
  readonly defaultEventTimeoutMilliseconds: number;
  readonly defaultToolTimeoutMilliseconds: number;
  readonly maximumInputActionDurationMilliseconds: number;
  readonly maximumToolTimeoutMilliseconds: number;
  readonly semanticLeaseDurationMilliseconds: number;
}

export const defaultMcpTimingPolicy: Readonly<McpTimingPolicy> = Object.freeze({
  defaultEventTimeoutMilliseconds: 5_000,
  defaultToolTimeoutMilliseconds: 10_000,
  maximumInputActionDurationMilliseconds: 10_000,
  maximumToolTimeoutMilliseconds: 30_000,
  semanticLeaseDurationMilliseconds: 30_000,
});

function resolveMcpTimingPolicy(timing: Partial<McpTimingPolicy> | undefined): McpTimingPolicy {
  const resolved = { ...defaultMcpTimingPolicy, ...timing };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  if (resolved.defaultToolTimeoutMilliseconds > resolved.maximumToolTimeoutMilliseconds) {
    throw new TypeError('defaultToolTimeoutMilliseconds cannot exceed maximumToolTimeoutMilliseconds.');
  }
  if (resolved.defaultEventTimeoutMilliseconds > resolved.maximumToolTimeoutMilliseconds) {
    throw new TypeError('defaultEventTimeoutMilliseconds cannot exceed maximumToolTimeoutMilliseconds.');
  }
  return resolved;
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

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
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
  if (error instanceof Error && error.message.includes('CDB_RESULT_TOO_LARGE'))
    return toolError(new McpToolError('MCP_SEARCH_INCOMPLETE', 'Debugger discovery exceeded the response size limit. Narrow the query or scope.', { reason: 'result-too-large' }));
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

function semanticEvent(event: unknown): JsonObject {
  return {
    method: stringValue(property(event, 'method')) ?? 'unknown',
    parameters: objectValue(property(event, 'parameters')) as JsonObject,
  };
}

function semanticLifecycleResult(value: unknown, targetRef: string): JsonObject {
  const milestone = property(value, 'milestone');
  return {
    command: commandResultValue(property(value, 'command')) as JsonObject,
    milestone: milestone === 'authority-renewed' ? milestone : semanticEvent(milestone),
    target: { targetRef },
  };
}

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
  signal?.throwIfAborted();
  return withLease(client, input, mode, [method], async (lease) => {
    signal?.throwIfAborted();
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
    } catch (error) {
      throw signal?.aborted ? signal.reason : error;
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
  signal: AbortSignal,
): Promise<RetainedArtifactResult | unknown> {
  signal.throwIfAborted();
  const lease = await client.acquireLease({
    durationMilliseconds: 30_000,
    mode: 'shared-read',
    requestedMethods: [method],
    targetGeneration: input.targetGeneration,
    targetId: input.targetId,
  });
  let retainLease = false;
  const operationId = randomUUID();
  const abort = (): void => {
    void client.cancelCommand({
      operationId,
      targetGeneration: input.targetGeneration,
      targetId: input.targetId,
    }).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await client.executeCommand({
      leaseId: lease.id,
      method,
      operationId,
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
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  } finally {
    signal.removeEventListener('abort', abort);
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
  readonly frameId?: string;
  readonly generation: number;
  readonly id: string;
  readonly type: string;
  readonly url?: string;
}

function childSessionReferences(value: unknown): ChildSessionReference[] {
  const commandValue = property(value, 'value') ?? value;
  const sessions = arrayValue(property(commandValue, 'sessions'));
  return sessions.flatMap((session) => {
    const generation = numberValue(property(session, 'generation'));
    const id = stringValue(property(session, 'id'));
    const type = stringValue(property(session, 'type'));
    const frameId = stringValue(property(session, 'frameId'));
    const url = stringValue(property(session, 'url'));
    return generation === undefined || id === undefined || type === undefined
      ? []
      : [{
          ...(frameId === undefined ? {} : { frameId }),
          generation,
          id,
          type,
          ...(url === undefined ? {} : { url }),
        }];
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
  releaseLease = true,
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
              maximumReadableSnapshotBytes,
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
        if (releaseLease) await client.releaseLease({
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
    execute: (method: string, parameters: JsonObject, sessionOverride?: string | null) => Promise<unknown>,
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
      const execute = async (method: string, parameters: JsonObject, sessionOverride?: string | null): Promise<unknown> => {
        if (signal.aborted)
          throw new McpToolError('MCP_WAIT_CANCELLED', 'The input action was cancelled.');
        activeOperationId = randomUUID();
        try {
          const result = await client.executeCommand({
            leaseId: lease.id,
            method,
            operationId: activeOperationId,
            parameters,
            ...((sessionOverride === undefined ? input.sessionId : sessionOverride) == null ? {} : { sessionId: (sessionOverride ?? input.sessionId) }),
            targetGeneration: input.targetGeneration,
            targetId: input.targetId,
          });
          const artifact = artifactFromCommandResult(result);
          return artifact === undefined ? result : { value: await readRetainedArtifact(client, input, { artifact, lease }, signal, false) };
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

function commandResultValue(value: unknown): unknown {
  return property(value, 'value') ?? value;
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

export interface SemanticTarget {
  readonly availability: PublishedTarget['availability'];
  readonly capabilities: PublishedTarget['capabilities'];
  readonly targetRef: string;
  readonly title?: string;
  readonly type: PublishedTarget['type'];
  readonly url?: string;
}

export interface CdbToolSession {
  readonly definitions: readonly CdbToolDefinition[];
  dispose: () => void;
  projectTarget: (target: PublishedTarget) => SemanticTarget | undefined;
  rebindClient: (client: McpChromeDebuggerBridgeClient) => void;
  revokeTarget: (targetId: string) => void;
  targetIdForReference: (targetRef: string) => string | undefined;
}

interface NativeElementReference {
  readonly backendNodeId: number;
  readonly generation: number;
  readonly sessionId?: string;
  readonly targetId: string;
}

interface ProviderElementReference {
  readonly generation: number;
  readonly providerElementHandleId: string;
  readonly targetId: string;
}

type ElementReference = NativeElementReference | ProviderElementReference;

interface CdbToolSessionState {
  readonly agentSession: AgentSession;
  disposed: boolean;
  nextElementReference: number;
  readonly elementReferences: Map<string, ElementReference>;
}

interface AccessibilityCandidate extends NativeElementReference {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly nodeName?: string;
  readonly role: string;
}

interface LocatorContext {
  readonly frameId?: string;
  readonly rootBackendNodeId?: number;
  readonly sessionId?: string;
}

interface TextMatch {
  readonly flags?: 'i' | 'iu' | 'u' | undefined;
  readonly match: 'exact' | 'regex' | 'substring';
  readonly pattern?: string;
  readonly value?: string;
}

interface SemanticLocatorStrategy {
  readonly altText?: TextMatch | undefined;
  readonly css?: string | undefined;
  readonly label?: TextMatch | undefined;
  readonly name?: TextMatch | undefined;
  readonly placeholder?: TextMatch | undefined;
  readonly role?: string | undefined;
  readonly testId?: TextMatch | undefined;
  readonly text?: TextMatch | undefined;
  readonly title?: TextMatch | undefined;
  readonly xpath?: string | undefined;
}

interface SemanticLocator extends SemanticLocatorStrategy {
  readonly descendants?: readonly SemanticLocatorStrategy[] | undefined;
  readonly exclude?: SemanticLocatorStrategy | undefined;
  readonly frameChain?: readonly SemanticLocatorStrategy[] | undefined;
  readonly has?: SemanticLocatorStrategy | undefined;
  readonly hasNotText?: TextMatch | undefined;
  readonly hasText?: TextMatch | undefined;
  readonly nth?: number | undefined;
  readonly visible?: boolean | undefined;
}

const interactiveAccessibilityRoles = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'rowheader',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

function createCdbToolSessionState(): CdbToolSessionState {
  return {
    agentSession: createAgentSession(),
    disposed: false,
    elementReferences: new Map(),
    nextElementReference: 1,
  };
}

function createRebindableMcpClient(initialClient: McpChromeDebuggerBridgeClient): {
  readonly client: McpChromeDebuggerBridgeClient;
  rebind: (client: McpChromeDebuggerBridgeClient) => void;
} {
  const holder: { current: McpChromeDebuggerBridgeClient } = { current: initialClient };
  const client: McpChromeDebuggerBridgeClient = {
    acquireLease: async request => holder.current.acquireLease(request),
    ...(initialClient.cancelAutomation === undefined
      ? {}
      : {
          cancelAutomation: async (request) => {
            const cancelAutomation = holder.current.cancelAutomation;
            if (cancelAutomation === undefined) throw new Error('The rebound client does not support automation.');
            await cancelAutomation(request);
          },
        }),
    cancelCommand: async request => holder.current.cancelCommand(request),
    ...(initialClient.executeAutomation === undefined
      ? {}
      : {
          executeAutomation: async (request) => {
            const executeAutomation = holder.current.executeAutomation;
            if (executeAutomation === undefined) throw new Error('The rebound client does not support automation.');
            return executeAutomation(request);
          },
        }),
    executeCommand: async command => holder.current.executeCommand(command),
    listTargets: async () => holder.current.listTargets(),
    readArtifact: async (request, signal) => holder.current.readArtifact(request, signal),
    releaseArtifact: async request => holder.current.releaseArtifact(request),
    releaseLease: async request => holder.current.releaseLease(request),
    renewLease: async request => holder.current.renewLease(request),
    subscribe: async request => holder.current.subscribe(request),
    watchTargets: () => holder.current.watchTargets(),
  };
  return {
    client,
    rebind(nextClient) {
      holder.current = nextClient;
    },
  };
}

function projectSemanticTarget(
  state: CdbToolSessionState,
  target: PublishedTarget,
): SemanticTarget | undefined {
  if (state.disposed) return undefined;
  const targetRef = state.agentSession.project([target])[0]!.targetReference;
  return {
    availability: target.availability,
    capabilities: target.capabilities,
    targetRef,
    ...(target.title === undefined ? {} : { title: target.title }),
    type: target.type,
    ...(target.url === undefined ? {} : { url: target.url }),
  };
}

async function resolveSemanticTarget(
  client: McpChromeDebuggerBridgeClient,
  state: CdbToolSessionState,
  targetRef: string,
): Promise<PublishedTarget> {
  const targetId = state.agentSession.resolve(targetRef)?.targetId;
  if (targetId === undefined)
    throw new McpToolError('MCP_TARGET_REF_STALE', `Target reference ${targetRef} is no longer available.`);
  const target = (await client.listTargets()).find(candidate => candidate.id === targetId);
  if (target === undefined)
    throw new McpToolError('MCP_TARGET_REF_STALE', `Target reference ${targetRef} is no longer available.`);
  return target;
}

function accessibilityValue(value: unknown): string | undefined {
  const rawValue = property(value, 'value');
  if (typeof rawValue === 'string') return rawValue;
  if (typeof rawValue === 'number' || typeof rawValue === 'boolean')
    return String(rawValue);
  return undefined;
}

function matchesText(value: string | undefined, matcher: TextMatch | undefined): boolean {
  if (matcher === undefined) return true;
  if (value === undefined) return false;
  if (matcher.match === 'regex')
    return new RegExp(matcher.pattern ?? '', matcher.flags ?? 'u').test(value);
  const expected = matcher.value ?? '';
  return matcher.match === 'exact' ? value === expected : value.includes(expected);
}

function accessibilityCandidates(value: unknown, reference: Omit<NativeElementReference, 'backendNodeId'>): AccessibilityCandidate[] {
  return arrayValue(property(value, 'nodes')).flatMap((node) => {
    if (property(node, 'ignored') === true) return [];
    const backendNodeId = numberValue(property(node, 'backendDOMNodeId'));
    if (backendNodeId === undefined) return [];
    const name = accessibilityValue(property(node, 'name'));
    return [{
      ...reference,
      backendNodeId,
      ...(name === undefined ? {} : { name }),
      role: accessibilityValue(property(node, 'role')) ?? 'generic',
    }];
  });
}

function allocateElementReference(
  state: CdbToolSessionState,
  element: ElementReference,
): string {
  const reference = `e${state.nextElementReference}`;
  state.nextElementReference += 1;
  state.elementReferences.set(reference, element);
  return reference;
}

function automationTextMatcher(matcher: TextMatch | undefined): AutomationTextMatcher | undefined {
  if (matcher === undefined) return undefined;
  if (matcher.match === 'regex') {
    return {
      regex: {
        ...(matcher.flags === undefined ? {} : { flags: matcher.flags }),
        source: matcher.pattern ?? '',
      },
    };
  }
  return {
    exact: matcher.match === 'exact',
    pattern: matcher.value ?? '',
  };
}

function automationLocatorStrategy(locator: SemanticLocatorStrategy): AutomationLocatorStrategy {
  const altText = automationTextMatcher(locator.altText);
  const label = automationTextMatcher(locator.label);
  const name = automationTextMatcher(locator.name);
  const placeholder = automationTextMatcher(locator.placeholder);
  const testId = automationTextMatcher(locator.testId);
  const text = automationTextMatcher(locator.text);
  const title = automationTextMatcher(locator.title);
  return {
    ...(altText === undefined ? {} : { altText }),
    ...(locator.css === undefined ? {} : { css: locator.css }),
    ...(label === undefined ? {} : { label }),
    ...(name === undefined ? {} : { name }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(locator.role === undefined ? {} : { role: locator.role }),
    ...(testId === undefined ? {} : { testId }),
    ...(text === undefined ? {} : { text }),
    ...(title === undefined ? {} : { title }),
    ...(locator.xpath === undefined ? {} : { xpath: locator.xpath }),
  };
}

function automationLocator(locator: SemanticLocator): AutomationLocator {
  const hasNotText = automationTextMatcher(locator.hasNotText);
  const hasText = automationTextMatcher(locator.hasText);
  return {
    ...automationLocatorStrategy(locator),
    ...(locator.descendants === undefined
      ? {}
      : { descendants: locator.descendants.map(automationLocatorStrategy) }),
    ...(locator.exclude === undefined
      ? {}
      : { exclude: automationLocatorStrategy(locator.exclude) }),
    ...(locator.frameChain === undefined
      ? {}
      : { frameChain: locator.frameChain.map(automationLocatorStrategy) }),
    ...(locator.has === undefined
      ? {}
      : { has: automationLocatorStrategy(locator.has) }),
    ...(hasNotText === undefined ? {} : { hasNotText }),
    ...(hasText === undefined ? {} : { hasText }),
    ...(locator.nth === undefined ? {} : { nth: locator.nth }),
    ...(locator.visible === undefined ? {} : { visible: locator.visible }),
  };
}

function providerElementHandle(
  state: CdbToolSessionState,
  target: PublishedTarget,
  reference: string | undefined,
): string | undefined {
  if (reference === undefined) return undefined;
  const element = state.elementReferences.get(reference);
  if (
    element === undefined
    || element.targetId !== target.id
    || element.generation !== target.generation
    || !('providerElementHandleId' in element)
  )
    throw new McpToolError('MCP_ELEMENT_REF_STALE', `Element reference ${reference} is stale.`);
  return element.providerElementHandleId;
}

function automationElementTarget(
  state: CdbToolSessionState,
  target: PublishedTarget,
  input: {
    readonly locator?: SemanticLocator | undefined;
    readonly ref?: string | undefined;
  },
): { readonly elementHandleId?: string; readonly locator?: AutomationLocator } {
  const elementHandleId = providerElementHandle(state, target, input.ref);
  return {
    ...(elementHandleId === undefined ? {} : { elementHandleId }),
    ...(input.locator === undefined
      ? {}
      : { locator: automationLocator(input.locator) }),
  };
}

async function executeRegisteredAutomation(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  operation: AutomationOperation,
  signal: AbortSignal,
): Promise<AutomationExecutionResult> {
  if (client.executeAutomation === undefined || client.cancelAutomation === undefined) {
    throw new McpToolError(
      'MCP_AUTOMATION_PROVIDER_UNAVAILABLE',
      'The embedding broker did not expose its configured automation provider.',
      undefined,
      true,
    );
  }
  const mode = operation.kind === 'action' ? 'exclusive-control' : 'shared-read';
  return withLease(
    client,
    { targetGeneration: target.generation, targetId: target.id },
    mode,
    [],
    async (lease) => {
      const operationId = randomUUID();
      const abort = (): void => {
        void client.cancelAutomation?.({
          operationId,
          targetGeneration: target.generation,
          targetId: target.id,
        }).catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        try {
          return await client.executeAutomation?.({
            leaseId: lease.id,
            operation,
            operationId,
            targetGeneration: target.generation,
            targetId: target.id,
          }) as AutomationExecutionResult;
        } catch (error) {
          const automationCode = stringValue(property(property(error, 'details'), 'automationCode'));
          const mcpCodes: Readonly<Record<string, string>> = {
            AUTOMATION_ACTION_OUTCOME_UNKNOWN: 'MCP_ACTION_OUTCOME_UNKNOWN',
            AUTOMATION_ELEMENT_COVERED: 'MCP_ELEMENT_COVERED',
            AUTOMATION_ELEMENT_DETACHED: 'MCP_ELEMENT_DETACHED',
            AUTOMATION_ELEMENT_DISABLED: 'MCP_ELEMENT_DISABLED',
            AUTOMATION_ELEMENT_HIDDEN: 'MCP_ELEMENT_HIDDEN',
            AUTOMATION_ELEMENT_NOT_EDITABLE: 'MCP_ELEMENT_NOT_EDITABLE',
            AUTOMATION_ELEMENT_UNSTABLE: 'MCP_ELEMENT_UNSTABLE',
            AUTOMATION_LOCATOR_AMBIGUOUS: 'MCP_LOCATOR_AMBIGUOUS',
            AUTOMATION_LOCATOR_NOT_FOUND: 'MCP_LOCATOR_NOT_FOUND',
            AUTOMATION_PROVIDER_FAILED: 'MCP_AUTOMATION_PROVIDER_FAILED',
          };
          const mcpCode = automationCode === undefined ? undefined : mcpCodes[automationCode];
          if (mcpCode === undefined) throw error;
          throw new McpToolError(
            mcpCode,
            error instanceof Error ? error.message : 'The configured automation provider failed.',
            property(error, 'details') as JsonObject | undefined,
            property(error, 'retryable') === true,
          );
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  );
}

function allocateProviderElements(
  state: CdbToolSessionState,
  target: PublishedTarget,
  elements: readonly AutomationElementHandle[] | undefined,
): readonly { readonly element: AutomationElementHandle; readonly ref: string }[] {
  return (elements ?? []).map(element => ({
    element,
    ref: allocateElementReference(state, {
      generation: target.generation,
      providerElementHandleId: element.id,
      targetId: target.id,
    }),
  }));
}

async function accessibilityFrameContexts(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  contexts: readonly LocatorContext[],
  signal: AbortSignal,
): Promise<LocatorContext[]> {
  const output: LocatorContext[] = [];
  const sessionFrames = new Set<string>();
  for (const context of contexts) {
    const result = commandResultValue(await executeSemanticCommand(client, { targetId: target.id, targetGeneration: target.generation, ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }) }, 'shared-read', 'Page.getFrameTree', {}, signal));
    const tree = property(result, 'frameTree');
    const rootFrameId = stringValue(property(property(tree, 'frame'), 'id'));
    if (rootFrameId === undefined) {
      output.push(context);
      continue;
    }
    sessionFrames.add(rootFrameId);
    const pending = [tree];
    while (pending.length > 0) {
      if (output.length >= 128) throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'Frame discovery exceeded 128 frames. Narrow the scope.');
      const current = pending.pop();
      const frameId = stringValue(property(property(current, 'frame'), 'id'));
      if (frameId !== undefined) output.push({ ...context, frameId });
      pending.push(...arrayValue(property(current, 'childFrames')));
    }
  }
  const ownedRoots = new Map<string, string | undefined>();
  for (const context of output) {
    if (context.frameId !== undefined && sessionFrames.has(context.frameId)) ownedRoots.set(context.frameId, context.sessionId);
  }
  return output.filter(context => context.frameId === undefined || !ownedRoots.has(context.frameId) || ownedRoots.get(context.frameId) === context.sessionId);
}

type ContainmentDocumentCache = Map<string, Promise<ReadonlyMap<number, number>>>;

async function collectAccessibilityCandidates(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  signal: AbortSignal,
  locator: SemanticLocatorStrategy,
  contexts?: readonly LocatorContext[],
  containmentDocuments: ContainmentDocumentCache = new Map(),
): Promise<AccessibilityCandidate[]> {
  const authority = { targetGeneration: target.generation, targetId: target.id };
  const resolvedContexts = contexts ?? await (async (): Promise<LocatorContext[]> => {
    const listedSessions = await executeSemanticCommand(
      client,
      authority,
      'shared-read',
      'Bridge.listChildSessions',
      {},
      signal,
    );
    return [
      {},
      ...childSessionReferences(listedSessions)
        .filter(session => session.type === 'iframe')
        .map(session => ({ sessionId: session.id })),
    ];
  })();
  const candidates: AccessibilityCandidate[] = [];
  for (const context of contexts === undefined ? await accessibilityFrameContexts(client, target, resolvedContexts, signal) : resolvedContexts) {
    const sessionAuthority = {
      ...authority,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    };
    const exactAccessibleName = [locator.name, locator.text, locator.label].find(
      matcher => matcher?.match === 'exact',
    )?.value;
    const canQueryAccessibilityTree = context.frameId === undefined && (locator.role !== undefined || exactAccessibleName !== undefined);
    const commandValue = canQueryAccessibilityTree
      ? await (async (): Promise<unknown> => {
          const documentValue = commandResultValue(await executeSemanticCommand(
            client,
            sessionAuthority,
            'shared-read',
            'DOM.getDocument',
            { depth: 0, pierce: true },
            signal,
          ));
          const documentBackendNodeId = numberValue(property(property(documentValue, 'root'), 'backendNodeId'));
          const backendNodeId = context.rootBackendNodeId ?? documentBackendNodeId;
          if (backendNodeId === undefined) return { nodes: [] };
          return executeArtifactCommand(
            client,
            sessionAuthority,
            'Accessibility.queryAXTree',
            {
              ...(exactAccessibleName === undefined ? {} : { accessibleName: exactAccessibleName }),
              backendNodeId,
              ...(locator.role === undefined ? {} : { role: locator.role }),
            },
            signal,
          );
        })()
      : await executeArtifactCommand(
          client,
          sessionAuthority,
          'Accessibility.getFullAXTree',
          context.frameId === undefined ? {} : { frameId: context.frameId },
          signal,
        );
    const contextCandidates = accessibilityCandidates(await readableCommandValue(
      client,
      authority,
      commandValue,
      signal,
    ), {
      generation: target.generation,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      targetId: target.id,
    });
    if (context.rootBackendNodeId === undefined) {
      candidates.push(...contextCandidates);
      continue;
    }
    const rootCandidate: AccessibilityCandidate = {
      backendNodeId: context.rootBackendNodeId,
      generation: target.generation,
      role: 'document',
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      targetId: target.id,
    };
    for (const candidate of contextCandidates)
      if (await candidateContains(client, target, rootCandidate, candidate, signal, containmentDocuments)) candidates.push(candidate);
  }
  return candidates;
}

function matchesAccessibilityLocator(candidate: AccessibilityCandidate, locator: SemanticLocator): boolean {
  if (locator.role !== undefined && candidate.role !== locator.role) return false;
  if (!matchesText(candidate.name, locator.name)) return false;
  if (!matchesText(candidate.name, locator.text)) return false;
  if (!matchesText(candidate.name, locator.label)) return false;
  if (!matchesText(candidate.attributes?.placeholder, locator.placeholder)) return false;
  if (!matchesText(candidate.attributes?.alt, locator.altText)) return false;
  if (!matchesText(candidate.attributes?.title, locator.title)) return false;
  return matchesText(candidate.attributes?.['data-testid'], locator.testId);
}

function domNodeAttributes(node: unknown): Readonly<Record<string, string>> {
  const attributes = arrayValue(property(node, 'attributes'));
  const output: Record<string, string> = {};
  for (let index = 0; index < attributes.length; index += 2) {
    const name = stringValue(attributes[index]);
    const value = stringValue(attributes[index + 1]);
    if (name !== undefined && value !== undefined) output[name] = value;
  }
  return output;
}

function locatorDomQuery(locator: SemanticLocatorStrategy): string | undefined {
  if (locator.xpath !== undefined) return locator.xpath;
  if (locator.css !== undefined) return locator.css;
  const attributeLocator = [
    ['placeholder', locator.placeholder],
    ['alt', locator.altText],
    ['title', locator.title],
    ['data-testid', locator.testId],
  ] as const;
  for (const [attribute, matcher] of attributeLocator) {
    if (matcher === undefined) continue;
    if (matcher.match === 'exact')
      return `[${attribute}=${JSON.stringify(matcher.value ?? '')}]`;
    if (matcher.match === 'substring')
      return `[${attribute}*=${JSON.stringify(matcher.value ?? '')}]`;
    return `[${attribute}]`;
  }
  return undefined;
}

async function collectCssCandidates(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  query: string,
  context: LocatorContext,
  signal: AbortSignal,
): Promise<AccessibilityCandidate[]> {
  const authority = { targetId: target.id, targetGeneration: target.generation, ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }) };
  return withLease(client, authority, 'shared-read', ['DOM.getDocument', 'DOM.getFlattenedDocument', 'DOM.querySelectorAll', 'Accessibility.getFullAXTree'], async (lease) => {
    const execute = async (method: string, parameters: JsonObject): Promise<unknown> => {
      if (signal.aborted) throw new McpToolError('MCP_WAIT_CANCELLED', 'CSS discovery was cancelled.');
      const result = await client.executeCommand({ ...authority, leaseId: lease.id, operationId: randomUUID(), method, parameters });
      const artifact = artifactFromCommandResult(result);
      return artifact === undefined ? commandResultValue(result) : readRetainedArtifact(client, authority, { artifact, lease }, signal, false);
    };
    await execute('DOM.getDocument', { depth: 0, pierce: true });
    /** Flat protocol nodes avoid chrome.debugger's recursive JSON conversion stack limit. */
    const document = await execute('DOM.getFlattenedDocument', { depth: -1, pierce: true });
    const nodes = new Map<number, unknown>();
    const roots: number[] = [];
    const pending = [...arrayValue(property(document, 'nodes'))];
    const parents = new Map<number, number>();
    let visited = 0;
    while (pending.length > 0) {
      if (++visited > 100_000)
        throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'CSS discovery exceeded 100,000 DOM nodes. Narrow the search scope.');
      const node = pending.pop();
      const nodeId = numberValue(property(node, 'nodeId'));
      if (nodeId !== undefined) {
        nodes.set(nodeId, node);
        const parentId = numberValue(property(node, 'parentId'));
        if (parentId !== undefined) parents.set(nodeId, parentId);
        for (const root of arrayValue(property(node, 'shadowRoots'))) {
          const rootId = numberValue(property(root, 'nodeId'));
          if (rootId !== undefined) parents.set(rootId, nodeId);
        }
        if (property(node, 'nodeType') === 9 || ['open', 'closed'].includes(String(property(node, 'shadowRootType')))) roots.push(nodeId);
      }
      for (const key of ['children', 'contentDocument', 'shadowRoots', 'templateContent']) {
        const children = property(node, key);
        if (Array.isArray(children)) {
          for (const child of children) pending.push(child);
        } else if (children !== undefined) pending.push(children);
      }
    }
    if (roots.length === 0)
      throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'Chrome did not return a searchable document. Refresh the target.', undefined, true);
    const selected = new Set<number>();
    for (const nodeId of roots) {
      const result = await execute('DOM.querySelectorAll', { nodeId, selector: query });
      for (const selectedId of arrayValue(property(result, 'nodeIds'))) {
        if (typeof selectedId === 'number') selected.add(selectedId);
      }
    }
    const accessibility = await execute('Accessibility.getFullAXTree', {});
    const accessibleNodes = new Map(arrayValue(property(accessibility, 'nodes')).map(node => [numberValue(property(node, 'backendDOMNodeId')), node]));
    const scopeNodeId = context.rootBackendNodeId === undefined ? undefined : numberValue(property([...nodes.values()].find(node => property(node, 'backendNodeId') === context.rootBackendNodeId), 'nodeId'));
    if (context.rootBackendNodeId !== undefined && scopeNodeId === undefined)
      throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'The scoped document changed during discovery.');
    const candidates: AccessibilityCandidate[] = [];
    for (const nodeId of selected) {
      const node = nodes.get(nodeId);
      const backendNodeId = numberValue(property(node, 'backendNodeId'));
      if (backendNodeId === undefined)
        throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'The document changed during CSS discovery. Refresh the search.', undefined, true);
      if (scopeNodeId !== undefined) {
        let ancestorId: number | undefined = nodeId;
        const visitedAncestors = new Set<number>();
        while (ancestorId !== undefined && ancestorId !== scopeNodeId && !visitedAncestors.has(ancestorId)) {
          visitedAncestors.add(ancestorId);
          ancestorId = parents.get(ancestorId);
        }
        if (ancestorId !== scopeNodeId) continue;
      }
      const accessibleNode = accessibleNodes.get(backendNodeId);
      const name = accessibilityValue(property(accessibleNode, 'name'));
      const nodeName = stringValue(property(node, 'nodeName'));
      candidates.push({ attributes: domNodeAttributes(node), backendNodeId, generation: target.generation, ...(name === undefined ? {} : { name }), ...(nodeName === undefined ? {} : { nodeName }), role: accessibilityValue(property(accessibleNode, 'role')) ?? 'generic', ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }), targetId: target.id });
    }
    return candidates;
  });
}

async function collectDomSearchCandidates(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  locator: SemanticLocatorStrategy,
  signal: AbortSignal,
  contexts?: readonly LocatorContext[],
  containmentDocuments: ContainmentDocumentCache = new Map(),
): Promise<AccessibilityCandidate[]> {
  const query = locatorDomQuery(locator);
  if (query === undefined) return [];
  const authority = { targetGeneration: target.generation, targetId: target.id };
  const resolvedContexts = contexts ?? await (async (): Promise<LocatorContext[]> => {
    const listedSessions = await executeSemanticCommand(
      client,
      authority,
      'shared-read',
      'Bridge.listChildSessions',
      {},
      signal,
    );
    return [
      {},
      ...childSessionReferences(listedSessions)
        .filter(session => session.type === 'iframe')
        .map(session => ({ sessionId: session.id })),
    ];
  })();
  const candidates: AccessibilityCandidate[] = [];
  for (const context of resolvedContexts) {
    if (locator.xpath === undefined) {
      candidates.push(...await collectCssCandidates(client, target, query, context, signal));
      continue;
    }
    const sessionId = context.sessionId;
    const sessionAuthority = {
      ...authority,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    await withLease(
      client,
      authority,
      'shared-read',
      [
        'Accessibility.getPartialAXTree',
        'DOM.describeNode',
        'DOM.discardSearchResults',
        'DOM.getDocument',
        'DOM.getSearchResults',
        'DOM.performSearch',
      ],
      async (lease) => {
        const execute = async (method: string, parameters: JsonObject): Promise<unknown> => {
          if (signal.aborted)
            throw new McpToolError('MCP_WAIT_CANCELLED', 'The locator search was cancelled.');
          return client.executeCommand({
            leaseId: lease.id,
            method,
            operationId: randomUUID(),
            parameters,
            ...(sessionAuthority.sessionId === undefined ? {} : { sessionId: sessionAuthority.sessionId }),
            targetGeneration: target.generation,
            targetId: target.id,
          });
        };
        await execute('DOM.getDocument', { depth: 0, pierce: true });
        const search = commandResultValue(await execute('DOM.performSearch', {
          includeUserAgentShadowDOM: false,
          query,
        }));
        const searchId = stringValue(property(search, 'searchId'));
        const resultCount = numberValue(property(search, 'resultCount')) ?? 0;
        if (searchId === undefined || resultCount === 0) return;
        try {
          if (resultCount > 10_000)
            throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'The search exceeded 10,000 candidates. Narrow the locator or its scope.', { resultCount });
          const results = commandResultValue(await execute('DOM.getSearchResults', {
            fromIndex: 0,
            searchId,
            toIndex: resultCount,
          }));
          for (const nodeIdValue of arrayValue(property(results, 'nodeIds'))) {
            const nodeId = numberValue(nodeIdValue);
            if (nodeId === undefined) continue;
            const described = commandResultValue(await execute('DOM.describeNode', {
              depth: 0,
              nodeId,
              pierce: true,
            }));
            const node = property(described, 'node');
            const backendNodeId = numberValue(property(node, 'backendNodeId'));
            if (backendNodeId === undefined) continue;
            const partialTree = commandResultValue(await execute('Accessibility.getPartialAXTree', {
              backendNodeId,
              fetchRelatives: false,
            }));
            const accessibilityNode = arrayValue(property(partialTree, 'nodes'))[0];
            const name = accessibilityValue(property(accessibilityNode, 'name'));
            const nodeName = stringValue(property(node, 'nodeName'));
            const candidate: AccessibilityCandidate = {
              attributes: domNodeAttributes(node),
              backendNodeId,
              generation: target.generation,
              ...(name === undefined ? {} : { name }),
              ...(nodeName === undefined ? {} : { nodeName }),
              role: accessibilityValue(property(accessibilityNode, 'role')) ?? 'generic',
              ...(sessionId === undefined ? {} : { sessionId }),
              targetId: target.id,
            };
            if (context.rootBackendNodeId === undefined) {
              candidates.push(candidate);
            } else {
              const rootCandidate: AccessibilityCandidate = {
                backendNodeId: context.rootBackendNodeId,
                generation: target.generation,
                role: 'document',
                ...(sessionId === undefined ? {} : { sessionId }),
                targetId: target.id,
              };
              if (await candidateContains(client, target, rootCandidate, candidate, signal, containmentDocuments)) candidates.push(candidate);
            }
          }
        } finally {
          try {
            await execute('DOM.discardSearchResults', { searchId });
          } catch {
            /** Search state is scoped to the current document and can disappear during navigation. */
          }
        }
      },
    );
  }
  return candidates;
}

async function resolveLocatorCandidates(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  locator: SemanticLocator,
  signal: AbortSignal,
): Promise<AccessibilityCandidate[]> {
  const containmentDocuments: ContainmentDocumentCache = new Map();
  const resolveStrategy = async (
    strategy: SemanticLocatorStrategy,
    contexts: readonly LocatorContext[] | undefined,
  ): Promise<AccessibilityCandidate[]> => {
    const candidates = locatorDomQuery(strategy) === undefined
      ? await collectAccessibilityCandidates(client, target, signal, strategy, contexts, containmentDocuments)
      : await collectDomSearchCandidates(client, target, strategy, signal, contexts, containmentDocuments);
    return candidates.filter(candidate => matchesAccessibilityLocator(candidate, strategy));
  };
  let contexts: LocatorContext[] | undefined;
  if ((locator.frameChain?.length ?? 0) > 0) {
    contexts = [{}];
    const authority = { targetGeneration: target.generation, targetId: target.id };
    const listedSessions = await executeSemanticCommand(
      client,
      authority,
      'shared-read',
      'Bridge.listChildSessions',
      {},
      signal,
    );
    const childSessions = childSessionReferences(listedSessions).filter(session => session.type === 'iframe');
    for (const frameLocator of locator.frameChain ?? []) {
      const frameCandidates = await resolveStrategy(frameLocator, contexts);
      if (frameCandidates.length === 0)
        throw new McpToolError('MCP_LOCATOR_NOT_FOUND', 'A frame locator did not match a frame.', undefined, true);
      if (frameCandidates.length > 1)
        throw new McpToolError('MCP_LOCATOR_AMBIGUOUS', `A frame locator matched ${frameCandidates.length} frames.`);
      const frameCandidate = frameCandidates[0];
      if (frameCandidate === undefined)
        throw new McpToolError('MCP_LOCATOR_NOT_FOUND', 'A frame locator did not match a frame.', undefined, true);
      const described = commandResultValue(await executeSemanticCommand(
        client,
        {
          ...(frameCandidate.sessionId === undefined ? {} : { sessionId: frameCandidate.sessionId }),
          ...authority,
        },
        'shared-read',
        'DOM.describeNode',
        { backendNodeId: frameCandidate.backendNodeId, depth: 1, pierce: true },
        signal,
      ));
      const frameNode = property(described, 'node');
      const frameId = stringValue(property(frameNode, 'frameId'));
      const childSession = frameId === undefined
        ? undefined
        : childSessions.find(session => session.frameId === frameId);
      if (childSession !== undefined) {
        contexts = [{ sessionId: childSession.id }];
        continue;
      }
      const contentDocumentBackendNodeId = numberValue(
        property(property(frameNode, 'contentDocument'), 'backendNodeId'),
      );
      if (contentDocumentBackendNodeId === undefined)
        throw new McpToolError('MCP_ELEMENT_DETACHED', 'The selected frame document is not attached.', undefined, true);
      contexts = [{
        rootBackendNodeId: contentDocumentBackendNodeId,
        ...(frameCandidate.sessionId === undefined ? {} : { sessionId: frameCandidate.sessionId }),
      }];
    }
  }
  const rootStrategy: SemanticLocatorStrategy = {
    ...(locator.altText === undefined ? {} : { altText: locator.altText }),
    ...(locator.css === undefined ? {} : { css: locator.css }),
    ...(locator.label === undefined ? {} : { label: locator.label }),
    ...(locator.name === undefined ? {} : { name: locator.name }),
    ...(locator.placeholder === undefined ? {} : { placeholder: locator.placeholder }),
    ...(locator.role === undefined ? {} : { role: locator.role }),
    ...(locator.testId === undefined ? {} : { testId: locator.testId }),
    ...(locator.text === undefined ? {} : { text: locator.text }),
    ...(locator.title === undefined ? {} : { title: locator.title }),
    ...(locator.xpath === undefined ? {} : { xpath: locator.xpath }),
  };
  let candidates = await resolveStrategy(rootStrategy, contexts);
  for (const descendant of locator.descendants ?? []) {
    const descendantCandidates = await resolveStrategy(descendant, contexts);
    const retained: AccessibilityCandidate[] = [];
    for (const descendantCandidate of descendantCandidates) {
      if (await anyCandidateContains(client, target, candidates, [descendantCandidate], signal, containmentDocuments))
        retained.push(descendantCandidate);
    }
    candidates = retained;
  }
  if (locator.has !== undefined) {
    const requiredDescendants = await resolveStrategy(locator.has, contexts);
    const retained: AccessibilityCandidate[] = [];
    for (const candidate of candidates) {
      if (await anyCandidateContains(client, target, [candidate], requiredDescendants, signal, containmentDocuments))
        retained.push(candidate);
    }
    candidates = retained;
  }
  if (locator.exclude !== undefined) {
    const excluded = await resolveStrategy(locator.exclude, contexts);
    const retained: AccessibilityCandidate[] = [];
    for (const candidate of candidates) {
      const containsExcluded = await anyCandidateContains(client, target, [candidate], excluded, signal, containmentDocuments);
      const isExcluded = excluded.some(excludedCandidate => sameElement(candidate, excludedCandidate));
      if (!containsExcluded && !isExcluded) retained.push(candidate);
    }
    candidates = retained;
  }
  if (locator.hasText !== undefined) {
    const textCandidates = await resolveStrategy({ text: locator.hasText }, contexts);
    const retained: AccessibilityCandidate[] = [];
    for (const candidate of candidates) {
      if (
        matchesText(candidate.name, locator.hasText)
        || await anyCandidateContains(client, target, [candidate], textCandidates, signal, containmentDocuments)
      ) retained.push(candidate);
    }
    candidates = retained;
  }
  if (locator.hasNotText !== undefined) {
    const excludedTextCandidates = await resolveStrategy({ text: locator.hasNotText }, contexts);
    const retained: AccessibilityCandidate[] = [];
    for (const candidate of candidates) {
      if (
        !matchesText(candidate.name, locator.hasNotText)
        && !await anyCandidateContains(client, target, [candidate], excludedTextCandidates, signal, containmentDocuments)
      ) retained.push(candidate);
    }
    candidates = retained;
  }
  if (locator.visible !== undefined) {
    const retained: AccessibilityCandidate[] = [];
    for (const candidate of candidates) {
      const visible = await candidateIsVisible(client, target, candidate, signal);
      if (visible === locator.visible) retained.push(candidate);
    }
    candidates = retained;
  }
  if (locator.nth !== undefined) {
    const index = locator.nth < 0 ? candidates.length + locator.nth : locator.nth;
    const candidate = candidates[index];
    candidates = candidate === undefined ? [] : [candidate];
  }
  return candidates;
}

function sameElement(first: NativeElementReference, second: NativeElementReference): boolean {
  return first.backendNodeId === second.backendNodeId
    && first.sessionId === second.sessionId
    && first.targetId === second.targetId;
}

function documentParentGraph(document: unknown): ReadonlyMap<number, number> {
  const backendIdentifiers = new Map<number, number>();
  const frontendParents = new Map<number, number>();
  const pending: Array<{ readonly node: unknown; readonly parentNodeId?: number }> = arrayValue(property(document, 'nodes')).map(node => ({ node }));
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > 100_000) throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'Subtree discovery exceeded 100,000 DOM nodes. Narrow the scope.');
    const entry = pending.pop();
    if (entry === undefined) break;
    const nodeId = numberValue(property(entry.node, 'nodeId'));
    const backendNodeId = numberValue(property(entry.node, 'backendNodeId'));
    if (nodeId === undefined || backendNodeId === undefined) continue;
    backendIdentifiers.set(nodeId, backendNodeId);
    const parentId = entry.parentNodeId ?? numberValue(property(entry.node, 'parentId'));
    if (parentId !== undefined) frontendParents.set(nodeId, parentId);
    for (const key of ['children', 'contentDocument', 'pseudoElements', 'shadowRoots', 'templateContent']) {
      const children = property(entry.node, key);
      for (const child of Array.isArray(children) ? arrayValue(children) : children === undefined ? [] : [children]) pending.push({ node: child, parentNodeId: nodeId });
    }
  }
  const parents = new Map<number, number>();
  for (const [nodeId, parentId] of frontendParents) {
    const backendNodeId = backendIdentifiers.get(nodeId);
    const parentBackendNodeId = backendIdentifiers.get(parentId);
    if (backendNodeId !== undefined && parentBackendNodeId !== undefined) parents.set(backendNodeId, parentBackendNodeId);
  }
  return parents;
}

async function candidateContains(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  ancestor: AccessibilityCandidate,
  descendant: AccessibilityCandidate,
  signal: AbortSignal,
  containmentDocuments: ContainmentDocumentCache = new Map(),
): Promise<boolean> {
  if (ancestor.sessionId !== descendant.sessionId) return false;
  if (sameElement(ancestor, descendant)) return false;
  const contextKey = ancestor.sessionId ?? '';
  let documentParents = containmentDocuments.get(contextKey);
  if (documentParents === undefined) {
    const authority = {
      ...(ancestor.sessionId === undefined ? {} : { sessionId: ancestor.sessionId }),
      targetGeneration: target.generation,
      targetId: target.id,
    };
    documentParents = withLease(client, authority, 'shared-read', ['DOM.getDocument', 'DOM.getFlattenedDocument'], async (lease) => {
      const execute = async (method: string, parameters: JsonObject): Promise<unknown> => {
        if (signal.aborted) throw new McpToolError('MCP_WAIT_CANCELLED', 'Subtree discovery was cancelled.');
        const result = await client.executeCommand({ ...authority, leaseId: lease.id, method, operationId: randomUUID(), parameters });
        const artifact = artifactFromCommandResult(result);
        return artifact === undefined ? commandResultValue(result) : readRetainedArtifact(client, authority, { artifact, lease }, signal, false);
      };
      await execute('DOM.getDocument', { depth: 0, pierce: true });
      const document = await execute('DOM.getFlattenedDocument', { depth: -1, pierce: true });
      return documentParentGraph(document);
    });
    containmentDocuments.set(contextKey, documentParents);
  }
  const parents = await documentParents;
  const visited = new Set<number>();
  let parentId = parents.get(descendant.backendNodeId);
  while (parentId !== undefined) {
    if (parentId === ancestor.backendNodeId) return true;
    if (visited.has(parentId)) throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'The document changed during subtree discovery.');
    visited.add(parentId);
    parentId = parents.get(parentId);
  }
  return false;
}

async function anyCandidateContains(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  ancestors: readonly AccessibilityCandidate[],
  descendants: readonly AccessibilityCandidate[],
  signal: AbortSignal,
  containmentDocuments: ContainmentDocumentCache = new Map(),
): Promise<boolean> {
  for (const ancestor of ancestors) {
    for (const descendant of descendants) {
      if (await candidateContains(client, target, ancestor, descendant, signal, containmentDocuments)) return true;
    }
  }
  return false;
}

async function candidateIsVisible(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  candidate: AccessibilityCandidate,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const result = await executeSemanticCommand(
      client,
      {
        ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }),
        targetGeneration: target.generation,
        targetId: target.id,
      },
      'shared-read',
      'DOM.getContentQuads',
      { backendNodeId: candidate.backendNodeId },
      signal,
    );
    return contentQuadPoint(result, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) !== undefined;
  } catch {
    return false;
  }
}

function accessibilityProperty(node: unknown, name: string): unknown {
  const matchingProperty = arrayValue(property(node, 'properties'))
    .find(candidate => property(candidate, 'name') === name);
  return property(property(matchingProperty, 'value'), 'value');
}

const ancestorFrameMethods = ['Bridge.listChildSessions', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'DOM.getFrameOwner', 'DOM.getBoxModel', 'DOM.getNodeForLocation'] as const;

async function assertElementHit(
  backendNodeId: number,
  hitBackendNodeId: number | undefined,
  execute: (method: string, parameters: JsonObject) => Promise<unknown>,
): Promise<void> {
  if (hitBackendNodeId === backendNodeId) return;
  if (hitBackendNodeId !== undefined) {
    await execute('DOM.getDocument', { depth: 0, pierce: true });
    const parents = documentParentGraph(commandResultValue(await execute('DOM.getFlattenedDocument', { depth: -1, pierce: true })));
    const visited = new Set<number>();
    let parentId = parents.get(hitBackendNodeId);
    while (parentId !== undefined) {
      if (parentId === backendNodeId) return;
      if (visited.has(parentId)) throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'The document changed during the input hit test.');
      visited.add(parentId);
      parentId = parents.get(parentId);
    }
  }
  throw new McpToolError('MCP_ELEMENT_COVERED', 'Another element covers the requested element.', undefined, true);
}

async function assertAncestorFrameHit(
  element: NativeElementReference,
  point: ViewportPoint,
  execute: (method: string, parameters: JsonObject, sessionOverride?: string | null) => Promise<unknown>,
): Promise<void> {
  if (element.sessionId === undefined) return;
  const sessions = childSessionReferences(await execute('Bridge.listChildSessions', {}, null)).filter(session => session.type === 'iframe');
  const frameContexts = new Map<string, { parentId?: string; sessionId?: string }>();
  const rootFrames = new Map<string, string>();
  for (const sessionId of [undefined, ...sessions.map(session => session.id)]) {
    const tree = commandResultValue(await execute('Page.getFrameTree', {}, sessionId ?? null));
    const pending = [property(tree, 'frameTree')];
    const rootId = stringValue(property(property(pending[0], 'frame'), 'id'));
    if (sessionId !== undefined && rootId !== undefined) rootFrames.set(sessionId, rootId);
    while (pending.length > 0) {
      const current = pending.pop();
      const frame = property(current, 'frame');
      const frameId = stringValue(property(frame, 'id'));
      const parentId = stringValue(property(frame, 'parentId')) ?? (frameId === undefined ? undefined : frameContexts.get(frameId)?.parentId);
      if (frameId !== undefined) frameContexts.set(frameId, { ...(parentId === undefined ? {} : { parentId }), ...(sessionId === undefined ? {} : { sessionId }) });
      pending.push(...arrayValue(property(current, 'childFrames')));
    }
  }
  let frameId = rootFrames.get(element.sessionId);
  if (frameId === undefined) throw new McpToolError('MCP_ELEMENT_DETACHED', 'The containing frame is no longer attached.');
  let mappedPoint = point;
  const visited = new Set<string>();
  while (frameId !== undefined) {
    if (visited.has(frameId)) throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'Chrome returned an incomplete ancestor frame chain.');
    visited.add(frameId);
    const frame = frameContexts.get(frameId);
    if (frame?.parentId === undefined) break;
    const parent = frameContexts.get(frame.parentId);
    if (parent === undefined) throw new McpToolError('MCP_SEARCH_INCOMPLETE', 'The ancestor frame could not be resolved.');
    const owner = commandResultValue(await execute('DOM.getFrameOwner', { frameId }, parent.sessionId ?? null));
    const backendNodeId = numberValue(property(owner, 'backendNodeId'));
    if (backendNodeId === undefined) throw new McpToolError('MCP_ELEMENT_DETACHED', 'The ancestor frame element is detached.');
    const box = commandResultValue(await execute('DOM.getBoxModel', { backendNodeId }, parent.sessionId ?? null));
    const quad = arrayValue(property(property(box, 'model'), 'content')).map(value => typeof value === 'number' && Number.isFinite(value) ? value : undefined);
    const viewport = commandResultValue(await execute('Page.getLayoutMetrics', {}, frame.sessionId ?? null));
    const layout = property(viewport, 'cssLayoutViewport') ?? property(viewport, 'layoutViewport');
    const width = numberValue(property(layout, 'clientWidth'));
    const height = numberValue(property(layout, 'clientHeight'));
    if (quad.length !== 8 || quad.includes(undefined) || !width || !height)
      throw new McpToolError('MCP_ELEMENT_HIDDEN', 'The containing frame has no visible geometry.', undefined, true);
    const [left = 0, top = 0, right = 0, rightTop = 0, , , bottomLeft = 0, bottom = 0] = quad;
    mappedPoint = { x: left + mappedPoint.x / width * (right - left) + mappedPoint.y / height * (bottomLeft - left), y: top + mappedPoint.x / width * (rightTop - top) + mappedPoint.y / height * (bottom - top) };
    const parentViewport = commandResultValue(await execute('Page.getLayoutMetrics', {}, parent.sessionId ?? null));
    const parentLayout = property(parentViewport, 'cssLayoutViewport') ?? property(parentViewport, 'layoutViewport');
    const hit = commandResultValue(await execute('DOM.getNodeForLocation', { x: Math.round(mappedPoint.x + (numberValue(property(parentLayout, 'pageX')) ?? 0)), y: Math.round(mappedPoint.y + (numberValue(property(parentLayout, 'pageY')) ?? 0)), includeUserAgentShadowDOM: false }, parent.sessionId ?? null));
    if (property(hit, 'backendNodeId') !== backendNodeId && property(hit, 'frameId') !== frameId)
      throw new McpToolError('MCP_ELEMENT_COVERED', 'An ancestor frame is covered by another element.', undefined, true);
    frameId = frame.parentId;
  }
}

async function executeElementClick(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  element: NativeElementReference,
  input: {
    readonly button: keyof typeof pointerButtonValues;
    readonly clickCount: number;
    readonly modifiers: readonly InputModifier[];
    readonly timeoutMilliseconds: number;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const actionInput = {
    ...(element.sessionId === undefined ? {} : { sessionId: element.sessionId }),
    targetGeneration: target.generation,
    targetId: target.id,
  };
  return executeInputAction(
    client,
    actionInput,
    [
      'Accessibility.getPartialAXTree',
      'DOM.describeNode',
      'DOM.getDocument',
      'DOM.getFlattenedDocument',
      'DOM.getContentQuads',
      'DOM.getNodeForLocation',
      'DOM.scrollIntoViewIfNeeded',
      'Input.dispatchMouseEvent',
      ...ancestorFrameMethods,
    ],
    signal,
    async (execute, executeCleanup) => {
      const deadline = Date.now() + input.timeoutMilliseconds;
      let point: ViewportPoint | undefined;
      while (point === undefined) {
        let retryableError: McpToolError | undefined;
        try {
          await execute('DOM.describeNode', {
            backendNodeId: element.backendNodeId,
            depth: 0,
            pierce: true,
          });
          const accessibility = commandResultValue(await execute('Accessibility.getPartialAXTree', {
            backendNodeId: element.backendNodeId,
            fetchRelatives: false,
          }));
          const accessibilityNode = arrayValue(property(accessibility, 'nodes'))[0];
          if (accessibilityProperty(accessibilityNode, 'disabled') === true)
            throw new McpToolError('MCP_ELEMENT_DISABLED', 'The element is disabled.', undefined, true);
          await execute('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId });
          const viewport = commandResultValue(await execute('Page.getLayoutMetrics', {}));
          const layout = property(viewport, 'cssLayoutViewport') ?? property(viewport, 'layoutViewport');
          const viewportWidth = numberValue(property(layout, 'clientWidth')) ?? Number.MAX_SAFE_INTEGER;
          const viewportHeight = numberValue(property(layout, 'clientHeight')) ?? Number.MAX_SAFE_INTEGER;
          const firstGeometry = await execute('DOM.getContentQuads', { backendNodeId: element.backendNodeId });
          await waitForInputStep(50, signal);
          const secondGeometry = await execute('DOM.getContentQuads', { backendNodeId: element.backendNodeId });
          const firstPoint = contentQuadPoint(firstGeometry, viewportWidth, viewportHeight);
          const candidatePoint = contentQuadPoint(secondGeometry, viewportWidth, viewportHeight);
          if (firstPoint === undefined || candidatePoint === undefined)
            throw new McpToolError('MCP_ELEMENT_HIDDEN', 'The element has no visible geometry.', undefined, true);
          if (firstPoint.x !== candidatePoint.x || firstPoint.y !== candidatePoint.y)
            throw new McpToolError('MCP_ELEMENT_UNSTABLE', 'The element geometry is still moving.', undefined, true);
          const hitResult = commandResultValue(await execute('DOM.getNodeForLocation', {
            includeUserAgentShadowDOM: false,
            x: candidatePoint.x + (numberValue(property(layout, 'pageX')) ?? 0),
            y: candidatePoint.y + (numberValue(property(layout, 'pageY')) ?? 0),
          }));
          const hitBackendNodeId = numberValue(property(hitResult, 'backendNodeId'));
          await assertElementHit(element.backendNodeId, hitBackendNodeId, execute);
          await assertAncestorFrameHit(element, candidatePoint, execute);
          point = candidatePoint;
        } catch (error) {
          if (error instanceof McpToolError && error.retryable)
            retryableError = error;
          else if (property(error, 'code') === 'CDP_COMMAND_FAILED' && detachedNodeMessagePattern.test(error instanceof Error ? error.message : String(property(error, 'message'))))
            throw new McpToolError('MCP_ELEMENT_DETACHED', 'The element is detached from the current document.');
          else if (error instanceof McpToolError || property(error, 'code') !== undefined)
            throw error;
          else
            throw new McpToolError('MCP_ELEMENT_DETACHED', 'The element is detached from the current document.');
        }
        if (point === undefined) {
          if (Date.now() >= deadline && retryableError !== undefined) throw retryableError;
          await waitForInputStep(Math.min(100, Math.max(0, deadline - Date.now())), signal);
        }
      }
      const modifiers = encodeInputModifiers(input.modifiers);
      const results: unknown[] = [];
      let inputDispatched = false;
      let buttonPressed = false;
      try {
        inputDispatched = true;
        results.push(await execute('Input.dispatchMouseEvent', {
          modifiers,
          type: 'mouseMoved',
          ...point,
        }));
        for (let clickCount = 1; clickCount <= input.clickCount; clickCount += 1) {
          results.push(await execute('Input.dispatchMouseEvent', {
            button: input.button,
            clickCount,
            modifiers,
            type: 'mousePressed',
            ...point,
          }));
          buttonPressed = true;
          results.push(await execute('Input.dispatchMouseEvent', {
            button: input.button,
            clickCount,
            modifiers,
            type: 'mouseReleased',
            ...point,
          }));
          buttonPressed = false;
        }
      } catch (error) {
        if (error instanceof McpToolError && error.code === 'MCP_ACTION_VERIFICATION_FAILED') throw error;
        if (inputDispatched)
          throw new McpToolError('MCP_ACTION_OUTCOME_UNKNOWN', 'Input may have been dispatched before the action failed. The action was not replayed.', {
            cause: {
              code: stringValue(property(error, 'code')) ?? 'MCP_TOOL_FAILED',
              message: error instanceof Error ? error.message : 'The browser command failed.',
            },
          });
        throw error;
      } finally {
        if (buttonPressed) {
          await executeCleanup('Input.dispatchMouseEvent', {
            button: input.button,
            clickCount: input.clickCount,
            modifiers,
            type: 'mouseReleased',
            ...point,
          });
        }
      }
      return { clicked: true };
    },
  );
}

async function resolveSemanticElement(
  client: McpChromeDebuggerBridgeClient,
  state: CdbToolSessionState,
  target: PublishedTarget,
  input: { readonly locator?: SemanticLocator | undefined; readonly ref?: string | undefined },
  signal: AbortSignal,
): Promise<NativeElementReference> {
  if (input.ref !== undefined) {
    const referencedElement = state.elementReferences.get(input.ref);
    if (
      referencedElement === undefined
      || referencedElement.targetId !== target.id
      || referencedElement.generation !== target.generation
      || !('backendNodeId' in referencedElement)
    )
      throw new McpToolError('MCP_ELEMENT_REF_STALE', `Element reference ${input.ref} is stale.`);
    return referencedElement;
  }
  const matches = await resolveLocatorCandidates(client, target, input.locator ?? {}, signal);
  if (matches.length === 0)
    throw new McpToolError('MCP_LOCATOR_NOT_FOUND', 'The locator did not match an element.', undefined, true);
  if (matches.length > 1)
    throw new McpToolError('MCP_LOCATOR_AMBIGUOUS', `The locator matched ${matches.length} elements.`);
  const match = matches[0];
  if (match === undefined)
    throw new McpToolError('MCP_LOCATOR_NOT_FOUND', 'The locator did not match an element.', undefined, true);
  return match;
}

async function resolveSemanticElementWithRetry(
  client: McpChromeDebuggerBridgeClient,
  state: CdbToolSessionState,
  target: PublishedTarget,
  input: {
    readonly locator?: SemanticLocator | undefined;
    readonly ref?: string | undefined;
    readonly timeoutMilliseconds: number;
  },
  signal: AbortSignal,
): Promise<NativeElementReference> {
  const deadline = Date.now() + input.timeoutMilliseconds;
  while (true) {
    try {
      return await resolveSemanticElement(client, state, target, input, signal);
    } catch (error) {
      if (
        input.locator === undefined
        || property(error, 'code') !== 'MCP_LOCATOR_NOT_FOUND'
        || Date.now() >= deadline
      ) throw error;
      await waitForInputStep(Math.min(100, Math.max(0, deadline - Date.now())), signal);
    }
  }
}

async function executeWithRenewedLocatorRetry<Value>(
  client: McpChromeDebuggerBridgeClient,
  state: CdbToolSessionState,
  input: { readonly locator?: SemanticLocator | undefined; readonly ref?: string | undefined; readonly targetRef: string; readonly timeoutMilliseconds?: number },
  action: (target: PublishedTarget) => Promise<Value>,
): Promise<Value> {
  const deadline = Date.now() + (input.timeoutMilliseconds ?? 10_000);
  while (true) {
    try {
      return await action(await resolveSemanticTarget(client, state, input.targetRef));
    } catch (error) {
      const code = property(error, 'code');
      if (input.ref !== undefined && code === 'MCP_ELEMENT_DETACHED') {
        state.elementReferences.delete(input.ref);
        throw new McpToolError('MCP_ELEMENT_REF_STALE', `Element reference ${input.ref} is stale. Capture a new snapshot.`);
      }
      if (input.locator === undefined || !['TARGET_GENERATION_STALE', 'MCP_ELEMENT_DETACHED'].includes(String(code)) || Date.now() >= deadline) throw error;
    }
  }
}

function keyboardParameters(key: string): JsonObject {
  const namedKeys: Readonly<Record<string, number>> = { 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39, 'ArrowUp': 38, 'Backspace': 8, 'Delete': 46, 'End': 35, 'Enter': 13, 'Escape': 27, 'Home': 36, 'PageDown': 34, 'PageUp': 33, ' ': 32, 'Space': 32, 'Tab': 9 };
  const normalizedKey = key === 'Space' ? ' ' : key;
  const virtualKeyCode = namedKeys[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
  return { key: normalizedKey, ...(virtualKeyCode === undefined ? {} : { windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }), ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : key.length === 1 ? { text: key, unmodifiedText: key } : {}) };
}

type ElementInteraction
  = | { readonly kind: 'fill' | 'type'; readonly text: string }
    | { readonly key: string; readonly kind: 'press' }
    | { readonly kind: 'focus' | 'hover' | 'scroll-into-view' };

async function executeElementInteraction(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  element: NativeElementReference,
  interaction: ElementInteraction,
  modifiers: readonly InputModifier[],
  timeoutMilliseconds: number,
  signal: AbortSignal,
): Promise<unknown> {
  const needsPointer = interaction.kind === 'hover';
  const needsFocus = interaction.kind === 'fill'
    || interaction.kind === 'focus'
    || interaction.kind === 'press'
    || interaction.kind === 'type';
  const methods = [
    ...ancestorFrameMethods,
    'Accessibility.getPartialAXTree',
    'DOM.describeNode',
    'DOM.getDocument',
    'DOM.getFlattenedDocument',
    'DOM.getContentQuads',
    'DOM.scrollIntoViewIfNeeded',
    ...(needsPointer ? ['DOM.getNodeForLocation', 'Input.dispatchMouseEvent'] : []),
    ...(needsFocus ? ['DOM.focus'] : []),
    ...(interaction.kind === 'fill' || interaction.kind === 'press' ? ['Input.dispatchKeyEvent'] : []),
    ...(interaction.kind === 'fill' || interaction.kind === 'type' ? ['Input.insertText'] : []),
  ];
  return executeInputAction(
    client,
    {
      ...(element.sessionId === undefined ? {} : { sessionId: element.sessionId }),
      targetGeneration: target.generation,
      targetId: target.id,
    },
    methods,
    signal,
    async (execute, executeCleanup) => {
      const deadline = Date.now() + timeoutMilliseconds;
      let point: ViewportPoint | undefined;
      while (point === undefined) {
        let retryableError: McpToolError | undefined;
        try {
          await execute('DOM.describeNode', {
            backendNodeId: element.backendNodeId,
            depth: 0,
            pierce: true,
          });
          const accessibility = commandResultValue(await execute('Accessibility.getPartialAXTree', {
            backendNodeId: element.backendNodeId,
            fetchRelatives: false,
          }));
          const accessibilityNode = arrayValue(property(accessibility, 'nodes'))[0];
          if (
            !['focus', 'hover', 'scroll-into-view'].includes(interaction.kind)
            && accessibilityProperty(accessibilityNode, 'disabled') === true
          ) throw new McpToolError('MCP_ELEMENT_DISABLED', 'The element is disabled.', undefined, true);
          if (
            (interaction.kind === 'fill' || interaction.kind === 'type')
            && (accessibilityProperty(accessibilityNode, 'readonly') === true
              || (!['plaintext', 'richtext', true].includes(accessibilityProperty(accessibilityNode, 'editable') as string | boolean)
                && !['searchbox', 'textbox'].includes(accessibilityValue(property(accessibilityNode, 'role')) ?? '')))
          ) throw new McpToolError('MCP_ELEMENT_NOT_EDITABLE', 'The element does not accept text.', undefined, true);
          await execute('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId });
          const viewport = commandResultValue(await execute('Page.getLayoutMetrics', {}));
          const layout = property(viewport, 'cssLayoutViewport') ?? property(viewport, 'layoutViewport');
          const viewportWidth = numberValue(property(layout, 'clientWidth')) ?? Number.MAX_SAFE_INTEGER;
          const viewportHeight = numberValue(property(layout, 'clientHeight')) ?? Number.MAX_SAFE_INTEGER;
          const firstGeometry = await execute('DOM.getContentQuads', { backendNodeId: element.backendNodeId });
          await waitForInputStep(50, signal);
          const secondGeometry = await execute('DOM.getContentQuads', { backendNodeId: element.backendNodeId });
          const firstPoint = contentQuadPoint(firstGeometry, viewportWidth, viewportHeight);
          const candidatePoint = contentQuadPoint(secondGeometry, viewportWidth, viewportHeight);
          if (firstPoint === undefined || candidatePoint === undefined)
            throw new McpToolError('MCP_ELEMENT_HIDDEN', 'The element has no visible geometry.', undefined, true);
          if (firstPoint.x !== candidatePoint.x || firstPoint.y !== candidatePoint.y)
            throw new McpToolError('MCP_ELEMENT_UNSTABLE', 'The element geometry is still moving.', undefined, true);
          if (needsPointer || needsFocus) {
            const hitResult = commandResultValue(await execute('DOM.getNodeForLocation', {
              includeUserAgentShadowDOM: false,
              x: candidatePoint.x + (numberValue(property(layout, 'pageX')) ?? 0),
              y: candidatePoint.y + (numberValue(property(layout, 'pageY')) ?? 0),
            }));
            const hitBackendNodeId = numberValue(property(hitResult, 'backendNodeId'));
            await assertElementHit(element.backendNodeId, hitBackendNodeId, execute);
          }
          await assertAncestorFrameHit(element, candidatePoint, execute);
          point = candidatePoint;
        } catch (error) {
          if (error instanceof McpToolError && error.retryable) retryableError = error;
          else if (property(error, 'code') === 'CDP_COMMAND_FAILED' && detachedNodeMessagePattern.test(error instanceof Error ? error.message : String(property(error, 'message'))))
            throw new McpToolError('MCP_ELEMENT_DETACHED', 'The element is detached from the current document.');
          else if (error instanceof McpToolError || property(error, 'code') !== undefined) throw error;
          else throw new McpToolError('MCP_ELEMENT_DETACHED', 'The element is detached from the current document.');
        }
        if (point === undefined) {
          if (Date.now() >= deadline && retryableError !== undefined) throw retryableError;
          await waitForInputStep(Math.min(100, Math.max(0, deadline - Date.now())), signal);
        }
      }
      if (interaction.kind === 'scroll-into-view') return { scrolled: true };
      if (needsPointer) {
        try {
          return await execute('Input.dispatchMouseEvent', {
            modifiers: encodeInputModifiers(modifiers),
            type: 'mouseMoved',
            ...point,
          });
        } catch {
          throw new McpToolError('MCP_ACTION_OUTCOME_UNKNOWN', 'Pointer input may have been dispatched before the action failed. The action was not replayed.');
        }
      }
      try {
        await execute('DOM.focus', { backendNodeId: element.backendNodeId });
      } catch {
        throw new McpToolError('MCP_ACTION_OUTCOME_UNKNOWN', 'Focus may have been dispatched before the action failed. It was not replayed.');
      }
      if (interaction.kind === 'focus') return { focused: true };
      let inputDispatched = false;
      try {
        if (interaction.kind === 'type') {
          inputDispatched = true;
          return await execute('Input.insertText', { text: interaction.text });
        }
        if (interaction.kind === 'fill') {
          let keyPressed = false;
          try {
            inputDispatched = true;
            await execute('Input.dispatchKeyEvent', {
              commands: ['SelectAll'],
              key: 'a',
              type: 'rawKeyDown',
            });
            keyPressed = true;
            await execute('Input.dispatchKeyEvent', { key: 'a', type: 'keyUp' });
            keyPressed = false;
            await execute('Input.dispatchKeyEvent', { key: 'Backspace', type: 'keyDown' });
            keyPressed = true;
            await execute('Input.dispatchKeyEvent', { key: 'Backspace', type: 'keyUp' });
            keyPressed = false;
            await execute('Input.insertText', { text: interaction.text });
            const verification = commandResultValue(await execute('Accessibility.getPartialAXTree', { backendNodeId: element.backendNodeId, fetchRelatives: false }));
            const verifiedNode = arrayValue(property(verification, 'nodes'))[0];
            const value = accessibilityValue(property(verifiedNode, 'value')) ?? '';
            if (verifiedNode === undefined || value !== interaction.text)
              throw new McpToolError('MCP_ACTION_VERIFICATION_FAILED', 'The filled value did not match the requested value. Inspect the control before taking another action.');
            return { filled: true };
          } finally {
            if (keyPressed)
              await executeCleanup('Input.dispatchKeyEvent', { key: 'Unidentified', type: 'keyUp' });
          }
        }
        if (interaction.kind !== 'press')
          throw new McpToolError('MCP_TOOL_FAILED', 'The element interaction is unsupported.');
        let keyPressed = false;
        try {
          const encodedModifiers = encodeInputModifiers(modifiers);
          inputDispatched = true;
          await execute('Input.dispatchKeyEvent', {
            ...keyboardParameters(interaction.key),
            modifiers: encodedModifiers,
            type: 'keyDown',
          });
          keyPressed = true;
          const result = await execute('Input.dispatchKeyEvent', {
            key: interaction.key,
            modifiers: encodedModifiers,
            type: 'keyUp',
          });
          keyPressed = false;
          return result;
        } finally {
          if (keyPressed)
            await executeCleanup('Input.dispatchKeyEvent', { key: interaction.key, type: 'keyUp' });
        }
      } catch (error) {
        if (error instanceof McpToolError && error.code === 'MCP_ACTION_VERIFICATION_FAILED') throw error;
        if (inputDispatched)
          throw new McpToolError('MCP_ACTION_OUTCOME_UNKNOWN', 'Input may have been dispatched before the action failed. The action was not replayed.', {
            cause: {
              code: stringValue(property(error, 'code')) ?? 'MCP_TOOL_FAILED',
              message: error instanceof Error ? error.message : 'The browser command failed.',
            },
          });
        throw error;
      }
    },
  );
}

async function elementCheckedState(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  element: NativeElementReference,
  signal: AbortSignal,
): Promise<boolean | 'mixed' | undefined> {
  const result = await executeSemanticCommand(
    client,
    {
      ...(element.sessionId === undefined ? {} : { sessionId: element.sessionId }),
      targetGeneration: target.generation,
      targetId: target.id,
    },
    'shared-read',
    'Accessibility.getPartialAXTree',
    { backendNodeId: element.backendNodeId, fetchRelatives: false },
    signal,
  );
  const node = arrayValue(property(commandResultValue(result), 'nodes'))[0];
  const checked = accessibilityProperty(node, 'checked');
  return checked === 'mixed' ? 'mixed' : checked === true || checked === 'true' ? true : checked === false || checked === 'false' ? false : undefined;
}

async function elementCenterPoint(
  client: McpChromeDebuggerBridgeClient,
  target: PublishedTarget,
  element: NativeElementReference,
  signal: AbortSignal,
): Promise<ViewportPoint> {
  const authority = {
    ...(element.sessionId === undefined ? {} : { sessionId: element.sessionId }),
    targetGeneration: target.generation,
    targetId: target.id,
  };
  await executeSemanticCommand(
    client,
    authority,
    'exclusive-control',
    'DOM.scrollIntoViewIfNeeded',
    { backendNodeId: element.backendNodeId },
    signal,
  );
  const geometry = await executeSemanticCommand(
    client,
    authority,
    'shared-read',
    'DOM.getContentQuads',
    { backendNodeId: element.backendNodeId },
    signal,
  );
  const point = contentQuadPoint(geometry, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (point === undefined)
    throw new McpToolError('MCP_ELEMENT_HIDDEN', 'The element has no visible geometry.', undefined, true);
  return point;
}

interface AccessibilitySnapshotBudget {
  remainingCharacters: number;
  remainingNodes: number;
  truncated: boolean;
}

const snapshotTruncationNotice = '… snapshot truncated. Use a scoped snapshot, browser.find, or a larger explicit budget to expand.';

function boundSnapshotText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  const limit = maximumCharacters - snapshotTruncationNotice.length - 1;
  const lastLine = value.lastIndexOf('\n', limit);
  return `${lastLine < 0 ? '' : value.slice(0, lastLine)}\n${snapshotTruncationNotice}`;
}

function formatAccessibilityTree(
  value: unknown,
  options: {
    readonly budget: AccessibilitySnapshotBudget;
    readonly generation: number;
    readonly maximumDepth: number;
    readonly mode: 'accessibility' | 'interactive';
    readonly sessionId?: string;
    readonly state: CdbToolSessionState;
    readonly targetId: string;
  },
): string {
  const nodes = arrayValue(property(value, 'nodes'));
  const nodesById = new Map<string, unknown>();
  const childNodeIds = new Set<string>();
  for (const node of nodes) {
    const nodeId = stringValue(property(node, 'nodeId'));
    if (nodeId !== undefined) nodesById.set(nodeId, node);
    for (const childId of arrayValue(property(node, 'childIds'))) {
      const childNodeId = stringValue(childId);
      if (childNodeId !== undefined) childNodeIds.add(childNodeId);
    }
  }
  const roots = [...nodesById.entries()]
    .filter(([nodeId]) => !childNodeIds.has(nodeId))
    .map(([, node]) => node);
  const pending = roots.reverse().map(node => ({ depth: 0, node }));
  const visited = new Set<unknown>();
  const lines: string[] = [];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const ignored = property(node, 'ignored') === true;
    const role = accessibilityValue(property(node, 'role')) ?? 'generic';
    const name = accessibilityValue(property(node, 'name'));
    const backendNodeId = numberValue(property(node, 'backendDOMNodeId'));
    const actionable = interactiveAccessibilityRoles.has(role) && backendNodeId !== undefined;
    const contextual = ['heading', 'alert', 'status', 'dialog', 'navigation', 'region'].includes(role)
      && name !== undefined && name.length > 0;
    const rendered = !ignored && (options.mode === 'accessibility' || actionable || contextual);
    if (rendered) {
      if (options.budget.remainingNodes === 0 || (options.mode === 'accessibility' && depth > options.maximumDepth)) {
        options.budget.truncated = true;
        if (options.budget.remainingNodes === 0) break;
        continue;
      }
      const reference = actionable ? `e${options.state.nextElementReference}` : undefined;
      const accessibleName = name === undefined || name.length === 0 ? '' : ` ${JSON.stringify(name)}`;
      const state: string[] = [];
      const controlValue = accessibilityValue(property(node, 'value'));
      if (controlValue !== undefined && controlValue.length > 0) state.push(`value=${JSON.stringify(controlValue)}`);
      for (const propertyName of ['checked', 'expanded', 'selected', 'pressed']) {
        const propertyValue = accessibilityProperty(node, propertyName);
        if (propertyValue !== undefined) state.push(`[${propertyName}=${String(propertyValue)}]`);
      }
      for (const propertyName of ['disabled', 'readonly', 'required', 'focused']) {
        if (accessibilityProperty(node, propertyName) === true) state.push(`[${propertyName}]`);
      }
      const line = `${'  '.repeat(Math.min(depth, options.maximumDepth))}- ${role}${accessibleName}${state.length === 0 ? '' : ` ${state.join(' ')}`}${reference === undefined ? '' : ` [ref=${reference}]`}`;
      if (line.length + 1 > options.budget.remainingCharacters) {
        options.budget.truncated = true;
        break;
      }
      if (reference !== undefined && backendNodeId !== undefined) {
        options.state.nextElementReference += 1;
        options.state.elementReferences.set(reference, {
          backendNodeId,
          generation: options.generation,
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          targetId: options.targetId,
        });
      }
      lines.push(line);
      options.budget.remainingNodes -= 1;
      options.budget.remainingCharacters -= line.length + 1;
    }
    for (const childId of [...arrayValue(property(node, 'childIds'))].reverse()) {
      const child = nodesById.get(stringValue(childId) ?? '');
      if (child !== undefined) pending.push({ depth: depth + (rendered ? 1 : 0), node: child });
    }
  }
  if (visited.size < nodesById.size) options.budget.truncated = true;
  return lines.length === 0 ? '(no matching accessibility nodes)' : lines.join('\n');
}

/** Builds the canonical CDB tool catalogue for one principal-owned tool session. */
function createCdbToolDefinitionsForSession(
  options: RegisterCdbToolsOptions,
  sessionState: CdbToolSessionState,
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
    const inputSchema = z.toJSONSchema(config.inputSchema, { io: 'input', reused: 'ref' });
    /** Keep SDK discovery compact while retaining Zod's complete runtime validation. */
    Object.defineProperty(config.inputSchema, '~standard', { value: { ...config.inputSchema['~standard'], jsonSchema: { input: () => inputSchema, output: () => inputSchema } } });
    definitions.push({
      description: config.description,
      inputSchema,
      async invoke(input, context = { signal: new AbortController().signal }) {
        if (sessionState.disposed)
          return toolError(new McpToolError('MCP_TOOL_SESSION_DISPOSED', 'The browser tool session has been disposed.'));
        const parsedInput = await config.inputSchema.parseAsync(input);
        return handler(parsedInput, { mcpReq: { signal: context.signal } });
      },
      mcpInputSchema: config.inputSchema,
      name,
    });
  };
  const timing = resolveMcpTimingPolicy(options.timing);
  const rawClient = options.client;
  const batchLease = new AsyncLocalStorage<Lease>();
  const cancelAutomation = rawClient.cancelAutomation;
  const executeAutomation = rawClient.executeAutomation;
  const client: McpChromeDebuggerBridgeClient = {
    async acquireLease(request) {
      const activeLease = batchLease.getStore();
      if (activeLease !== undefined) {
        if (request.targetId !== activeLease.targetId || request.targetGeneration !== activeLease.targetGeneration)
          throw new McpToolError('MCP_BATCH_AUTHORITY_REPLACED', 'Target authority changed during the batch.');
        if (request.requestedMethods.some(method => !activeLease.methods.includes(method)))
          throw new McpToolError('MCP_BATCH_METHOD_UNAVAILABLE', 'The batch action requested an unavailable command.');
        return activeLease;
      }
      return rawClient.acquireLease({ ...request, durationMilliseconds: timing.semanticLeaseDurationMilliseconds });
    },
    ...(cancelAutomation === undefined ? {} : { cancelAutomation: async request => cancelAutomation(request) }),
    cancelCommand: async request => rawClient.cancelCommand(request),
    ...(executeAutomation === undefined ? {} : { executeAutomation: async request => executeAutomation(request) }),
    executeCommand: async command => rawClient.executeCommand(command),
    listTargets: async () => rawClient.listTargets(),
    readArtifact: async (request, signal) => rawClient.readArtifact(request, signal),
    releaseArtifact: async request => rawClient.releaseArtifact(request),
    releaseLease: async (request) => {
      if (batchLease.getStore()?.id !== request.leaseId) await rawClient.releaseLease(request);
    },
    renewLease: async request => rawClient.renewLease(request),
    subscribe: async request => rawClient.subscribe(request),
    watchTargets: () => rawClient.watchTargets(),
  };
  const useRegisteredAutomation = options.automationProvider === 'registered';
  const enableRawCdp = options.enableRawCdp ?? false;
  const pointerPositions = new Map<string, ViewportPoint>();
  const inputModifiersSchema = z
    .array(z.enum(['alt', 'control', 'meta', 'shift']))
    .max(4)
    .default([]);
  const pointerButtonSchema = z
    .enum(['back', 'forward', 'left', 'middle', 'right'])
    .default('left');
  const textMatchSchema = z.discriminatedUnion('match', [
    z.strictObject({
      match: z.literal('exact'),
      value: z.string().max(2_000),
    }),
    z.strictObject({
      match: z.literal('substring'),
      value: z.string().max(2_000),
    }),
    z.strictObject({
      flags: z.enum(['i', 'iu', 'u']).optional(),
      match: z.literal('regex'),
      pattern: z.string().min(1).max(256),
    }),
  ]);
  const locatorStrategyShape = {
    altText: textMatchSchema.optional(),
    css: z.string().min(1).max(2_000).optional(),
    label: textMatchSchema.optional(),
    name: textMatchSchema.optional(),
    placeholder: textMatchSchema.optional(),
    role: z.string().min(1).max(64).optional(),
    testId: textMatchSchema.optional(),
    text: textMatchSchema.optional(),
    title: textMatchSchema.optional(),
    xpath: z.string().min(1).max(2_000).optional().describe(
      'XPath expression evaluated by Chrome DOM search. XPath does not cross shadow-root boundaries.',
    ),
  };
  const locatorStrategySchema = z.strictObject(locatorStrategyShape).refine(
    locator => Object.values(locator).some(value => value !== undefined),
    { message: 'A locator strategy must contain at least one selector.' },
  );
  const locatorSchema = z.strictObject({
    ...locatorStrategyShape,
    descendants: z.array(locatorStrategySchema).max(16).optional(),
    exclude: locatorStrategySchema.optional(),
    frameChain: z.array(locatorStrategySchema).max(8).optional(),
    has: locatorStrategySchema.optional(),
    hasNotText: textMatchSchema.optional(),
    hasText: textMatchSchema.optional(),
    nth: z.number().int().min(-1_000).max(1_000).optional(),
    visible: z.boolean().optional(),
  }).refine(
    locator => Object.entries(locator).some(([key, value]) =>
      !['descendants', 'exclude', 'frameChain', 'has', 'hasNotText', 'hasText', 'nth', 'visible'].includes(key)
      && value !== undefined),
    { message: 'A locator must contain a root selector.' },
  );
  const elementTargetShape = {
    locator: locatorSchema.optional(),
    ref: z.string().regex(elementReferencePattern).optional(),
    targetRef: z.string().regex(targetReferencePattern),
    timeoutMilliseconds: z.number().int().positive().max(timing.maximumToolTimeoutMilliseconds).default(timing.defaultToolTimeoutMilliseconds),
  };
  const hasExactlyOneElementTarget = (input: { readonly locator?: unknown; readonly ref?: unknown }): boolean =>
    (input.ref === undefined) !== (input.locator === undefined);
  const inputActionTiming = {
    durationMilliseconds: z
      .number()
      .int()
      .nonnegative()
      .max(timing.maximumInputActionDurationMilliseconds)
      .default(0),
    steps: z
      .number()
      .int()
      .positive()
      .max(maximumInputActionSteps)
      .default(1),
  };
  const lifecycleInput = {
    targetRef: z.string().regex(targetReferencePattern),
    timeoutMilliseconds: z.number().int().positive().max(timing.maximumToolTimeoutMilliseconds).default(timing.defaultToolTimeoutMilliseconds),
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
        'List currently granted browser targets using stable session-local references. Target references survive navigation and authority renewal.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const targets = await client.listTargets();
        return jsonContent(targets.flatMap((target) => {
          const projected = projectSemanticTarget(sessionState, target);
          return projected === undefined ? [] : [projected];
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  if (enableRawCdp)
    register(
      'browser.list_target_authorities',
      {
        description: 'List trusted diagnostic target IDs, generations, and scopes for raw CDB operations.',
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
  register(
    'browser.find',
    {
      description: 'Find fresh element refs using a strict semantic locator. Refs are disposable and must be refreshed after page changes.',
      inputSchema: z.object({
        locator: locatorSchema,
        maximumMatches: z.number().int().positive().max(100).default(20),
        targetRef: z.string().regex(targetReferencePattern),
      }),
    },
    async (input, context) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        for (const [reference, element] of sessionState.elementReferences) {
          if (element.targetId === target.id)
            sessionState.elementReferences.delete(reference);
        }
        if (useRegisteredAutomation) {
          const result = await executeRegisteredAutomation(
            client,
            target,
            {
              kind: 'find',
              locator: automationLocator(input.locator),
              maximumMatches: input.maximumMatches,
            },
            context.mcpReq.signal,
          );
          return jsonContent(allocateProviderElements(sessionState, target, result.elements).map(({ element, ref }) => ({
            ...(stringValue(property(element.metadata, 'name')) === undefined
              ? {}
              : { name: stringValue(property(element.metadata, 'name')) }),
            ref,
            ...(stringValue(property(element.metadata, 'role')) === undefined
              ? {}
              : { role: stringValue(property(element.metadata, 'role')) }),
          })));
        }
        const candidates = await resolveLocatorCandidates(client, target, input.locator, context.mcpReq.signal);
        const matches = candidates
          .slice(0, input.maximumMatches)
          .map(candidate => ({
            ...(candidate.name === undefined ? {} : { name: candidate.name }),
            ref: allocateElementReference(sessionState, candidate),
            role: candidate.role,
          }));
        return jsonContent(candidates.length > input.maximumMatches ? { matches, totalMatches: candidates.length, truncated: true } : matches);
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
          await rawClient.acquireLease({
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
        return jsonContent(await rawClient.renewLease(input));
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
        await rawClient.releaseLease(input);
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
        await rawClient.releaseArtifact(input);
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
        'Read structured page or element attributes, accessibility state, and geometry without executing JavaScript.',
      inputSchema: z.object({
        include: z.array(z.enum(['accessibility', 'attributes', 'geometry'])).max(3).default([
          'accessibility',
          'attributes',
          'geometry',
        ]),
        locator: locatorSchema.optional(),
        ref: z.string().regex(elementReferencePattern).optional(),
        targetRef: z.string().regex(targetReferencePattern),
      }).refine(input => input.ref === undefined || input.locator === undefined, {
        message: 'Provide at most one of ref or locator.',
      }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        if (useRegisteredAutomation) {
          const result = await executeRegisteredAutomation(
            client,
            target,
            {
              ...automationElementTarget(sessionState, target, input),
              include: input.include,
              kind: 'inspect',
            },
            ctx.mcpReq.signal,
          );
          return jsonContent(result.value);
        }
        if (input.ref === undefined && input.locator === undefined) {
          const layout = await executeSemanticCommand(
            client,
            { targetGeneration: target.generation, targetId: target.id },
            'shared-read',
            'Page.getLayoutMetrics',
            {},
            ctx.mcpReq.signal,
          );
          return jsonContent({
            layout: commandResultValue(layout),
            target: projectSemanticTarget(sessionState, target),
          });
        }
        const element = await resolveSemanticElement(client, sessionState, target, input, ctx.mcpReq.signal);
        const authority = {
          ...(element.sessionId === undefined ? {} : { sessionId: element.sessionId }),
          targetGeneration: target.generation,
          targetId: target.id,
        };
        const output: Record<string, unknown> = {};
        if (input.include.includes('attributes')) {
          const described = commandResultValue(await executeSemanticCommand(
            client,
            authority,
            'shared-read',
            'DOM.describeNode',
            { backendNodeId: element.backendNodeId, depth: 0, pierce: true },
            ctx.mcpReq.signal,
          ));
          const node = property(described, 'node');
          output.attributes = domNodeAttributes(node);
          output.nodeName = stringValue(property(node, 'nodeName'));
        }
        if (input.include.includes('accessibility')) {
          const accessibility = commandResultValue(await executeSemanticCommand(
            client,
            authority,
            'shared-read',
            'Accessibility.getPartialAXTree',
            { backendNodeId: element.backendNodeId, fetchRelatives: false },
            ctx.mcpReq.signal,
          ));
          const node = arrayValue(property(accessibility, 'nodes'))[0];
          output.accessibility = {
            name: accessibilityValue(property(node, 'name')),
            properties: arrayValue(property(node, 'properties')).flatMap((candidate) => {
              const name = stringValue(property(candidate, 'name'));
              const value = accessibilityValue(property(candidate, 'value'));
              return name === undefined || value === undefined ? [] : [{ name, value }];
            }),
            role: accessibilityValue(property(node, 'role')),
          };
        }
        if (input.include.includes('geometry')) {
          const geometry = commandResultValue(await executeSemanticCommand(
            client,
            authority,
            'shared-read',
            'DOM.getContentQuads',
            { backendNodeId: element.backendNodeId },
            ctx.mcpReq.signal,
          ));
          output.quads = property(geometry, 'quads');
        }
        return jsonContent(output);
      } catch (error) {
        return toolError(error);
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
        'Capture a fresh accessibility snapshot with disposable element refs. Interactive mode is compact and actionable; accessibility is complete and bounded; DOM is diagnostic.',
      inputSchema: z.object({
        targetRef: z.string().regex(targetReferencePattern),
        mode: z.enum(['interactive', 'accessibility', 'dom']).default('interactive'),
        maximumCharacters: z.number().int().min(256).max(maximumSnapshotCharacters).optional(),
        root: z.union([z.object({ ref: z.string().regex(elementReferencePattern) }).strict(), z.object({ locator: locatorSchema }).strict()]).optional(),
        maximumDepth: z.number().int().nonnegative().max(1_000).default(20),
        maximumNodes: z.number().int().positive().max(5_000).optional(),
      }),
    },
    async (input, context) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        if (input.root !== undefined && (useRegisteredAutomation || input.mode === 'dom'))
          throw new McpToolError('MCP_SNAPSHOT_SCOPE_UNSUPPORTED', 'Scoped snapshots require native interactive or accessibility mode.');
        const root = input.root === undefined ? undefined : await resolveSemanticElement(client, sessionState, target, input.root, context.mcpReq.signal);
        const maximumNodes = input.maximumNodes ?? (input.mode === 'interactive' ? 500 : 1_500);
        const maximumCharacters = input.maximumCharacters ?? (input.mode === 'interactive' ? maximumInteractiveSnapshotCharacters : maximumSnapshotCharacters);
        const targetAuthority = { targetGeneration: target.generation, targetId: target.id };
        for (const [reference, element] of sessionState.elementReferences) {
          if (element.targetId === target.id)
            sessionState.elementReferences.delete(reference);
        }
        if (useRegisteredAutomation) {
          const result = await executeRegisteredAutomation(
            client,
            target,
            {
              kind: 'snapshot',
              maximumDepth: input.maximumDepth,
              maximumNodes,
              mode: input.mode,
            },
            context.mcpReq.signal,
          );
          const allocated = allocateProviderElements(sessionState, target, result.elements);
          const snapshot = stringValue(property(result.value, 'snapshot'));
          if (snapshot === undefined) return jsonContent(result.value);
          const references = new Map(allocated.map(({ element, ref }) => [stringValue(property(element.metadata, 'providerReference')), ref]));
          const projectedSnapshot = snapshot.replace(providerReferenceAnnotationPattern, (_annotation, providerReference: string) => {
            const reference = references.get(providerReference);
            return reference === undefined ? '' : `[ref=${reference}]`;
          });
          return textContent(boundSnapshotText(projectedSnapshot, maximumCharacters));
        }
        const listedSessions = await executeSemanticCommand(
          client,
          targetAuthority,
          'shared-read',
          'Bridge.listChildSessions',
          {},
          context.mcpReq.signal,
        );
        const iframeSessions = childSessionReferences(listedSessions)
          .filter(session => session.type === 'iframe');
        if (input.mode !== 'dom') {
          const accessibilityMode = input.mode;
          const budget: AccessibilitySnapshotBudget = { remainingCharacters: Math.max(0, maximumCharacters - snapshotTruncationNotice.length - 128), remainingNodes: maximumNodes, truncated: false };
          const captureAccessibility = async (sessionId?: string, frameId?: string): Promise<string> => {
            const commandValue = await executeArtifactCommand(
              client,
              { ...targetAuthority, ...(sessionId === undefined ? {} : { sessionId }) },
              root === undefined ? 'Accessibility.getFullAXTree' : 'Accessibility.queryAXTree',
              root === undefined ? (frameId === undefined ? {} : { frameId }) : { backendNodeId: root.backendNodeId },
              context.mcpReq.signal,
            );
            return formatAccessibilityTree(await readableCommandValue(
              client,
              targetAuthority,
              commandValue,
              context.mcpReq.signal,
            ), {
              budget,
              generation: target.generation,
              maximumDepth: input.maximumDepth,
              mode: accessibilityMode,
              ...(sessionId === undefined ? {} : { sessionId }),
              state: sessionState,
              targetId: target.id,
            });
          };
          const contexts = root === undefined ? await accessibilityFrameContexts(client, target, [{}, ...iframeSessions.map(session => ({ sessionId: session.id }))], context.mcpReq.signal) : [{ ...(root.sessionId === undefined ? {} : { sessionId: root.sessionId }) }];
          const sections: string[] = [];
          for (const [index, frame] of contexts.entries()) {
            if (budget.remainingNodes === 0 || budget.remainingCharacters < 128) {
              budget.truncated = true;
              break;
            }
            sections.push(`# ${root !== undefined ? 'Scoped subtree' : index === 0 ? 'Root session' : 'Frame session'}\n${await captureAccessibility(frame.sessionId, 'frameId' in frame ? frame.frameId : undefined)}`);
            budget.remainingCharacters -= 18;
          }
          if (budget.truncated) sections.push(snapshotTruncationNotice);
          return textContent(boundSnapshotText(sections.join('\n\n'), maximumCharacters));
        }
        const capture = async (
          maximumNodes: number,
          sessionId?: string,
        ): Promise<FormattedDomSnapshot> => {
          const commandValue = await executeArtifactCommand(
            client,
            { ...targetAuthority, ...(sessionId === undefined ? {} : { sessionId }) },
            'DOMSnapshot.captureSnapshot',
            {
              computedStyles: [],
              includeDOMRects: false,
              includePaintOrder: false,
            },
            context.mcpReq.signal,
          );
          return formatDomSnapshot(
            await readableCommandValue(
              client,
              targetAuthority,
              commandValue,
              context.mcpReq.signal,
            ),
            {
              maximumDepth: input.maximumDepth,
              maximumNodes,
            },
          );
        };
        const rootSnapshot = await capture(maximumNodes);
        const sections = [`# Root session\n${rootSnapshot.text}`];
        let remainingNodes = Math.max(
          0,
          maximumNodes - rootSnapshot.renderedNodes,
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
          boundSnapshotText(sections.join('\n\n'), maximumCharacters),
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
        'Capture a screenshot as image content. Debug sessions preserve the inline-or-artifact protocol result.',
      inputSchema: z.object({
        format: z.enum(['jpeg', 'png', 'webp']).default('png'),
        targetRef: z.string().regex(targetReferencePattern),
      }),
    },
    async (input, context) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const authority = { targetGeneration: target.generation, targetId: target.id };
        const result = await executeArtifactCommand(client, authority, 'Page.captureScreenshot', { format: input.format }, context.mcpReq.signal);
        if (enableRawCdp) return jsonContent(result);
        const retained = retainedArtifactResult(result);
        const value = retained === undefined ? result : await readRetainedArtifact(client, authority, retained, context.mcpReq.signal);
        const data = stringValue(property(value, 'data'));
        if (data === undefined) throw new McpToolError('MCP_SCREENSHOT_INVALID', 'Chrome returned no screenshot image data.');
        return { content: [{ type: 'image', data, mimeType: `image/${input.format}` }] };
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
      inputSchema: z.object({
        requestId: z.string().min(1),
        targetRef: z.string().regex(targetReferencePattern),
      }),
    },
    async (input, context) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        return jsonContent(
          await executeArtifactCommand(
            client,
            { targetGeneration: target.generation, targetId: target.id },
            'Network.getResponseBody',
            { requestId: input.requestId },
            context.mcpReq.signal,
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
        'Debug escape hatch: evaluate page JavaScript. This bypasses locator guarantees and visible pointer presentation.',
      inputSchema: z.object({
        expression: z.string().min(1),
        targetRef: z.string().regex(targetReferencePattern),
      }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        return jsonContent(
          await executeSemanticCommand(
            client,
            { targetGeneration: target.generation, targetId: target.id },
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
        'Navigate a target and retain its stable target reference across the new document.',
      inputSchema: z.object({ ...lifecycleInput, url: z.url() }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const result = await executeLifecycleAction(
          client,
          {
            targetGeneration: target.generation,
            targetId: target.id,
            timeoutMilliseconds: input.timeoutMilliseconds,
            waitUntil: input.waitUntil,
          },
          ['Page.navigate'],
          async execute => execute('Page.navigate', { url: input.url }),
          ctx.mcpReq.signal,
        );
        await resolveSemanticTarget(client, sessionState, input.targetRef);
        return jsonContent(semanticLifecycleResult(result, input.targetRef));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.back',
    {
      description: 'Navigate one entry back while retaining the stable target reference.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const result = await navigateHistory({
          targetGeneration: target.generation,
          targetId: target.id,
          timeoutMilliseconds: input.timeoutMilliseconds,
          waitUntil: input.waitUntil,
        }, -1, ctx.mcpReq.signal);
        return jsonContent(semanticLifecycleResult(result, input.targetRef));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.forward',
    {
      description: 'Navigate one entry forward while retaining the stable target reference.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const result = await navigateHistory({
          targetGeneration: target.generation,
          targetId: target.id,
          timeoutMilliseconds: input.timeoutMilliseconds,
          waitUntil: input.waitUntil,
        }, 1, ctx.mcpReq.signal);
        return jsonContent(semanticLifecycleResult(result, input.targetRef));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.reload',
    {
      description: 'Reload a target while retaining the stable target reference.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const result = await executeLifecycleAction(
          client,
          {
            targetGeneration: target.generation,
            targetId: target.id,
            timeoutMilliseconds: input.timeoutMilliseconds,
            waitUntil: input.waitUntil,
          },
          ['Page.reload'],
          async execute => execute('Page.reload', {}),
          ctx.mcpReq.signal,
        );
        return jsonContent(semanticLifecycleResult(result, input.targetRef));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.click',
    {
      description: 'Click one element by a fresh ref or a strict locator after bounded actionability checks.',
      inputSchema: z.object({
        button: pointerButtonSchema,
        clickCount: z.number().int().positive().max(3).default(1),
        locator: locatorSchema.optional(),
        modifiers: inputModifiersSchema,
        ref: z.string().regex(elementReferencePattern).optional(),
        targetRef: z.string().regex(targetReferencePattern),
        timeoutMilliseconds: z.number().int().positive().max(timing.maximumToolTimeoutMilliseconds).default(timing.defaultToolTimeoutMilliseconds),
      }).refine(input => (input.ref === undefined) !== (input.locator === undefined), {
        message: 'Provide exactly one of ref or locator.',
      }),
    },
    async (input, context) => {
      try {
        if (useRegisteredAutomation) {
          const automationAttempt = async (): Promise<AutomationExecutionResult> => {
            const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
            return executeRegisteredAutomation(
              client,
              target,
              {
                action: 'click',
                button: input.button,
                clickCount: input.clickCount,
                ...automationElementTarget(sessionState, target, input),
                kind: 'action',
                modifiers: input.modifiers,
                timeoutMilliseconds: input.timeoutMilliseconds,
              },
              context.mcpReq.signal,
            );
          };
          try {
            return jsonContent((await automationAttempt()).value);
          } catch (error) {
            if (input.locator === undefined || property(error, 'code') !== 'TARGET_GENERATION_STALE') throw error;
            return jsonContent((await automationAttempt()).value);
          }
        }
        return jsonContent(await executeWithRenewedLocatorRetry(client, sessionState, input, async (target) => {
          const element = await resolveSemanticElementWithRetry(client, sessionState, target, input, context.mcpReq.signal);
          return executeElementClick(client, target, element, input, context.mcpReq.signal);
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.click_at',
    {
      description:
        'Click explicit viewport coordinates. Prefer browser.click with a ref or locator.',
      inputSchema: z.object({
        button: pointerButtonSchema,
        clickCount: z.number().int().positive().max(3).default(1),
        modifiers: inputModifiersSchema,
        targetRef: z.string().regex(targetReferencePattern),
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const actionInput = {
          ...input,
          targetGeneration: target.generation,
          targetId: target.id,
        };
        const results: unknown[] = [];
        let buttonPressed = false;
        const modifiers = encodeInputModifiers(input.modifiers);
        await executeInputAction(
          client,
          actionInput,
          ['Input.dispatchMouseEvent'],
          ctx.mcpReq.signal,
          async (execute, executeCleanup) => {
            try {
              results.push(await execute('Input.dispatchMouseEvent', {
                modifiers,
                type: 'mouseMoved',
                x: input.x,
                y: input.y,
              }));
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
        pointerPositions.set(pointerPositionKey(actionInput), { x: input.x, y: input.y });
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.move_at',
    {
      description:
        'Move or hover the pointer at explicit viewport coordinates. Prefer browser.hover when a snapshot reference or locator is available.',
      inputSchema: z.object({
        ...inputActionTiming,
        modifiers: inputModifiersSchema,
        targetRef: z.string().regex(targetReferencePattern),
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const actionInput = { ...input, targetGeneration: target.generation, targetId: target.id };
        const destination = { x: input.x, y: input.y };
        const points = interpolateViewportPoints(
          pointerPositions.get(pointerPositionKey(actionInput)) ?? destination,
          destination,
          input.steps,
        );
        const modifiers = encodeInputModifiers(input.modifiers);
        const stepDuration = input.durationMilliseconds / input.steps;
        const results: unknown[] = [];
        await executeInputAction(
          client,
          actionInput,
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
        pointerPositions.set(pointerPositionKey(actionInput), destination);
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  register(
    'browser.scroll_at',
    {
      description: 'Dispatch a bounded mouse-wheel scroll at explicit viewport coordinates.',
      inputSchema: z.object({
        ...inputActionTiming,
        deltaX: z.number().finite(),
        deltaY: z.number().finite(),
        modifiers: inputModifiersSchema,
        targetRef: z.string().regex(targetReferencePattern),
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
      }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const actionInput = { ...input, targetGeneration: target.generation, targetId: target.id };
        if (input.deltaX === 0 && input.deltaY === 0)
          throw new McpToolError('MCP_TOOL_FAILED', 'At least one scroll delta must be non-zero.');
        const modifiers = encodeInputModifiers(input.modifiers);
        const stepDuration = input.durationMilliseconds / input.steps;
        const results: unknown[] = [];
        await executeInputAction(
          client,
          actionInput,
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
    'browser.drag_at',
    {
      description: 'Drag the pointer along a bounded viewport path.',
      inputSchema: z.object({
        button: pointerButtonSchema,
        durationMilliseconds: inputActionTiming.durationMilliseconds,
        modifiers: inputModifiersSchema,
        targetRef: z.string().regex(targetReferencePattern),
        path: z.array(z.object({
          x: z.number().nonnegative(),
          y: z.number().nonnegative(),
        })).min(2).max(maximumInputActionSteps),
      }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const actionInput = { ...input, targetGeneration: target.generation, targetId: target.id };
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
          actionInput,
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
        pointerPositions.set(pointerPositionKey(actionInput), lastPoint);
        return jsonContent(results);
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const nestedElementTargetSchema = z.object({
    locator: locatorSchema.optional(),
    ref: z.string().regex(elementReferencePattern).optional(),
  }).refine(hasExactlyOneElementTarget, { message: 'Provide exactly one of ref or locator.' });
  register(
    'browser.drag',
    {
      description: 'Drag from one element to another using fresh refs or strict locators.',
      inputSchema: z.object({
        button: pointerButtonSchema,
        destination: nestedElementTargetSchema,
        durationMilliseconds: inputActionTiming.durationMilliseconds,
        modifiers: inputModifiersSchema,
        source: nestedElementTargetSchema,
        targetRef: z.string().regex(targetReferencePattern),
        timeoutMilliseconds: z.number().int().positive().max(timing.maximumToolTimeoutMilliseconds).default(timing.defaultToolTimeoutMilliseconds),
      }),
    },
    async (input, context) => {
      try {
        if (useRegisteredAutomation) {
          const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
          const destination = automationElementTarget(sessionState, target, input.destination);
          const source = automationElementTarget(sessionState, target, input.source);
          const result = await executeRegisteredAutomation(
            client,
            target,
            {
              action: 'drag',
              button: input.button,
              ...(destination.elementHandleId === undefined
                ? {}
                : { destinationElementHandleId: destination.elementHandleId }),
              ...(destination.locator === undefined
                ? {}
                : { destinationLocator: destination.locator }),
              ...source,
              kind: 'action',
              modifiers: input.modifiers,
              timeoutMilliseconds: input.timeoutMilliseconds,
            },
            context.mcpReq.signal,
          );
          return jsonContent(result.value);
        }
        const retryLocator = input.source.locator !== undefined && input.destination.locator !== undefined
          ? input.source.locator
          : undefined;
        return jsonContent(await executeWithRenewedLocatorRetry(
          client,
          sessionState,
          { locator: retryLocator, targetRef: input.targetRef },
          async (target) => {
            const source = await resolveSemanticElementWithRetry(
              client,
              sessionState,
              target,
              { ...input.source, timeoutMilliseconds: input.timeoutMilliseconds },
              context.mcpReq.signal,
            );
            const destination = await resolveSemanticElementWithRetry(
              client,
              sessionState,
              target,
              { ...input.destination, timeoutMilliseconds: input.timeoutMilliseconds },
              context.mcpReq.signal,
            );
            if (source.sessionId !== destination.sessionId)
              throw new McpToolError('MCP_DRAG_CROSS_FRAME_UNSUPPORTED', 'A drag cannot cross frame sessions.');
            const firstPoint = await elementCenterPoint(client, target, source, context.mcpReq.signal);
            const lastPoint = await elementCenterPoint(client, target, destination, context.mcpReq.signal);
            const path = interpolateViewportPoints(firstPoint, lastPoint, Math.max(2, Math.ceil(input.durationMilliseconds / 50)));
            const actionInput = {
              ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
              targetGeneration: target.generation,
              targetId: target.id,
            };
            let buttonPressed = false;
            let currentPoint = firstPoint;
            const dispatchState = { inputDispatched: false };
            const results: unknown[] = [];
            try {
              await executeInputAction(
                client,
                actionInput,
                ['Input.cancelDragging', 'Input.dispatchMouseEvent'],
                context.mcpReq.signal,
                async (execute, executeCleanup) => {
                  try {
                    dispatchState.inputDispatched = true;
                    results.push(await execute('Input.dispatchMouseEvent', {
                      modifiers: encodeInputModifiers(input.modifiers),
                      type: 'mouseMoved',
                      ...firstPoint,
                    }));
                    results.push(await execute('Input.dispatchMouseEvent', {
                      button: input.button,
                      buttons: pointerButtonValues[input.button],
                      clickCount: 1,
                      modifiers: encodeInputModifiers(input.modifiers),
                      type: 'mousePressed',
                      ...firstPoint,
                    }));
                    buttonPressed = true;
                    for (const point of path.slice(1)) {
                      currentPoint = point;
                      results.push(await execute('Input.dispatchMouseEvent', {
                        button: input.button,
                        buttons: pointerButtonValues[input.button],
                        modifiers: encodeInputModifiers(input.modifiers),
                        type: 'mouseMoved',
                        ...point,
                      }));
                      await waitForInputStep(input.durationMilliseconds / Math.max(1, path.length - 1), context.mcpReq.signal);
                    }
                    results.push(await execute('Input.dispatchMouseEvent', {
                      button: input.button,
                      clickCount: 1,
                      modifiers: encodeInputModifiers(input.modifiers),
                      type: 'mouseReleased',
                      ...lastPoint,
                    }));
                    buttonPressed = false;
                  } finally {
                    if (buttonPressed) {
                      await executeCleanup('Input.dispatchMouseEvent', {
                        button: input.button,
                        clickCount: 1,
                        modifiers: encodeInputModifiers(input.modifiers),
                        type: 'mouseReleased',
                        ...currentPoint,
                      });
                    }
                    if (context.mcpReq.signal.aborted)
                      await executeCleanup('Input.cancelDragging', {});
                  }
                },
              );
            } catch (error) {
              if (dispatchState.inputDispatched)
                throw new McpToolError('MCP_ACTION_OUTCOME_UNKNOWN', 'Drag input may have been dispatched before the action failed. The action was not replayed.');
              throw error;
            }
            return results;
          },
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const registerElementInteraction = (
    name: 'browser.fill' | 'browser.focus' | 'browser.hover' | 'browser.press' | 'browser.scroll_into_view' | 'browser.type',
    description: string,
    interaction: 'fill' | 'focus' | 'hover' | 'press' | 'scroll-into-view' | 'type',
  ): void => {
    register(
      name,
      {
        description,
        inputSchema: z.object({
          ...elementTargetShape,
          ...(interaction === 'fill' || interaction === 'type'
            ? { text: z.string().max(100_000) }
            : {}),
          ...(interaction === 'press' ? { key: z.string().min(1).max(64) } : {}),
          modifiers: inputModifiersSchema,
        }).refine(hasExactlyOneElementTarget, { message: 'Provide exactly one of ref or locator.' }),
      },
      async (input, context) => {
        try {
          if (useRegisteredAutomation) {
            const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
            const text = stringValue(property(input, 'text'));
            const key = stringValue(property(input, 'key'));
            const targetInput = automationElementTarget(sessionState, target, input);
            const operation: AutomationOperation = interaction === 'fill' || interaction === 'type'
              ? {
                  action: interaction,
                  ...targetInput,
                  kind: 'action',
                  modifiers: input.modifiers,
                  text: text ?? '',
                  timeoutMilliseconds: input.timeoutMilliseconds,
                }
              : interaction === 'press'
                ? {
                    action: 'press',
                    ...targetInput,
                    key: key ?? '',
                    kind: 'action',
                    modifiers: input.modifiers,
                    timeoutMilliseconds: input.timeoutMilliseconds,
                  }
                : {
                    action: interaction,
                    ...targetInput,
                    kind: 'action',
                    modifiers: input.modifiers,
                    timeoutMilliseconds: input.timeoutMilliseconds,
                  };
            const result = await executeRegisteredAutomation(
              client,
              target,
              operation,
              context.mcpReq.signal,
            );
            return jsonContent(result.value);
          }
          const interactionInput: ElementInteraction = interaction === 'fill' || interaction === 'type'
            ? { kind: interaction, text: String(property(input, 'text') ?? '') }
            : interaction === 'press'
              ? { key: String(property(input, 'key') ?? ''), kind: 'press' }
              : { kind: interaction };
          return jsonContent(await executeWithRenewedLocatorRetry(
            client,
            sessionState,
            input,
            async (target) => {
              const element = await resolveSemanticElementWithRetry(
                client,
                sessionState,
                target,
                input,
                context.mcpReq.signal,
              );
              return executeElementInteraction(
                client,
                target,
                element,
                interactionInput,
                input.modifiers,
                input.timeoutMilliseconds,
                context.mcpReq.signal,
              );
            },
          ));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  };
  registerElementInteraction('browser.hover', 'Move the visible agent pointer to an element selected by ref or locator.', 'hover');
  registerElementInteraction('browser.focus', 'Focus an element selected by ref or locator.', 'focus');
  registerElementInteraction('browser.fill', 'Replace the value of an editable element selected by ref or locator.', 'fill');
  registerElementInteraction('browser.type', 'Insert text into an editable element selected by ref or locator.', 'type');
  registerElementInteraction('browser.press', 'Focus an element and dispatch a key.', 'press');
  registerElementInteraction('browser.scroll_into_view', 'Scroll an element into the viewport.', 'scroll-into-view');
  for (const [name, desiredState] of [
    ['browser.check', true],
    ['browser.uncheck', false],
  ] as const) {
    register(
      name,
      {
        description: `${desiredState ? 'Check' : 'Uncheck'} a checkbox or switch selected by ref or locator.`,
        inputSchema: z.object({
          ...elementTargetShape,
          modifiers: inputModifiersSchema,
        }).refine(hasExactlyOneElementTarget, { message: 'Provide exactly one of ref or locator.' }),
      },
      async (input, context) => {
        try {
          if (useRegisteredAutomation) {
            const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
            const result = await executeRegisteredAutomation(
              client,
              target,
              {
                action: desiredState ? 'check' : 'uncheck',
                ...automationElementTarget(sessionState, target, input),
                kind: 'action',
                modifiers: input.modifiers,
                timeoutMilliseconds: input.timeoutMilliseconds,
              },
              context.mcpReq.signal,
            );
            return jsonContent(result.value);
          }
          return jsonContent(await executeWithRenewedLocatorRetry(
            client,
            sessionState,
            input,
            async (target) => {
              const element = await resolveSemanticElementWithRetry(
                client,
                sessionState,
                target,
                input,
                context.mcpReq.signal,
              );
              const currentState = await elementCheckedState(client, target, element, context.mcpReq.signal);
              if (currentState === undefined)
                throw new McpToolError('MCP_ELEMENT_NOT_CHECKABLE', 'The element is not checkable.');
              if (currentState === desiredState) return { changed: false, checked: currentState };
              await executeElementClick(client, target, element, {
                button: 'left',
                clickCount: 1,
                modifiers: input.modifiers,
                timeoutMilliseconds: input.timeoutMilliseconds,
              }, context.mcpReq.signal);
              let verifiedState: boolean | 'mixed' | undefined;
              try {
                verifiedState = await elementCheckedState(client, target, element, context.mcpReq.signal);
              } catch {
                throw new McpToolError('MCP_ACTION_OUTCOME_UNKNOWN', 'The check action was dispatched but its resulting state could not be read. It was not replayed.');
              }
              if (verifiedState !== desiredState)
                throw new McpToolError('MCP_ACTION_VERIFICATION_FAILED', 'The control did not reach the requested checked state. Inspect it before taking another action.');
              return { changed: true, checked: verifiedState };
            },
          ));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
  register(
    'browser.batch',
    {
      description: 'Run up to 20 ordered element actions on one target under one lease. Stops on failure, cancellation, authority or document replacement. Never rolls back or replays input.',
      inputSchema: z.object({
        targetRef: z.string().regex(targetReferencePattern),
        actions: z.array(z.strictObject({
          action: z.enum(['click', 'fill', 'type', 'press', 'check', 'uncheck', 'focus', 'hover', 'scroll-into-view']),
          ref: z.string().regex(elementReferencePattern).optional(),
          locator: locatorSchema.optional(),
          text: z.string().max(20_000).optional(),
          key: z.string().max(100).optional(),
          modifiers: inputModifiersSchema,
          button: pointerButtonSchema.optional(),
          clickCount: z.number().int().min(1).max(3).optional(),
        }).refine(hasExactlyOneElementTarget, { message: 'Each action requires exactly one ref or locator.' })).min(1).max(20),
        observe: z.boolean().default(false),
        timeoutMilliseconds: z.number().int().min(1).max(30_000).default(30_000),
      }),
    },
    async (input, context) => {
      const completed: { index: number; action: string }[] = [];
      const cancellation = new AbortController();
      const signal = AbortSignal.any([context.mcpReq.signal, cancellation.signal]);
      const batchFailure = (failure: CallToolResult, failedStep?: number): CallToolResult => {
        const content = failure.content.find(item => item.type === 'text');
        let error = objectValue(content?.type === 'text' ? JSON.parse(content.text) : undefined);
        if (signal.aborted && error.code !== 'MCP_ACTION_OUTCOME_UNKNOWN') {
          const cancellationContent = toolError(signal.reason).content.find(item => item.type === 'text');
          error = objectValue(cancellationContent?.type === 'text' ? JSON.parse(cancellationContent.text) : undefined);
        }
        return {
          ...jsonContent({
            ...error,
            details: {
              ...objectValue(error.details),
              completed,
              ...(failedStep === undefined ? { phase: 'observation' } : { failedStep }),
              ...(error.code === 'MCP_ACTION_OUTCOME_UNKNOWN' ? { uncertain: true } : {}),
            },
          }),
          isError: true,
        };
      };
      const timeout = setTimeout(() => cancellation.abort(new McpToolError('MCP_BATCH_TIMEOUT', 'The batch exceeded its total deadline.')), input.timeoutMilliseconds);
      timeout.unref?.();
      const subscriptions: CdpSubscription[] = [];
      let acquiredLease: Lease | undefined;
      const deadline = Date.now() + input.timeoutMilliseconds;
      try {
        if (useRegisteredAutomation) throw new McpToolError('MCP_BATCH_PROVIDER_UNSUPPORTED', 'Batches currently require the native engine.');
        const steps = await Promise.all(input.actions.map(async ({ action, ...parameters }) => {
          const definition = definitions.find(candidate => candidate.name === `browser.${action === 'scroll-into-view' ? 'scroll_into_view' : action}`);
          if (definition === undefined) throw new McpToolError('MCP_BATCH_ACTION_UNSUPPORTED', 'The requested batch action is unavailable.');
          const parsed = await definition.mcpInputSchema.parseAsync({ ...parameters, targetRef: input.targetRef });
          return { action, definition, parameters: parsed };
        }));
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const authority = { targetId: target.id, targetGeneration: target.generation };
        acquiredLease = await rawClient.acquireLease({ ...authority, mode: 'exclusive-control', durationMilliseconds: input.timeoutMilliseconds, requestedMethods: [...new Set([...ancestorFrameMethods, 'Accessibility.getPartialAXTree', 'Accessibility.getFullAXTree', 'Accessibility.queryAXTree', 'DOM.describeNode', 'DOM.getContentQuads', 'DOM.getDocument', 'DOM.getFlattenedDocument', 'DOM.querySelectorAll', 'DOM.performSearch', 'DOM.getSearchResults', 'DOM.discardSearchResults', 'DOM.scrollIntoViewIfNeeded', 'DOM.focus', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Page.frameNavigated', 'DOM.documentUpdated'])] });
        const lease = acquiredLease;
        return await batchLease.run(lease, async () => {
          const sessions = childSessionReferences(await executeSemanticCommand(client, authority, 'shared-read', 'Bridge.listChildSessions', {}, signal)).filter(session => session.type === 'iframe');
          for (const sessionId of [undefined, ...sessions.map(session => session.id)]) {
            for (const method of ['Page.frameNavigated', 'DOM.documentUpdated']) {
              const subscription = await client.subscribe({ ...authority, leaseId: lease.id, match: { method }, ...(sessionId === undefined ? {} : { sessionId }), buffer: { capacity: 1, overflowStrategy: 'drop-oldest' } });
              subscriptions.push(subscription);
              void subscription[Symbol.asyncIterator]().next().then((event) => {
                if (!event.done) cancellation.abort(new McpToolError('MCP_BATCH_DOCUMENT_REPLACED', 'A document was replaced during the batch.'));
              }).catch(() => cancellation.abort(new McpToolError('MCP_BATCH_AUTHORITY_REPLACED', 'The batch event channel closed.')));
            }
          }
          for (const [index, step] of steps.entries()) {
            if (signal.aborted) throw signal.reason;
            const currentTarget = await resolveSemanticTarget(client, sessionState, input.targetRef);
            if (currentTarget.generation !== target.generation) throw new McpToolError('MCP_BATCH_AUTHORITY_REPLACED', 'Target authority changed during the batch.');
            const result = await step.definition.invoke({ ...step.parameters, timeoutMilliseconds: Math.max(1, deadline - Date.now()) }, { signal });
            if (result.isError) return batchFailure(result, index);
            completed.push({ index, action: step.action });
          }
          if (signal.aborted) throw signal.reason;
          if (input.observe) {
            const snapshot = definitions.find(definition => definition.name === 'browser.snapshot');
            const observation = await snapshot?.invoke({ targetRef: input.targetRef }, { signal });
            if (observation?.isError) return batchFailure(observation);
            const content = observation?.content.find(item => item.type === 'text');
            return jsonContent({ completed, observation: content?.type === 'text' ? content.text : undefined });
          }
          return jsonContent({ completed });
        });
      } catch (error) {
        return batchFailure(toolError(signal.aborted ? signal.reason : error), completed.length);
      } finally {
        clearTimeout(timeout);
        for (const subscription of subscriptions) subscription.close();
        if (acquiredLease !== undefined) {
          try {
            await rawClient.releaseLease({ leaseId: acquiredLease.id, targetId: acquiredLease.targetId, targetGeneration: acquiredLease.targetGeneration });
          } catch { /** A revoked lease needs no further cleanup. */ }
        }
      }
    },
  );
  register(
    'browser.select_option',
    {
      description: 'Focus a select element and choose an option by its visible label.',
      inputSchema: z.object({
        ...elementTargetShape,
        label: z.string().min(1).max(2_000),
      }).refine(hasExactlyOneElementTarget, { message: 'Provide exactly one of ref or locator.' }),
    },
    async (input, context) => {
      try {
        if (useRegisteredAutomation) {
          const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
          const result = await executeRegisteredAutomation(
            client,
            target,
            {
              action: 'select-option',
              ...automationElementTarget(sessionState, target, input),
              kind: 'action',
              label: input.label,
              timeoutMilliseconds: input.timeoutMilliseconds,
            },
            context.mcpReq.signal,
          );
          return jsonContent(result.value);
        }
        return jsonContent(await executeWithRenewedLocatorRetry(
          client,
          sessionState,
          input,
          async (target) => {
            const element = await resolveSemanticElementWithRetry(
              client,
              sessionState,
              target,
              input,
              context.mcpReq.signal,
            );
            await executeElementInteraction(
              client,
              target,
              element,
              { kind: 'focus' },
              [],
              input.timeoutMilliseconds,
              context.mcpReq.signal,
            );
            await executeSemanticCommand(
              client,
              {
                ...(element.sessionId === undefined ? {} : { sessionId: element.sessionId }),
                targetGeneration: target.generation,
                targetId: target.id,
              },
              'exclusive-control',
              'Input.insertText',
              { text: input.label },
              context.mcpReq.signal,
            );
            await executeElementInteraction(
              client,
              target,
              element,
              { key: 'Enter', kind: 'press' },
              [],
              input.timeoutMilliseconds,
              context.mcpReq.signal,
            );
            return { selected: input.label };
          },
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const eventWaitInput = {
    targetRef: z.string().regex(targetReferencePattern),
    leaseId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    timeoutMilliseconds: z.number().int().positive().max(timing.maximumToolTimeoutMilliseconds).default(timing.defaultEventTimeoutMilliseconds),
  };
  register(
    'browser.wait_for_navigation',
    {
      description: 'Wait for a bounded root or child-session navigation milestone and fail promptly on JavaScript dialogs.',
      inputSchema: z.object(lifecycleInput),
    },
    async (input, ctx) => {
      const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
      const lifecycleAuthority: LifecycleInput = {
        targetGeneration: target.generation,
        targetId: target.id,
        timeoutMilliseconds: input.timeoutMilliseconds,
        waitUntil: input.waitUntil,
      };
      const renewalAbortController = new AbortController();
      const renewedTarget = waitForRenewedTarget(client, lifecycleAuthority, renewalAbortController.signal);
      renewedTarget.catch(() => {});
      try {
        const event = await waitForNavigationEvent(client, lifecycleAuthority, ctx.mcpReq.signal);
        let currentTarget = (await client.listTargets()).find(candidate => candidate.id === target.id);
        if (currentTarget === undefined)
          throw new McpToolError('TARGET_NOT_FOUND', 'The navigated target is no longer available.');
        if (
          event.method !== 'Page.navigatedWithinDocument'
          && currentTarget.generation <= target.generation
        ) currentTarget = await renewedTarget;
        return jsonContent({ event: semanticEvent(event), target: projectSemanticTarget(sessionState, currentTarget) });
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
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const { leaseId, ...eventInput } = input;
        return jsonContent(semanticEvent(await waitForEvent(client, {
          sessionId: eventInput.sessionId,
          targetGeneration: target.generation,
          targetId: target.id,
          timeoutMilliseconds: eventInput.timeoutMilliseconds,
          ...(leaseId === undefined ? {} : { leaseId }),
          method: 'Page.javascriptDialogOpening',
        }, ctx.mcpReq.signal)));
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
        targetRef: z.string().regex(targetReferencePattern),
        accept: z.boolean(),
        promptText: z.string().optional(),
        sessionId: z.string().uuid().optional(),
      }),
    },
    async (input, ctx) => {
      try {
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        return jsonContent(await executeSemanticCommand(
          client,
          {
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            targetGeneration: target.generation,
            targetId: target.id,
          },
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
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const { leaseId, ...eventInput } = input;
        return jsonContent(
          semanticEvent(await waitForEvent(
            client,
            {
              sessionId: eventInput.sessionId,
              targetGeneration: target.generation,
              targetId: target.id,
              timeoutMilliseconds: eventInput.timeoutMilliseconds,
              ...(leaseId === undefined ? {} : { leaseId }),
              method: 'Runtime.consoleAPICalled',
            },
            ctx.mcpReq.signal,
          )),
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
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const { leaseId, ...eventInput } = input;
        return jsonContent(
          semanticEvent(await waitForEvent(
            client,
            {
              sessionId: eventInput.sessionId,
              targetGeneration: target.generation,
              targetId: target.id,
              timeoutMilliseconds: eventInput.timeoutMilliseconds,
              ...(leaseId === undefined ? {} : { leaseId }),
              method: 'Network.responseReceived',
            },
            ctx.mcpReq.signal,
          )),
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
        const target = await resolveSemanticTarget(client, sessionState, input.targetRef);
        const { leaseId, ...eventInput } = input;
        return jsonContent(
          semanticEvent(await waitForEvent(
            client,
            {
              method: eventInput.method,
              sessionId: eventInput.sessionId,
              targetGeneration: target.generation,
              targetId: target.id,
              timeoutMilliseconds: eventInput.timeoutMilliseconds,
              ...(leaseId === undefined ? {} : { leaseId }),
            },
            ctx.mcpReq.signal,
          )),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const diagnosticTools = new Set(['browser.acquire', 'browser.renew', 'browser.release', 'browser.release_artifact', 'browser.read_artifact', 'browser.evaluate', 'browser.network_body', 'browser.console', 'browser.network']);
  return enableRawCdp ? definitions : definitions.filter(definition => !diagnosticTools.has(definition.name));
}

/** Creates one stateful semantic tool session owned by an MCP principal. */
export function createCdbToolSession(
  options: RegisterCdbToolsOptions,
): CdbToolSession {
  const state = createCdbToolSessionState();
  const rebindableClient = createRebindableMcpClient(options.client);
  const definitions = createCdbToolDefinitionsForSession({ ...options, client: rebindableClient.client }, state);
  return {
    definitions,
    dispose() {
      state.disposed = true;
      state.agentSession.dispose();
      state.elementReferences.clear();
    },
    projectTarget: target => projectSemanticTarget(state, target),
    rebindClient(client) {
      if (state.disposed) return;
      rebindableClient.rebind(client);
      state.elementReferences.clear();
    },
    revokeTarget(targetId) {
      if (state.disposed) return;
      state.agentSession.revoke(targetId);
      for (const [elementRef, element] of state.elementReferences)
        if (element.targetId === targetId) state.elementReferences.delete(elementRef);
    },
    targetIdForReference: targetRef => state.disposed ? undefined : state.agentSession.resolve(targetRef)?.targetId,
  };
}

/** @deprecated Hosts should keep one createCdbToolSession result per principal. */
export function createCdbToolDefinitions(
  options: RegisterCdbToolsOptions,
): CdbToolDefinition[] {
  return [...createCdbToolSession(options).definitions];
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
  registerCdbToolDefinitions(server, createCdbToolSession(options).definitions);
}

function registerCdbToolDefinitions(
  server: McpServer,
  definitions: readonly CdbToolDefinition[],
): void {
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
  definitions: readonly CdbToolDefinition[],
): McpServer {
  const server = new McpServer({
    name: 'chrome-debugger-bridge',
    version: packageManifest.version,
  });
  registerCdbToolDefinitions(server, definitions);
  return server;
}

/** Mounts the official MCP SDK Streamable HTTP transport without taking ownership of the broker or HTTP server. */
export function mountMcpStreamableHttp(
  options: MountMcpStreamableHttpOptions,
): MountedMcpStreamableHttp {
  const path = options.path ?? '/cdb/mcp';
  const session = createCdbToolSession(options);
  const handler = createMcpHandler(
    () => createMcpServer(session.definitions),
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
      session.dispose();
    },
  };
}

/** Starts an optional stdio adapter around the same MCP tool surface without owning broker lifecycle. */
export function mountMcpStdio(options: MountMcpStdioOptions): MountedMcpStdio {
  const session = createCdbToolSession(options);
  const mounted = serveStdio(
    () => createMcpServer(session.definitions),
    { ...options.stdio, legacy: 'reject' },
  );
  return {
    async close() {
      await mounted.close();
      session.dispose();
    },
  };
}
