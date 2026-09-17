import type { JsonObject, JsonValue, PublishedTarget, WebMcpTool } from '@dvcol/cdb';

import { WebMcpError, webMcpMethods } from '@dvcol/cdb';

export interface WebMcpPageContext {
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly url: string;
}

export interface WebMcpDiscoveryContext extends WebMcpPageContext {
  readonly tool: WebMcpTool;
}

export type WebMcpToolMatcher = string | RegExp | ((context: WebMcpDiscoveryContext) => boolean | Promise<boolean>);

export interface WebMcpOptions {
  /** Controls discovery only; an authorized caller may still invoke a known tool name. */
  readonly discovery?: {
    readonly enabled?: boolean | ((context: WebMcpPageContext) => boolean | Promise<boolean>);
    readonly include?: readonly WebMcpToolMatcher[];
    readonly exclude?: readonly WebMcpToolMatcher[];
  };
}

/** Checks policy shapes without evaluating host callbacks. */
export function validateWebMcpOptions(options: WebMcpOptions | undefined): void {
  const policy = options?.discovery;
  if (policy === undefined) return;
  if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean' && typeof policy.enabled !== 'function')
    throw new TypeError('WebMCP discovery.enabled must be a boolean or callback.');
  for (const rules of [policy.include, policy.exclude]) {
    if (rules === undefined) continue;
    if (!Array.isArray(rules) || rules.some(rule => typeof rule !== 'string' && typeof rule !== 'function' && !(rule instanceof RegExp)))
      throw new TypeError('WebMCP discovery rules must be arrays of names, regular expressions, or callbacks.');
  }
}

interface MainDocument {
  readonly frameId: string;
  readonly loaderId: string;
  readonly reference: string;
  readonly url: string;
}

interface PendingInvocation {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: JsonObject) => void;
}

export interface WebMcpController {
  setActive: (active: boolean) => Promise<void>;
  execute: (method: string, parameters: JsonObject | undefined, signal: AbortSignal) => Promise<JsonObject>;
  event: (method: string, parameters: JsonObject) => void;
  dispose: () => Promise<void>;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value;
}

async function matches(rule: WebMcpToolMatcher, context: WebMcpDiscoveryContext): Promise<boolean> {
  if (typeof rule === 'string') return rule === context.tool.name;
  if (rule instanceof RegExp) return new RegExp(rule.source, rule.flags).test(context.tool.name);
  return rule(context);
}

async function matchesAny(rules: readonly WebMcpToolMatcher[], context: WebMcpDiscoveryContext): Promise<boolean> {
  for (const rule of rules) if (await matches(rule, context)) return true;
  return false;
}

async function untilAborted<Value>(operation: Promise<Value>, signal: AbortSignal, cancellationError = new WebMcpError('REQUEST_CANCELLED', 'The WebMCP operation was cancelled.')): Promise<Value> {
  const cancelled = Promise.withResolvers<never>();
  const abort = (): void => cancelled.reject(cancellationError);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([operation, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Owns native main-document state beneath one publisher's target-generation boundary. */
export function createWebMcpController(options: {
  readonly target: Pick<PublishedTarget, 'id' | 'generation'>;
  readonly policy?: WebMcpOptions;
  readonly maximumResultBytes: number;
  readonly sendCommand: (method: string, parameters?: JsonObject) => Promise<JsonObject>;
}): WebMcpController {
  const tools = new Map<string, JsonObject>();
  const references = new Map<string, { readonly document: string; readonly name: string }>();
  const referencesByName = new Map<string, string>();
  const pending = new Map<string, PendingInvocation>();
  const lifetime = new AbortController();
  let document: MainDocument | undefined;
  let enabled = false;
  let closed = false;
  let catalogueError: WebMcpError | undefined;
  let queue = Promise.resolve();
  let dispatching = 0;
  let catalogueRevision = 0;
  let earlyResponseOverflow = false;
  const earlyResponses = new Map<string, JsonObject>();

  function checkOpen(): void {
    if (closed) throw new WebMcpError('WEBMCP_TOOL_STALE', 'The WebMCP target generation is no longer available.', true);
  }

  function cancelNative(invocationId: string): void {
    void options.sendCommand('WebMCP.cancelInvocation', { invocationId }).catch(() => {});
  }

  function invalidate(): void {
    document = undefined;
    catalogueRevision += 1;
    earlyResponses.clear();
    earlyResponseOverflow = false;
    tools.clear();
    references.clear();
    referencesByName.clear();
    catalogueError = undefined;
    for (const [invocationId, invocation] of pending) {
      invocation.reject(new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'The document changed before the tool result was received. Do not replay the invocation.'));
      cancelNative(invocationId);
    }
    pending.clear();
  }

  async function serialize(operation: () => Promise<void>): Promise<void> {
    const result = queue.catch(() => {}).then(operation);
    queue = result;
    return result;
  }

  async function readDocument(): Promise<{ frameId: string; loaderId: string; url: string }> {
    const result = await options.sendCommand('Page.getFrameTree');
    checkOpen();
    const frame = objectValue(objectValue(result.frameTree)?.frame);
    if (typeof frame?.id !== 'string' || typeof frame.loaderId !== 'string' || typeof frame.url !== 'string')
      throw new WebMcpError('WEBMCP_DISCOVERY_FAILED', 'The main document could not be identified.');
    return { frameId: frame.id, loaderId: frame.loaderId, url: frame.url };
  }

  async function prepare(): Promise<void> {
    checkOpen();
    const current = await readDocument();
    if (document?.frameId !== current.frameId || document.loaderId !== current.loaderId) {
      invalidate();
      if (enabled) {
        await options.sendCommand('WebMCP.disable');
        enabled = false;
        checkOpen();
      }
      document = { ...current, reference: crypto.randomUUID() };
    } else {
      document = { ...document, url: current.url };
    }
    if (enabled) return;
    tools.clear();
    catalogueError = undefined;
    const selectedDocument = document.reference;
    try {
      await options.sendCommand('WebMCP.enable');
    } catch (error) {
      throw new WebMcpError('FEATURE_UNSUPPORTED', `Native WebMCP is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    enabled = true;
    checkOpen();
    if (document?.reference !== selectedDocument)
      throw new WebMcpError('WEBMCP_TOOL_STALE', 'The main document changed during WebMCP discovery.', true);
    for (const [reference, entry] of references) {
      if (tools.has(entry.name)) continue;
      references.delete(reference);
      referencesByName.delete(entry.name);
    }
  }

  function checkDocument(reference: string): MainDocument {
    checkOpen();
    if (document?.reference !== reference) throw new WebMcpError('WEBMCP_TOOL_STALE', 'The main document changed. List its WebMCP tools again.', true);
    return document;
  }

  async function verifyDocument(reference: string): Promise<void> {
    const selected = checkDocument(reference);
    const current = await readDocument();
    if (selected.frameId !== current.frameId || selected.loaderId !== current.loaderId) invalidate();
    checkDocument(reference);
  }

  function pageContext(selected: MainDocument): WebMcpPageContext {
    return { targetId: options.target.id, targetGeneration: options.target.generation, url: selected.url };
  }

  function describe(name: string, value: JsonObject, selected: MainDocument): WebMcpTool {
    let toolRef = referencesByName.get(name);
    if (toolRef === undefined) {
      toolRef = crypto.randomUUID();
      referencesByName.set(name, toolRef);
      references.set(toolRef, { document: selected.reference, name });
    }
    const inputSchema = objectValue(value.inputSchema);
    const annotations = objectValue(value.annotations);
    return {
      name,
      description: typeof value.description === 'string' ? value.description : '',
      toolRef,
      ...(inputSchema === undefined ? {} : { inputSchema: structuredClone(inputSchema) }),
      ...(annotations === undefined ? {} : { annotations: structuredClone(annotations) }),
    };
  }

  async function list(selected: MainDocument, signal: AbortSignal): Promise<JsonObject> {
    const revision = catalogueRevision;
    if (catalogueError !== undefined) throw catalogueError;
    const policy = options.policy?.discovery;
    let visible: WebMcpTool[] = [];
    let discoveryEnabled: boolean;
    try {
      discoveryEnabled = typeof policy?.enabled === 'function' ? await policy.enabled(pageContext(selected)) : policy?.enabled ?? true;
      signal.throwIfAborted();
      if (discoveryEnabled) {
        for (const [name, value] of [...tools].sort(([left], [right]) => left.localeCompare(right))) {
          signal.throwIfAborted();
          const tool = describe(name, value, selected);
          const context = { ...pageContext(selected), tool };
          if (policy?.include !== undefined && !await matchesAny(policy.include, context)) continue;
          if (policy?.exclude !== undefined && await matchesAny(policy.exclude, context)) continue;
          signal.throwIfAborted();
          visible.push(tool);
        }
      }
    } catch (error) {
      visible = [];
      throw new WebMcpError('WEBMCP_DISCOVERY_FAILED', `WebMCP discovery policy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await verifyDocument(selected.reference);
    if (revision !== catalogueRevision) throw new WebMcpError('WEBMCP_TOOL_STALE', 'The tool catalogue changed during discovery. List tools again.', true);
    return { documentRef: selected.reference, enabled: discoveryEnabled, tools: visible.map(tool => ({ ...tool })) };
  }

  async function invoke(parameters: JsonObject | undefined, selected: MainDocument, signal: AbortSignal): Promise<JsonObject> {
    const toolName = parameters?.toolName;
    const toolRef = parameters?.toolRef;
    const input = objectValue(parameters?.input);
    if (input === undefined || (toolName !== undefined && typeof toolName !== 'string') || (toolRef !== undefined && typeof toolRef !== 'string') || (typeof toolName === 'string') === (typeof toolRef === 'string') || Object.keys(parameters ?? {}).some(key => !['input', 'toolName', 'toolRef'].includes(key)))
      throw new WebMcpError('CDP_COMMAND_FAILED', 'Provide an input object and exactly one toolName or toolRef.');
    const reference = typeof toolRef === 'string' ? references.get(toolRef) : undefined;
    if (typeof toolRef === 'string' && reference?.document !== selected.reference)
      throw new WebMcpError('WEBMCP_TOOL_STALE', 'The WebMCP tool reference is stale. List tools again.', true);
    const name = typeof toolName === 'string' ? toolName : reference?.name;
    if (name === undefined || name.length === 0) throw new WebMcpError('CDP_COMMAND_FAILED', 'A nonempty WebMCP tool name is required.');
    await verifyDocument(selected.reference);
    signal.throwIfAborted();
    dispatching += 1;
    let response: JsonObject;
    try {
      const nativeResponse = options.sendCommand('WebMCP.invokeTool', { frameId: selected.frameId, toolName: name, input });
      void nativeResponse.then((value) => {
        if ((closed || signal.aborted || document?.reference !== selected.reference) && typeof value.invocationId === 'string') cancelNative(value.invocationId);
      }).catch(() => {});
      response = await untilAborted(nativeResponse, signal, new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'The invocation was interrupted after dispatch. Do not replay it.'));
    } catch (error) {
      if (error instanceof WebMcpError) throw error;
      throw new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'Chrome did not return a reliable invocation acknowledgement. Do not replay it.');
    } finally {
      dispatching -= 1;
    }
    const invocationId = response.invocationId;
    if (typeof invocationId !== 'string') throw new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'Chrome accepted the invocation without a usable invocation identifier. Do not replay it.');
    if (closed || signal.aborted || document?.reference !== selected.reference) {
      cancelNative(invocationId);
      throw new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'The invocation was interrupted after dispatch. Do not replay it.');
    }
    if (earlyResponseOverflow) {
      cancelNative(invocationId);
      if (dispatching === 0) {
        earlyResponseOverflow = false;
        earlyResponses.clear();
      }
      throw new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'Native tool completion exceeded the result buffer. Do not replay the invocation.');
    }
    const result = Promise.withResolvers<JsonObject>();
    pending.set(invocationId, result);
    const earlyResponse = earlyResponses.get(invocationId);
    earlyResponses.delete(invocationId);
    if (dispatching === 0) earlyResponses.clear();
    if (earlyResponse !== undefined) settleInvocation(earlyResponse);
    const abort = (): void => {
      cancelNative(invocationId);
      result.reject(new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'Cancellation was requested after tool dispatch; its side effects may already have occurred.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const value = await result.promise;
      try {
        await verifyDocument(selected.reference);
      } catch {
        throw new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'The document changed before the tool result could be verified. Do not replay it.');
      }
      if (signal.aborted) throw new WebMcpError('WEBMCP_OUTCOME_UNKNOWN', 'The invocation was interrupted after dispatch. Do not replay it.');
      return value;
    } finally {
      pending.delete(invocationId);
      signal.removeEventListener('abort', abort);
    }
  }

  function settleInvocation(parameters: JsonObject): void {
    if (typeof parameters.invocationId !== 'string') return;
    const invocation = pending.get(parameters.invocationId);
    if (invocation === undefined) return;
    if (parameters.status === 'Completed') {
      invocation.resolve({ status: 'completed', ...(parameters.output === undefined ? {} : { output: parameters.output }) });
      return;
    }
    if (parameters.status === 'Canceled') {
      invocation.reject(new WebMcpError('REQUEST_CANCELLED', 'Chrome cancelled the WebMCP invocation.'));
      return;
    }
    invocation.reject(new WebMcpError('CDP_COMMAND_FAILED', typeof parameters.errorText === 'string' ? parameters.errorText.slice(0, 1024) : 'The WebMCP tool failed.'));
  }

  return {
    async setActive(active) {
      return serialize(async () => {
        if (active) return prepare();
        if (!enabled) return;
        await options.sendCommand('WebMCP.disable');
        enabled = false;
        tools.clear();
      });
    },
    async execute(method, parameters, signal) {
      const combinedSignal = AbortSignal.any([signal, lifetime.signal]);
      await untilAborted(serialize(prepare), combinedSignal);
      const selected = document;
      if (selected === undefined) throw new WebMcpError('WEBMCP_TOOL_STALE', 'The main document is no longer available.', true);
      if (method === webMcpMethods.list) {
        if (Object.keys(parameters ?? {}).length > 0) throw new WebMcpError('CDP_COMMAND_FAILED', 'WebMCP discovery accepts no frame or additional parameters.');
        return untilAborted(list(selected, combinedSignal), combinedSignal);
      }
      if (method === webMcpMethods.invoke) return invoke(parameters, selected, combinedSignal);
      throw new WebMcpError('FEATURE_UNSUPPORTED', 'Unknown WebMCP bridge operation.');
    },
    event(method, parameters) {
      if (closed) return;
      if (method === 'Page.frameNavigated') {
        const frame = objectValue(parameters.frame);
        if (frame !== undefined && frame.parentId === undefined && (frame.id !== document?.frameId || frame.loaderId !== document?.loaderId)) invalidate();
        return;
      }
      if (method === 'WebMCP.toolsAdded' && Array.isArray(parameters.tools)) {
        for (const candidate of parameters.tools) {
          const tool = objectValue(candidate);
          if (tool === undefined || tool.frameId !== document?.frameId || typeof tool.name !== 'string') continue;
          catalogueRevision += 1;
          tools.set(tool.name, tool);
        }
        if (new TextEncoder().encode(JSON.stringify([...tools.values()])).byteLength > options.maximumResultBytes) {
          tools.clear();
          catalogueError = new WebMcpError('WEBMCP_DISCOVERY_FAILED', 'The native WebMCP catalogue exceeded the configured result size bound.');
        }
      }
      if (method === 'WebMCP.toolsRemoved' && Array.isArray(parameters.tools)) {
        for (const candidate of parameters.tools) {
          const tool = objectValue(candidate);
          if (tool?.frameId !== document?.frameId || typeof tool?.name !== 'string') continue;
          catalogueRevision += 1;
          tools.delete(tool.name);
          const reference = referencesByName.get(tool.name);
          if (reference !== undefined) references.delete(reference);
          referencesByName.delete(tool.name);
        }
      }
      if (method !== 'WebMCP.toolResponded' || typeof parameters.invocationId !== 'string') return;
      if (!pending.has(parameters.invocationId) && dispatching > 0) {
        const size = new TextEncoder().encode(JSON.stringify([...earlyResponses.values(), parameters])).byteLength;
        if (size <= options.maximumResultBytes) earlyResponses.set(parameters.invocationId, parameters);
        else earlyResponseOverflow = true;
        return;
      }
      settleInvocation(parameters);
    },
    async dispose() {
      closed = true;
      invalidate();
      lifetime.abort();
      return serialize(async () => {
        if (!enabled) return;
        enabled = false;
        await options.sendCommand('WebMCP.disable').catch(() => {});
      });
    },
  };
}
