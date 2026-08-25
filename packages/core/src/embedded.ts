import type { ArtifactStore } from './artifact-store.js';
import type { AcquireLeaseRequest, ArtifactAccessRequest, CdpSubscription, CreateTargetBrokerOptions, ReleaseLeaseRequest, RenewLeaseRequest, TargetBroker, TargetCommandExecutor } from './broker.js';
import type { ChromeDebuggerBridgeClient, TargetDirectory } from './client.js';
import type { CdpCommand, CdpSubscriptionRequest, JsonObject, Lease, PublishedTarget } from './protocol.js';

import { createTargetBroker, TargetBrokerError } from './broker.js';
import { createChromeDebuggerBridgeClient, createClientFacadeAdapter } from './client.js';

/** Applies host-specific authorization in addition to the broker's mandatory capability checks. */
export interface EmbeddedAuthorizationAdapter {
  authorize: (command: CdpCommand, lease: Lease) => boolean | Promise<boolean>;
}

export interface CreateEmbeddedChromeDebuggerBridgeOptions extends CreateTargetBrokerOptions {
  readonly artifactStore?: ArtifactStore;
  readonly authorization?: EmbeddedAuthorizationAdapter;
}

export interface EmbeddedChromeDebuggerBridgeClient extends ChromeDebuggerBridgeClient {
  /** Cancels pending client work and releases all client-owned iterators. */
  dispose: () => void;
}

export interface EmbeddedChromeDebuggerBridge {
  readonly broker: TargetBroker;
  readonly client: EmbeddedChromeDebuggerBridgeClient;
  dispose: () => void;
  registerTargetExecutor: (target: Pick<PublishedTarget, 'generation' | 'id'>, executor: TargetCommandExecutor) => void;
}

interface DisposableIterator<Value> extends AsyncIterator<Value> {
  return?: () => Promise<IteratorResult<Value>>;
}

interface WrappedAsyncIterable<Value> extends AsyncIterable<Value> {
  close: () => void;
}

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

/**
 * Embeds the broker and public client facade in one process. Calls cross a cloning
 * boundary so host adapters cannot share mutable protocol values with broker state.
 */
export function createEmbeddedChromeDebuggerBridge(options: CreateEmbeddedChromeDebuggerBridgeOptions = {}): EmbeddedChromeDebuggerBridge {
  const broker = createTargetBroker(options);
  const pendingOperationRejectors = new Set<(error: Error) => void>();
  const closeClientResources = new Set<() => void>();
  let disposed = false;

  function ensureActive(): void {
    if (disposed) throw new Error('The embedded bridge is disposed.');
  }

  async function invoke<Value>(operation: () => Value | Promise<Value>, rejectWhenDisposed = true): Promise<Value> {
    ensureActive();
    if (!rejectWhenDisposed) return copy(await operation());
    let rejectDisposed: (error: Error) => void;
    const disposedPromise = new Promise<never>((_resolve, reject) => rejectDisposed = reject);
    pendingOperationRejectors.add(rejectDisposed!);
    try {
      return await Promise.race([
        (async () => copy(await operation()))(),
        disposedPromise,
      ]);
    } finally {
      pendingOperationRejectors.delete(rejectDisposed!);
    }
  }

  function wrapIterator<Value>(iterator: DisposableIterator<Value>): WrappedAsyncIterable<Value> {
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      closeClientResources.delete(close);
      void iterator.return?.();
    };
    closeClientResources.add(close);
    return {
      close,
      [Symbol.asyncIterator]() {
        return {
          next: async () => invoke(async () => {
            if (closed) return { done: true, value: undefined } as IteratorResult<Value>;
            return iterator.next();
          }, false),
          async return() {
            close();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  function wrapSubscription(subscription: CdpSubscription): CdpSubscription {
    const wrappedEvents = wrapIterator(subscription[Symbol.asyncIterator]());
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      closeClientResources.delete(close);
      wrappedEvents.close();
      subscription.close();
    };
    closeClientResources.add(close);
    return {
      close,
      get droppedCount() {
        return subscription.droppedCount;
      },
      get id() {
        return subscription.id;
      },
      get lastDeliveredSequence() {
        return subscription.lastDeliveredSequence;
      },
      get overflowed() {
        return subscription.overflowed;
      },
      get targetGeneration() {
        return subscription.targetGeneration;
      },
      get targetId() {
        return subscription.targetId;
      },
      [Symbol.asyncIterator]() {
        return wrappedEvents[Symbol.asyncIterator]();
      },
    };
  }

  const directory: TargetDirectory = {
    acquireLease: async (request: AcquireLeaseRequest) => invoke(() => broker.acquireLease(copy(request))),
    executeCommand: async (command: CdpCommand) => invoke(async () => broker.executeCommand(copy(command))),
    listTargets: async () => invoke(() => broker.listTargets()),
    readArtifact: async (request: ArtifactAccessRequest) => invoke(() => broker.readArtifact(copy(request))),
    releaseArtifact: async (request: ArtifactAccessRequest) => invoke(() => broker.releaseArtifact(copy(request))),
    releaseLease: async (request: ReleaseLeaseRequest) => invoke(() => broker.releaseLease(copy(request))),
    renewLease: async (request: RenewLeaseRequest) => invoke(() => broker.renewLease(copy(request))),
    subscribe: async (request: CdpSubscriptionRequest) => wrapSubscription(await invoke(async () => broker.subscribe(copy(request)))),
    watchTargets: () => wrapIterator(broker.watchTargets()[Symbol.asyncIterator]()),
  };
  const client = {
    ...createChromeDebuggerBridgeClient(createClientFacadeAdapter(directory)),
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error('The embedded bridge is disposed.');
      for (const reject of pendingOperationRejectors) reject(error);
      pendingOperationRejectors.clear();
      for (const close of closeClientResources) close();
      closeClientResources.clear();
    },
  } satisfies EmbeddedChromeDebuggerBridgeClient;

  return {
    broker,
    client,
    dispose() {
      client.dispose();
      broker.dispose();
    },
    registerTargetExecutor(target, executor) {
      ensureActive();
      broker.registerTargetExecutor(target, {
        ...executor,
        async execute(command, abortSignal, lease): Promise<JsonObject> {
          if (options.authorization !== undefined && !await options.authorization.authorize(copy(command), copy(lease))) {
            throw new TargetBrokerError('CAPABILITY_DENIED');
          }
          return executor.execute(command, abortSignal, lease);
        },
      });
    },
  };
}
