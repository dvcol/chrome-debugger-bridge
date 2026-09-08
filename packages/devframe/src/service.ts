import type { AgentToBrokerMessage, JsonValue } from '@dvcol/cdb';
import type { BrokerDefinition, BrokerPeer, BrokerRuntime, ProviderAuthenticationInput, ProviderRegistration, ProviderTarget } from '@dvcol/cdb-broker';
import type { GrantRequestClaim } from '@dvcol/cdb-broker/contract';
import type { DevframeNodeRpcSession, DevframeRpcConnection, DevframeScopedNodeContext, DevframeServiceDefinition } from 'devframe';

import { Buffer } from 'node:buffer';

import { agentToBrokerMessageSchema } from '@dvcol/cdb';
import { BrokerError, createBroker } from '@dvcol/cdb-broker';

import packageManifest from '../package.json' with { type: 'json' };
import { cdbServiceScope } from './wire.js';

export interface CdbDevframePeerSession {
  readonly meta: Omit<DevframeNodeRpcSession['meta'], 'peer'>;
  readonly rpc: Pick<DevframeNodeRpcSession['rpc'], '$callEvent'>;
}

/** Gets the installed service without exposing the host context's transport types. */
export function getCdbService(context: { readonly services: { get: (id: string) => unknown } }): CdbDevframeService {
  const service = context.services.get('@dvcol/cdb-devframe');
  if (service === undefined) throw new Error('Install createCdbService in this Devframe context first.');
  return service as CdbDevframeService;
}

export interface CdbServiceOptions {
  readonly broker?: BrokerDefinition;
  /** Adds host policy after Devframe authenticates the peer. */
  readonly authorizePeer?: (session: CdbDevframePeerSession, operation: string) => boolean;
  readonly peerMetadata?: (session: CdbDevframePeerSession) => { readonly label?: string; readonly metadata?: JsonValue };
}

export interface CdbDevframeService {
  readonly broker: BrokerRuntime;
  /** Invokes a browser contribution selected by the embedding host's existing catalogue. */
  invoke: (session: CdbDevframePeerSession, input: CdbInvocation) => Promise<unknown>;
  dispose: () => Promise<void>;
  onPeerConnect: (connection: Pick<DevframeRpcConnection, 'id'>, session: CdbDevframePeerSession) => void;
  onPeerDisconnect: (connection: Pick<DevframeRpcConnection, 'id'>) => Promise<void>;
}

export interface CdbInvocation {
  readonly operationId: string;
  readonly name: string;
  readonly arguments: unknown;
}

declare module 'devframe' {
  interface DevframeServicesRegistry {
    '@dvcol/cdb-devframe': CdbDevframeService;
  }
}

declare module 'devframe/types' {
  interface DevframeServicesRegistry {
    '@dvcol/cdb-devframe': CdbDevframeService;
  }
}

/** Install once for the Devframe context. The host forwards peer lifecycle and explicitly disposes it. */
export function createCdbService(options: CdbServiceOptions = {}): DevframeServiceDefinition<CdbDevframeService> {
  return {
    package: '@dvcol/cdb-devframe',
    version: packageManifest.version,
    scope: cdbServiceScope,
    async setup(context) {
      const broker = await createBroker(options.broker);
      try {
        return installBroker(context, broker, options);
      } catch (error) {
        await broker.dispose();
        throw error;
      }
    },
  };
}

function installBroker(context: DevframeScopedNodeContext, broker: BrokerRuntime, options: CdbServiceOptions): CdbDevframeService {
  const peers = new Map<number, CdbDevframePeerSession>();
  const channels = new Map<number, {
    readonly id: string;
    close: (code?: number, reason?: string) => void;
    receive: (message: unknown) => Promise<void>;
  }>();
  const subscriptions = new Map<number, () => void>();
  const operations = new Map<number, Map<string, AbortController>>();
  let disposed = false;

  function authorized(session: CdbDevframePeerSession, operation: string): BrokerPeer {
    if (disposed || session.meta.isTrusted !== true || peers.get(session.meta.id)?.rpc !== session.rpc || options.authorizePeer?.(session, operation) === false)
      throw new BrokerError('ACCESS_DENIED', 'An active authenticated Devframe peer is required for this browser operation.');
    return { ...options.peerMetadata?.(session), id: String(session.meta.id) };
  }

  function register<Arguments extends unknown[], Result>(name: string, handler: (peer: BrokerPeer, session: CdbDevframePeerSession, ...arguments_: Arguments) => Result | Promise<Result>): void {
    context.rpc.register({
      name,
      type: 'action',
      jsonSerializable: true,
      handler: async (...arguments_: Arguments) => {
        const session = context.rpc.getCurrentRpcSession();
        if (session === undefined) throw new BrokerError('ACCESS_DENIED', 'Browser RPC requires its actual peer session.');
        try {
          return { ok: true, value: await handler(authorized(session, name), session, ...arguments_) };
        } catch (error) {
          const failure = error instanceof Error ? error as Partial<BrokerError> : {};
          return { ok: false, error: { code: failure.code ?? 'CDB_OPERATION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: failure.retryable ?? false, ...(failure.details === undefined ? {} : { details: failure.details }), ...(failure.retryAfterMilliseconds === undefined ? {} : { retryAfterMilliseconds: failure.retryAfterMilliseconds }) } };
        }
      },
    });
  }

  register('provider-register', (peer, _session, input: ProviderRegistration) => broker.registerProvider(peer, input));
  register('provider-pair', peer => broker.createPairingOffer(peer));
  register('provider-challenge', (peer, _session, input: ProviderAuthenticationInput) => broker.beginProviderAuthentication(peer, input));
  register('provider-authenticate', async (peer, session, proof: string) => {
    const listeners = new Set<(message: AgentToBrokerMessage) => void>();
    const closed = Promise.withResolvers<void>();
    let active = true;
    const id = crypto.randomUUID();
    const channel = {
      id,
      close(this: void, code = 1000, reason = 'CDB channel closed') {
        if (!active) return;
        active = false;
        listeners.clear();
        closed.resolve();
        void session.rpc.$callEvent(`${cdbServiceScope}:provider-closed`, { channelId: id, code, reason }).catch(() => {});
      },
      async receive(value: unknown) {
        if (!active) throw new BrokerError('ACCESS_DENIED', 'The provider channel was closed.');
        if (Buffer.byteLength(JSON.stringify(value) ?? '') > (options.broker?.maximumProviderMessageBytes ?? 64 * 1_024 * 1_024))
          throw new BrokerError('MESSAGE_TOO_LARGE', 'The provider message exceeds the configured CDB limit.');
        const result = await agentToBrokerMessageSchema['~standard'].validate(value);
        if (result.issues !== undefined) throw new BrokerError('ACCESS_DENIED', 'Invalid provider protocol message.');
        if (!active) throw new BrokerError('ACCESS_DENIED', 'The provider channel was replaced.');
        for (const listener of listeners) listener(result.value);
      },
    };
    try {
      const result = await broker.authenticateProvider(peer, proof, {
        closed: closed.promise,
        close: channel.close,
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async send(message) {
          if (!active) throw new BrokerError('PROVIDER_RECOVERING', 'The provider channel was closed.', true);
          await session.rpc.$callEvent(`${cdbServiceScope}:provider-frame`, { channelId: id, message });
        },
      });
      authorized(session, 'provider-authenticate');
      channels.get(session.meta.id)?.close(4000, 'CDB channel replaced');
      channels.set(session.meta.id, channel);
      return { ...result, channelId: id };
    } catch (error) {
      channel.close();
      throw error;
    }
  });
  register('provider-frame', async (_peer, session, envelope: { readonly channelId: string; readonly message: unknown }) => {
    const channel = channels.get(session.meta.id);
    if (channel === undefined || channel.id !== envelope.channelId) throw new BrokerError('ACCESS_DENIED', 'The provider channel belongs to another connection.');
    await channel.receive(envelope.message);
  });
  register('provider-close', (_peer, session, channelId: string) => {
    const channel = channels.get(session.meta.id);
    if (channel?.id === channelId) {
      channel.close();
      channels.delete(session.meta.id);
    }
  });
  register('provider-reconcile', async (peer, _session, targets: readonly ProviderTarget[]) => broker.reconcileProvider(peer, targets));
  register('provider-claim', (peer, _session, requestId: string) => broker.claimRequest(peer, requestId));
  register('provider-release', (peer, _session, claim: GrantRequestClaim) => broker.releaseClaim(peer, claim));
  register('provider-approve', async (peer, _session, claim: GrantRequestClaim, targets: readonly ProviderTarget[]) => broker.completeClaim(peer, claim, targets));
  register('provider-scope', async (peer, _session, requestId: string, targets: readonly ProviderTarget[]) => broker.reconcileScope(peer, requestId, targets));
  register('session-connect', async (peer, _session, input: Parameters<BrokerRuntime['connectSession']>[1]) => broker.connectSession(peer, input));
  register('session-terminate', async peer => broker.terminateSession(peer));
  register('state', () => broker.snapshot());
  register('watch', (_peer, session) => {
    subscriptions.get(session.meta.id)?.();
    subscriptions.set(session.meta.id, broker.subscribe((state) => {
      authorized(session, 'watch');
      void session.rpc.$callEvent(`${cdbServiceScope}:state-changed`, state).catch(() => {});
    }));
    return broker.snapshot();
  });
  register('unwatch', (_peer, session) => {
    subscriptions.get(session.meta.id)?.();
    subscriptions.delete(session.meta.id);
  });
  register('revoke-scope', async (_peer, _session, requestId: string) => broker.revokeScope(requestId));
  register('revoke-grant', async (_peer, _session, grantId: string) => broker.revokeGrant(grantId));
  register('disconnect-provider', async (_peer, _session, providerId: string, forgetPairing: boolean = false) => broker.disconnectProvider(providerId, forgetPairing));
  async function invoke(session: CdbDevframePeerSession, input: CdbInvocation): Promise<unknown> {
    const peer = authorized(session, 'invoke');
    let pending = operations.get(session.meta.id);
    if (pending === undefined) {
      pending = new Map();
      operations.set(session.meta.id, pending);
    }
    if (!input.operationId || pending.has(input.operationId)) throw new BrokerError('ACCESS_DENIED', 'A unique operation identifier is required.');
    const controller = new AbortController();
    pending.set(input.operationId, controller);
    try {
      return await broker.invoke(peer, input.name, input.arguments, { signal: controller.signal });
    } finally {
      pending.delete(input.operationId);
      if (pending.size === 0) operations.delete(session.meta.id);
    }
  }
  register('invoke', async (_peer, session, input: CdbInvocation) => invoke(session, input));
  register('cancel', (_peer, session, operationId: string) => {
    operations.get(session.meta.id)?.get(operationId)?.abort(new BrokerError('MCP_ACTION_CANCELLED', 'The browser operation was cancelled.'));
  });

  return {
    broker,
    invoke,
    onPeerConnect(connection, session) {
      if (disposed) throw new BrokerError('GRANT_REVOKED', 'The CDB service was disposed.');
      peers.set(connection.id, session);
    },
    async onPeerDisconnect(connection) {
      peers.delete(connection.id);
      subscriptions.get(connection.id)?.();
      subscriptions.delete(connection.id);
      for (const operation of operations.get(connection.id)?.values() ?? []) operation.abort();
      operations.delete(connection.id);
      channels.get(connection.id)?.close(1006, 'Devframe peer disconnected');
      channels.delete(connection.id);
      await broker.disconnectPeer(String(connection.id));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      for (const pending of operations.values()) for (const operation of pending.values()) operation.abort();
      for (const channel of channels.values()) channel.close(1001, 'CDB service stopped');
      subscriptions.clear();
      operations.clear();
      channels.clear();
      peers.clear();
      await broker.dispose();
    },
  };
}
