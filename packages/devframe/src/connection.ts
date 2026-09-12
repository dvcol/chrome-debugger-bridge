import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { CdbClient } from './client.js';
import type { BrowserControlPanelClient } from './panel.js';
import type { CdbDevframeClient } from './wire.js';

import { createCdbClient, createCdbClientSession } from './client.js';

export interface CdbConnectionOptions {
  /** Supply only for an agent principal, not a management or provider connection. */
  readonly session?: Parameters<typeof createCdbClientSession>[0];
  readonly onError?: (error: unknown) => void;
}

export interface CdbConnection extends BrowserControlPanelClient {
  readonly status: 'disconnected' | 'connected' | 'disposed';
  readonly current: BrokerState;
  /** Attaching does not wait for CDB or delay the host's connection establishment. */
  attach: (peer: CdbDevframeClient) => void;
  disconnected: () => void;
  ready: () => Promise<CdbClient>;
  invoke: CdbClient['invoke'];
  withCancellation: CdbClient['withCancellation'];
  terminateSession: () => Promise<void>;
  dispose: () => Promise<void>;
}

function emptyState(): BrokerState {
  return { revision: 0, providers: [], principals: [], requests: [], targets: [], grants: [], leases: [], scopes: [] };
}

/** Stop waiting locally; the caller forwards cancellation without replaying the operation. */
async function untilAborted<Result>(pending: Promise<Result>, signal: AbortSignal): Promise<Result> {
  const cancelled = Promise.withResolvers<never>();
  const abort = (): void => cancelled.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([pending, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** One handle per host/principal. It never opens or closes the supplied transport. */
export function createCdbConnection(options: CdbConnectionOptions = {}): CdbConnection {
  const session = options.session === undefined ? undefined : createCdbClientSession(options.session);
  const listeners = new Set<(state: BrokerState) => void>();
  const cleanups = new Set<Promise<void>>();
  let state = emptyState();
  let disposed = false;
  let binding: {
    peer: CdbDevframeClient;
    client: CdbClient;
    lifetime: AbortController;
    ready?: Promise<CdbClient> | undefined;
    watching?: Promise<void> | undefined;
    unsubscribe?: (() => void) | undefined;
  } | undefined;

  function publish(nextState: BrokerState): void {
    state = nextState;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        options.onError?.(error);
      }
    }
  }

  function detach(): void {
    const previous = binding;
    binding = undefined;
    if (previous !== undefined) {
      previous.lifetime.abort(new Error('The CDB connection was replaced or disconnected.'));
      previous.unsubscribe?.();
      const cleanup = previous.client.dispose().catch(error => options.onError?.(error));
      cleanups.add(cleanup);
      void cleanup.finally(() => cleanups.delete(cleanup));
    }
    publish(emptyState());
  }

  async function ready(): Promise<CdbClient> {
    const selected = binding;
    if (disposed || selected === undefined) throw new Error(disposed ? 'The CDB connection is disposed.' : 'Browser control is disconnected.');
    selected.ready ??= (async () => {
      if (session !== undefined) await session.connect(selected.client);
      selected.lifetime.signal.throwIfAborted();
      return selected.client;
    })().catch((error) => {
      selected.ready = undefined;
      throw error;
    });
    return untilAborted(selected.ready, selected.lifetime.signal);
  }

  async function subscribe(): Promise<void> {
    const selected = binding;
    if (selected === undefined || listeners.size === 0) return;
    selected.watching ??= (async () => {
      const client = await ready();
      selected.lifetime.signal.throwIfAborted();
      const stop = await client.watch((nextState) => {
        if (binding === selected && !disposed) publish(nextState);
      });
      if (binding !== selected || disposed || listeners.size === 0) stop();
      else selected.unsubscribe = stop;
    })().catch((error) => {
      selected.watching = undefined;
      if (binding === selected) throw error;
    });
    return selected.watching;
  }

  async function operation<Result>(signal: AbortSignal | undefined, invoke: (client: CdbClient, signal: AbortSignal) => Promise<Result>): Promise<Result> {
    const selected = binding;
    signal?.throwIfAborted();
    if (selected === undefined) throw new Error('Browser control is disconnected.');
    const cancellation = signal === undefined ? selected.lifetime.signal : AbortSignal.any([signal, selected.lifetime.signal]);
    const client = await untilAborted(ready(), cancellation);
    if (binding !== selected) throw new Error('The CDB connection changed before dispatch.');
    cancellation.throwIfAborted();
    const result = await untilAborted(invoke(client, cancellation), cancellation);
    cancellation.throwIfAborted();
    return result;
  }

  return {
    get status() {
      return disposed ? 'disposed' : binding === undefined ? 'disconnected' : 'connected';
    },
    get current() {
      return state;
    },
    attach(peer) {
      if (disposed) throw new Error('The CDB connection is disposed.');
      if (binding?.peer === peer) return;
      detach();
      binding = { peer, client: createCdbClient(peer), lifetime: new AbortController() };
      void subscribe().catch(error => options.onError?.(error));
    },
    disconnected: detach,
    ready,
    async watch(listener) {
      if (disposed) throw new Error('The CDB connection is disposed.');
      listeners.add(listener);
      try {
        listener(state);
        await subscribe();
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && binding !== undefined) {
          binding.unsubscribe?.();
          binding.unsubscribe = undefined;
          binding.watching = undefined;
        }
      };
    },
    snapshot: async () => operation(undefined, async client => client.snapshot()),
    invoke: async (name, input, signal) => operation(signal, async (client, cancellation) => client.invoke(name, input, cancellation)),
    withCancellation: async (signal, invoke) => operation(signal, async (client, cancellation) => client.withCancellation(cancellation, invoke)),
    revokeScope: async requestId => operation(undefined, async client => client.revokeScope(requestId)),
    revokeGrant: async grantId => operation(undefined, async client => client.revokeGrant(grantId)),
    disconnectProvider: async (providerId, forgetPairing) => operation(undefined, async client => client.disconnectProvider(providerId, forgetPairing)),
    async terminateSession() {
      if (binding?.ready === undefined) return;
      const client = await ready();
      if (session !== undefined) await session.terminate(client);
      else await client.terminateSession();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      listeners.clear();
      await Promise.all(cleanups);
    },
  };
}
