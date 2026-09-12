export class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAfterMilliseconds?: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

export interface BrowserControlError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMilliseconds?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Preserve protocol errors and semantic MCP errors without copying their evolving code catalogue. */
export function normalizeBrowserControlError(error: unknown): BrowserControlError {
  const record = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const retryDelay = record.retryAfterMilliseconds ?? record.retryAfterMs;
  return {
    code: typeof record.code === 'string' ? record.code : 'CDB_OPERATION_FAILED',
    message: typeof record.message === 'string' ? record.message : String(error),
    retryable: typeof record.retryable === 'boolean' ? record.retryable : false,
    ...(typeof retryDelay === 'number' ? { retryAfterMilliseconds: retryDelay } : {}),
    ...(record.details !== null && typeof record.details === 'object' && !Array.isArray(record.details) ? { details: record.details as Record<string, unknown> } : {}),
  };
}

/** Returns a semantic failure only for an MCP error result; successful observations are never parsed as errors. */
export function browserControlToolError(result: unknown): BrowserControlError | undefined {
  if (result === null || typeof result !== 'object' || !('isError' in result) || result.isError !== true) return undefined;
  if ('content' in result && Array.isArray(result.content)) {
    for (const content of result.content as unknown[]) {
      if (content === null || typeof content !== 'object' || !('type' in content) || content.type !== 'text' || !('text' in content) || typeof content.text !== 'string') continue;
      try {
        const payload: unknown = JSON.parse(content.text);
        if (payload !== null && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string') return normalizeBrowserControlError(payload);
      } catch {
        /** Text-only MCP failures do not contain a structured protocol error. */
      }
    }
  }
  return normalizeBrowserControlError(new Error('The browser tool failed.'));
}
