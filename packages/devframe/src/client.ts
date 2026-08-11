import type {
  AcquireLeaseRequest,
  ArtifactAccessRequest,
  CdpSubscription,
  ChromeDebuggerBridgeClient,
  ReleaseLeaseRequest,
  RenewLeaseRequest,
  TargetChange,
} from '@dvcol/chrome-debugger-bridge';
import type { CdpCommand, CdpCommandResult, CdpEvent, CdpSubscriptionRequest, Lease, PublishedTarget } from '@dvcol/chrome-debugger-bridge/protocol';
import type { BirpcOptions } from 'birpc';

import { createChromeDebuggerBridgeClient } from '@dvcol/chrome-debugger-bridge';
import { createBirpc } from 'birpc';

export interface DevframeRpcChannel {
  off?: (listener: (message: unknown) => void) => void;
  on: (listener: (message: unknown) => void) => void;
  post: (message: unknown) => void;
}

export interface DevframeSubscriptionDescriptor {
  readonly id: string;
  readonly targetGeneration: number;
  readonly targetId: string;
}

/** The Devframe-only RPC surface called by the browser-side facade. */
export interface DevframeBridgeHostRpc {
  acquireLease: (request: AcquireLeaseRequest) => Promise<Lease>;
  cancelCommand: (request: Pick<CdpCommand, 'operationId' | 'targetGeneration' | 'targetId'>) => Promise<void>;
  executeCommand: (command: CdpCommand) => Promise<CdpCommandResult>;
  listTargets: () => Promise<readonly PublishedTarget[]>;
  readArtifact: (request: ArtifactAccessRequest) => Promise<Uint8Array>;
  releaseArtifact: (request: ArtifactAccessRequest) => Promise<void>;
  releaseLease: (request: ReleaseLeaseRequest) => Promise<void>;
  renewLease: (request: RenewLeaseRequest) => Promise<Lease>;
  startSubscription: (subscriptionId: string) => Promise<void>;
  startTargetWatch: () => Promise<void>;
  stopTargetWatch: () => Promise<void>;
  subscribe: (request: CdpSubscriptionRequest) => Promise<DevframeSubscriptionDescriptor>;
  unsubscribe: (subscriptionId: string) => Promise<void>;
}

/** Stream callbacks kept in the Devframe package rather than the core protocol. */
export interface DevframeBridgeClientRpc {
  cdpEvent: (event: CdpEvent) => void;
  subscriptionClosed: (subscriptionId: string) => void;
  subscriptionOverflow: (input: {
    readonly droppedCount: number;
    readonly lastDeliveredSequence: number;
    readonly subscriptionId: string;
  }) => void;
  targetChange: (change: TargetChange) => void;
}

export interface DevframeChromeDebuggerBridgeClient extends ChromeDebuggerBridgeClient {
  cancelCommand: (request: Pick<CdpCommand, 'operationId' | 'targetGeneration' | 'targetId'>) => Promise<void>;
  dispose: () => void;
}

interface DevframeSubscriptionState {
  readonly events: AsyncQueue<CdpEvent>;
  readonly targetGeneration: number;
  readonly targetId: string;
  closed: boolean;
  droppedCount: number;
  id: string;
  lastDeliveredSequence: number;
  overflowed: boolean;
}

interface AsyncQueue<Value> extends AsyncIterable<Value> {
  close: (error?: Error) => void;
  offer: (value: Value) => void;
}

function createAsyncQueue<Value>(maximumValues: number): AsyncQueue<Value> {
  const values: Value[] = [];
  const receivers: Array<{ readonly reject: (error: Error) => void; readonly resolve: (result: IteratorResult<Value>) => void }> = [];
  let closed = false;
  let terminalError: Error | undefined;
  return {
    close(error) {
      if (closed) return;
      closed = true;
      terminalError = error;
      while (receivers.length > 0) {
        const receiver = receivers.shift();
        if (receiver === undefined) return;
        if (error === undefined) receiver.resolve({ done: true, value: undefined });
        else receiver.reject(error);
      }
    },
    offer(value) {
      if (closed) return;
      const receiver = receivers.shift();
      if (receiver !== undefined) {
        receiver.resolve({ done: false, value });
        return;
      }
      if (values.length >= maximumValues) throw new Error('The Devframe subscription queue overflowed.');
      values.push(value);
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Value>> {
          const value = values.shift();
          if (value !== undefined) return { done: false, value };
          if (terminalError !== undefined) throw terminalError;
          if (closed) return { done: true, value: undefined };
          return new Promise((resolve, reject) => receivers.push({ reject, resolve }));
        },
      };
    },
  };
}

function createBirpcChannelOptions(channel: DevframeRpcChannel): Pick<BirpcOptions, 'off' | 'on' | 'post'> {
  return {
    on(listener: (message: unknown) => void) {
      channel.on(listener);
    },
    ...(channel.off === undefined
      ? {}
      : { off(listener: (message: unknown) => void) {
          channel.off?.(listener);
        } }),
    post(message: unknown) {
      channel.post(message);
    },
  };
}

/** Adapts an isolated Devframe birpc channel to the stable transport-neutral client facade. */
export function createDevframeBridgeClient(channel: DevframeRpcChannel): DevframeChromeDebuggerBridgeClient {
  const subscriptions = new Map<string, DevframeSubscriptionState>();
  const targetChanges = createAsyncQueue<TargetChange>(32);
  let disposed = false;
  let targetWatchStarted: Promise<void> | undefined;
  const rpc = createBirpc<DevframeBridgeHostRpc, DevframeBridgeClientRpc>({
    cdpEvent(event) {
      const subscription = subscriptions.get(event.subscriptionId);
      if (subscription === undefined || subscription.closed) return;
      subscription.lastDeliveredSequence = event.sequence;
      subscription.events.offer(event);
    },
    subscriptionClosed(subscriptionId) {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription === undefined) return;
      subscription.closed = true;
      subscriptions.delete(subscription.id);
      subscription.events.close();
    },
    subscriptionOverflow(input) {
      const subscription = subscriptions.get(input.subscriptionId);
      if (subscription === undefined || subscription.closed) return;
      subscription.droppedCount = input.droppedCount;
      subscription.lastDeliveredSequence = input.lastDeliveredSequence;
      subscription.overflowed = true;
    },
    targetChange(change) {
      targetChanges.offer(change);
    },
  }, createBirpcChannelOptions(channel));

  const facade = createChromeDebuggerBridgeClient({
    async acquireLease(request) {
      return rpc.acquireLease(request);
    },
    async executeCommand(command) {
      return rpc.executeCommand(command);
    },
    async listTargets() {
      return rpc.listTargets();
    },
    async readArtifact(request) {
      return rpc.readArtifact(request);
    },
    async releaseArtifact(request) {
      await rpc.releaseArtifact(request);
    },
    async releaseLease(request) {
      await rpc.releaseLease(request);
    },
    async renewLease(request) {
      return rpc.renewLease(request);
    },
    async subscribe(request) {
      const descriptor = await rpc.subscribe(request);
      const subscription: DevframeSubscriptionState = {
        closed: false,
        droppedCount: 0,
        events: createAsyncQueue(request.buffer.capacity),
        id: descriptor.id,
        lastDeliveredSequence: 0,
        overflowed: false,
        targetGeneration: descriptor.targetGeneration,
        targetId: descriptor.targetId,
      };
      subscriptions.set(subscription.id, subscription);
      try {
        await rpc.startSubscription(subscription.id);
      } catch (error) {
        subscriptions.delete(subscription.id);
        subscription.events.close(error instanceof Error ? error : new Error('Unable to start the Devframe subscription.'));
        throw error;
      }
      return {
        close() {
          if (subscription.closed) return;
          subscription.closed = true;
          subscriptions.delete(subscription.id);
          subscription.events.close();
          void rpc.unsubscribe(subscription.id).catch(() => {});
        },
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
        targetGeneration: subscription.targetGeneration,
        targetId: subscription.targetId,
        [Symbol.asyncIterator]() {
          return subscription.events[Symbol.asyncIterator]();
        },
      } satisfies CdpSubscription;
    },
    watchTargets() {
      if (targetWatchStarted === undefined) {
        targetWatchStarted = rpc.startTargetWatch().catch((error: unknown) => {
          targetChanges.close(error instanceof Error ? error : new Error('Unable to start target watching.'));
          throw error;
        });
      }
      return targetChanges;
    },
  });

  return {
    ...facade,
    async cancelCommand(request) {
      await rpc.cancelCommand(request);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      targetChanges.close();
      for (const subscription of subscriptions.values()) {
        subscription.closed = true;
        subscription.events.close();
        void rpc.unsubscribe(subscription.id).catch(() => {});
      }
      subscriptions.clear();
      void rpc.stopTargetWatch().catch(() => {});
      rpc.$close();
    },
  };
}
