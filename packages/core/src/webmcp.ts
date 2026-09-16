import type { CdpCommand, CdpCommandResult, JsonObject, JsonValue } from './protocol.js';

/** Address one authorized main document through an existing lease. */
export type WebMcpRequest = Pick<CdpCommand, 'leaseId' | 'operationId' | 'targetGeneration' | 'targetId'>;

export interface WebMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonObject;
  readonly annotations?: JsonObject;
  /** Bound to the target generation and main document, not a grant of authority. */
  readonly toolRef: string;
}

export interface WebMcpToolList {
  readonly documentRef: string;
  readonly enabled: boolean;
  readonly tools: readonly WebMcpTool[];
}

export type WebMcpInvocation = {
  readonly input: JsonObject;
} & (
  | { readonly toolName: string; readonly toolRef?: never }
  | { readonly toolName?: never; readonly toolRef: string }
);

export interface WebMcpToolResult {
  readonly status: 'completed';
  readonly output?: JsonValue;
}

/** Large results use the ordinary artifact envelope and retain the caller's lease. */
export type WebMcpResult<Value> = Omit<CdpCommandResult, 'value'> & {
  readonly value: Value | { readonly artifact: import('./protocol.js').ArtifactDescriptor };
};

export interface WebMcpClient {
  listWebMcpTools: (request: WebMcpRequest) => Promise<WebMcpResult<WebMcpToolList>>;
  /** Invokes one tool. Discovery exclusions do not deny direct invocation by name. */
  invokeWebMcpTools: (request: WebMcpRequest & WebMcpInvocation) => Promise<WebMcpResult<WebMcpToolResult>>;
}

export const webMcpMethods = {
  list: 'Bridge.listWebMcpTools',
  invoke: 'Bridge.invokeWebMcpTools',
} as const;

/** Preserves actionable failures across the extension and broker transport boundaries. */
export class WebMcpError extends Error {
  constructor(
    readonly code: 'FEATURE_UNSUPPORTED' | 'WEBMCP_DISCOVERY_FAILED' | 'WEBMCP_TOOL_STALE' | 'WEBMCP_OUTCOME_UNKNOWN' | 'CDP_COMMAND_FAILED' | 'REQUEST_CANCELLED',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Adds WebMCP calls to an authenticated command transport without creating a connection. */
export function createWebMcpClient(client: { executeCommand: (command: CdpCommand) => Promise<CdpCommandResult> }): WebMcpClient {
  return {
    async listWebMcpTools(request) {
      return client.executeCommand({ ...request, method: webMcpMethods.list }) as Promise<WebMcpResult<WebMcpToolList>>;
    },
    async invokeWebMcpTools(request) {
      const { input, toolName, toolRef, ...authority } = request;
      return client.executeCommand({
        ...authority,
        method: webMcpMethods.invoke,
        parameters: { input, ...(toolName === undefined ? { toolRef } : { toolName }) },
      }) as Promise<WebMcpResult<WebMcpToolResult>>;
    },
  };
}
