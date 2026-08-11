import type {
  CdpSubscription,
  TargetBroker,
  TargetChange,
} from '@dvcol/chrome-debugger-bridge';
import type {
  AgentAuthenticationAdapter,
  AuthenticatedPrincipal,
  ClientAuthenticationAdapter,
  MountAuthenticatedWebSocketBridgeOptions,
  WebSocketBridgeLimits,
} from '@dvcol/chrome-debugger-bridge-websocket/node';
import type { CreateTargetBrokerOptions } from '@dvcol/chrome-debugger-bridge/broker';
import type { BirpcOptions } from 'birpc';
import type { Server as HttpServer } from 'node:http';

import type {
  DevframeBridgeClientRpc,
  DevframeBridgeHostRpc,
  DevframeRpcChannel,
  DevframeSubscriptionDescriptor,
} from './client.js';

import { connectAgentTargetBroker, connectClientTargetBroker, createTargetBroker } from '@dvcol/chrome-debugger-bridge';
import { mountAuthenticatedWebSocketBridge } from '@dvcol/chrome-debugger-bridge-websocket/node';
import { createBirpc } from 'birpc';

export interface MountDevframeChromeDebuggerBridgeOptions<
  AgentPrincipal extends AuthenticatedPrincipal,
  ClientPrincipal extends AuthenticatedPrincipal,
> extends CreateTargetBrokerOptions {
  readonly agentAuthentication: AgentAuthenticationAdapter<AgentPrincipal>;
  readonly agentPath: string;
  readonly broker?: TargetBroker;
  readonly brokerId: string;
  readonly channel: DevframeRpcChannel;
  readonly clientAuthentication: ClientAuthenticationAdapter<ClientPrincipal>;
  readonly clientPath: string;
  readonly originPolicy: MountAuthenticatedWebSocketBridgeOptions<AgentPrincipal, ClientPrincipal>['originPolicy'];
  readonly server: HttpServer;
  readonly webSocketLimits?: WebSocketBridgeLimits;
}

export interface MountedDevframeChromeDebuggerBridge {
  readonly broker: TargetBroker;
  dispose: () => Promise<void>;
}

interface DevframeSubscriptionState {
  readonly subscription: CdpSubscription;
  streaming: boolean;
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

/** Mounts broker transports onto an existing Vite or Devframe server without taking its listener lifecycle. */
export function mountDevframeChromeDebuggerBridge<
  AgentPrincipal extends AuthenticatedPrincipal,
  ClientPrincipal extends AuthenticatedPrincipal,
>(options: MountDevframeChromeDebuggerBridgeOptions<AgentPrincipal, ClientPrincipal>): MountedDevframeChromeDebuggerBridge {
  const broker = options.broker ?? createTargetBroker(options);
  const ownsBroker = options.broker === undefined;
  const subscriptions = new Map<string, DevframeSubscriptionState>();
  let targetWatch: AsyncIterator<TargetChange> | undefined;
  let disposed = false;

  const ensureActive = (): void => {
    if (disposed) throw new Error('The Devframe bridge is disposed.');
  };

  const rpc = createBirpc<DevframeBridgeClientRpc, DevframeBridgeHostRpc>({
    async acquireLease(request) {
      ensureActive();
      return broker.acquireLease(request);
    },
    async cancelCommand(request) {
      ensureActive();
      broker.cancelCommand(request.operationId);
    },
    async executeCommand(command) {
      ensureActive();
      return broker.executeCommand(command);
    },
    async listTargets() {
      ensureActive();
      return broker.listTargets();
    },
    async readArtifact(request) {
      ensureActive();
      return broker.readArtifact(request);
    },
    async releaseArtifact(request) {
      ensureActive();
      broker.releaseArtifact(request);
    },
    async releaseLease(request) {
      ensureActive();
      broker.releaseLease(request);
    },
    async renewLease(request) {
      ensureActive();
      return broker.renewLease(request);
    },
    async startSubscription(subscriptionId) {
      ensureActive();
      const state = subscriptions.get(subscriptionId);
      if (state === undefined) throw new Error('The Devframe subscription does not exist.');
      if (state.streaming) return;
      state.streaming = true;
      void (async () => {
        let reportedDroppedCount = 0;
        try {
          for await (const event of state.subscription) {
            if (disposed) return;
            await rpc.cdpEvent.asEvent(event);
            if (state.subscription.droppedCount === reportedDroppedCount) continue;
            reportedDroppedCount = state.subscription.droppedCount;
            await rpc.subscriptionOverflow.asEvent({
              droppedCount: state.subscription.droppedCount,
              lastDeliveredSequence: state.subscription.lastDeliveredSequence,
              subscriptionId,
            });
          }
        } finally {
          subscriptions.delete(subscriptionId);
          state.subscription.close();
          await rpc.subscriptionClosed.asEvent(subscriptionId).catch(() => {});
        }
      })();
    },
    async startTargetWatch() {
      ensureActive();
      if (targetWatch !== undefined) return;
      targetWatch = broker.watchTargets()[Symbol.asyncIterator]();
      void (async () => {
        try {
          while (true) {
            if (disposed) return;
            const next = await targetWatch?.next();
            if (next === undefined || next.done) return;
            await rpc.targetChange.asEvent(next.value);
          }
        } finally {
          targetWatch = undefined;
        }
      })();
    },
    async stopTargetWatch() {
      await targetWatch?.return?.();
      targetWatch = undefined;
    },
    async subscribe(request): Promise<DevframeSubscriptionDescriptor> {
      ensureActive();
      const subscription = await broker.subscribe(request);
      subscriptions.set(subscription.id, { streaming: false, subscription });
      return {
        id: subscription.id,
        targetGeneration: subscription.targetGeneration,
        targetId: subscription.targetId,
      };
    },
    async unsubscribe(subscriptionId) {
      const state = subscriptions.get(subscriptionId);
      subscriptions.delete(subscriptionId);
      state?.subscription.close();
    },
  }, createBirpcChannelOptions(options.channel));

  const mountedWebSocketBridge = mountAuthenticatedWebSocketBridge({
    agentAuthentication: options.agentAuthentication,
    agentPath: options.agentPath,
    brokerId: options.brokerId,
    clientAuthentication: options.clientAuthentication,
    clientPath: options.clientPath,
    ...(options.webSocketLimits === undefined ? {} : { limits: options.webSocketLimits }),
    onAgentConnection(connection) {
      connectAgentTargetBroker(connection.connection, broker);
    },
    onClientConnection(connection) {
      connectClientTargetBroker(connection.connection, broker);
    },
    originPolicy: options.originPolicy,
    server: options.server,
  });

  return {
    broker,
    async dispose() {
      if (disposed) return;
      disposed = true;
      rpc.$close();
      await targetWatch?.return?.();
      targetWatch = undefined;
      for (const state of subscriptions.values()) state.subscription.close();
      subscriptions.clear();
      await mountedWebSocketBridge.close();
      if (ownsBroker) broker.dispose();
    },
  };
}
