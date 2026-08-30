import type {
  CdpSubscription,
  ClientAuthority,
  TargetBroker,
  TargetChange,
} from '@dvcol/cdb';
import type {
  AgentAuthenticationAdapter,
  AuthenticatedClientConnection,
  AuthenticatedPrincipal,
  ClientAuthenticationAdapter,
  MountAuthenticatedWebSocketBridgeOptions,
  WebSocketBridgeLimits,
  WebSocketBridgeTimingPolicy,
} from '@dvcol/cdb-websocket/node';
import type { CreateTargetBrokerOptions } from '@dvcol/cdb/broker';
import type { BirpcOptions } from 'birpc';
import type { Server as HttpServer } from 'node:http';

import type {
  BirpcBridgeClientRpc,
  BirpcBridgeHostRpc,
  BirpcRpcChannel,
  BirpcSubscriptionDescriptor,
} from './client.js';

import { connectAgentTargetBroker, connectClientTargetBroker, createTargetBroker } from '@dvcol/cdb';
import { mountAuthenticatedWebSocketBridge } from '@dvcol/cdb-websocket/node';
import { createBirpc } from 'birpc';

export interface MountBirpcChromeDebuggerBridgeOptions<
  AgentPrincipal extends AuthenticatedPrincipal,
  ClientPrincipal extends AuthenticatedPrincipal,
> extends CreateTargetBrokerOptions {
  readonly agentAuthentication: AgentAuthenticationAdapter<AgentPrincipal>;
  readonly agentPath: string;
  readonly broker?: TargetBroker;
  readonly brokerId: string;
  readonly channel: BirpcRpcChannel;
  /** Explicit authority for the application-owned Birpc channel. */
  readonly channelAuthority: ClientAuthority;
  readonly clientAuthentication: ClientAuthenticationAdapter<ClientPrincipal>;
  readonly clientPath: string;
  readonly originPolicy: MountAuthenticatedWebSocketBridgeOptions<AgentPrincipal, ClientPrincipal>['originPolicy'];
  readonly resolveClientAuthority?: (connection: AuthenticatedClientConnection<ClientPrincipal>) => ClientAuthority;
  readonly server: HttpServer;
  readonly webSocketLimits?: WebSocketBridgeLimits;
  readonly webSocketTiming?: Partial<WebSocketBridgeTimingPolicy>;
}

export interface MountedBirpcChromeDebuggerBridge {
  readonly broker: TargetBroker;
  diagnostics: () => BirpcBridgeDiagnostics;
  dispose: () => Promise<void>;
}

/** Reports only Birpc mount lifecycle state, never connection details or broker payloads. */
export interface BirpcBridgeDiagnostics {
  readonly disposed: boolean;
  readonly ownsBroker: boolean;
  readonly subscriptionCount: number;
  readonly watchingTargets: boolean;
}

interface BirpcSubscriptionState {
  readonly subscription: CdpSubscription;
  streaming: boolean;
}

function createBirpcChannelOptions(channel: BirpcRpcChannel): Pick<BirpcOptions, 'off' | 'on' | 'post'> {
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

/** Mounts broker transports onto an application-owned HTTP server without taking its listener lifecycle. */
export function mountBirpcChromeDebuggerBridge<
  AgentPrincipal extends AuthenticatedPrincipal,
  ClientPrincipal extends AuthenticatedPrincipal,
>(options: MountBirpcChromeDebuggerBridgeOptions<AgentPrincipal, ClientPrincipal>): MountedBirpcChromeDebuggerBridge {
  const broker = options.broker ?? createTargetBroker(options);
  const ownsBroker = options.broker === undefined;
  const subscriptions = new Map<string, BirpcSubscriptionState>();
  const channelAuthority = options.channelAuthority;
  broker.connectClient(channelAuthority);
  let targetWatch: AsyncIterator<TargetChange> | undefined;
  let disposed = false;

  const ensureActive = (): void => {
    if (disposed) throw new Error('The Birpc bridge is disposed.');
  };

  const rpc = createBirpc<BirpcBridgeClientRpc, BirpcBridgeHostRpc>({
    async acquireLease(request) {
      ensureActive();
      return broker.acquireLease(request, channelAuthority);
    },
    async cancelCommand(request) {
      ensureActive();
      broker.cancelCommand(request.operationId, channelAuthority);
    },
    async executeCommand(command) {
      ensureActive();
      return broker.executeCommand(command, channelAuthority);
    },
    async listTargets() {
      ensureActive();
      return broker.listTargets(channelAuthority);
    },
    async readArtifact(request) {
      ensureActive();
      return broker.readArtifact(request, channelAuthority);
    },
    async releaseArtifact(request) {
      ensureActive();
      broker.releaseArtifact(request, channelAuthority);
    },
    async releaseLease(request) {
      ensureActive();
      broker.releaseLease(request, channelAuthority);
    },
    async renewLease(request) {
      ensureActive();
      return broker.renewLease(request, channelAuthority);
    },
    async startSubscription(subscriptionId) {
      ensureActive();
      const state = subscriptions.get(subscriptionId);
      if (state === undefined) throw new Error('The Birpc subscription does not exist.');
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
      targetWatch = broker.watchTargets(channelAuthority)[Symbol.asyncIterator]();
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
    async subscribe(request): Promise<BirpcSubscriptionDescriptor> {
      ensureActive();
      const subscription = await broker.subscribe(request, channelAuthority);
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
    ...(options.webSocketTiming === undefined ? {} : { timing: options.webSocketTiming }),
    onAgentConnection(connection) {
      connectAgentTargetBroker(connection.connection, broker, {
        authority: {
          connectionGeneration: connection.connectionGeneration,
          principalId: connection.principal.id,
        },
        connectionGeneration: connection.connectionGeneration,
      });
    },
    onClientConnection(connection) {
      const authority = options.resolveClientAuthority?.(connection) ?? {
        connectionId: connection.connectionId,
        principalId: connection.principal.id,
        targetGrants: [],
      };
      if (authority.connectionId !== connection.connectionId || authority.principalId !== connection.principal.id) {
        connection.connection.close(1008, 'Client authority identity mismatch');
        return;
      }
      connectClientTargetBroker(connection.connection, broker, authority);
    },
    originPolicy: options.originPolicy,
    server: options.server,
  });

  return {
    broker,
    diagnostics() {
      return {
        disposed,
        ownsBroker,
        subscriptionCount: subscriptions.size,
        watchingTargets: targetWatch !== undefined,
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      rpc.$close();
      await targetWatch?.return?.();
      targetWatch = undefined;
      for (const state of subscriptions.values()) state.subscription.close();
      subscriptions.clear();
      broker.disconnectClient(channelAuthority);
      await mountedWebSocketBridge.close();
      if (ownsBroker) broker.dispose();
    },
  };
}
