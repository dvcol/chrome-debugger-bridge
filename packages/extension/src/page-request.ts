export interface PageRequestBridgeOptions {
  /** Window receiving responses; the target may be its containing page. */
  readonly receiver: Window;
  readonly target: Window;
  readonly targetOrigin: string;
  readonly correlationKey?: string;
  readonly timeoutMilliseconds?: number;
}

export interface PageRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
}

export interface PageRequestBridge {
  request: (type: string, responseType: string, payload?: object, options?: PageRequestOptions) => Promise<Readonly<Record<string, unknown>>>;
  dispose: () => void;
}

/** Correlation and acknowledgement are transport mechanics, never proof of trusted human approval. */
export function createPageRequestBridge(options: PageRequestBridgeOptions): PageRequestBridge {
  const correlationKey = options.correlationKey ?? 'requestId';
  const lifetime = new AbortController();
  return {
    async request(type, responseType, payload = {}, requestOptions = {}) {
      const signal = requestOptions.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, requestOptions.signal]);
      signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      const response = Promise.withResolvers<Readonly<Record<string, unknown>>>();
      const abort = (): void => response.reject(signal.reason);
      const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== options.target || (options.targetOrigin !== '*' && event.origin !== options.targetOrigin)) return;
        const message = record(event.data);
        const result = record(message?.payload);
        if (message?.type !== responseType || result?.[correlationKey] !== requestId) return;
        response.resolve(result);
      };
      const timeout = options.receiver.setTimeout(() => response.reject(new Error(`The page request ${type} timed out.`)), requestOptions.timeoutMilliseconds ?? options.timeoutMilliseconds ?? 5_000);
      options.receiver.addEventListener('message', receive);
      signal.addEventListener('abort', abort, { once: true });
      try {
        options.target.postMessage({ type, payload: { ...payload, [correlationKey]: requestId } }, options.targetOrigin);
        return await response.promise;
      } finally {
        options.receiver.clearTimeout(timeout);
        options.receiver.removeEventListener('message', receive);
        signal.removeEventListener('abort', abort);
      }
    },
    dispose() {
      lifetime.abort(new Error('The page request bridge was disposed.'));
    },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
