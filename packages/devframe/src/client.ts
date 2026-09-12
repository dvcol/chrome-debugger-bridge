import type { BrokerToAgentMessage, CredentialStore, JsonValue, LogicalSessionCredential } from '@dvcol/cdb';
import type { BrokerState, ProviderAuthenticationResult, ProviderRegistration } from '@dvcol/cdb-broker/contract';
import type { IndexedDbPairingStore, ProviderConnection, StoredBrokerPairing } from '@dvcol/cdb-extension';

import type { CdbDevframeClient, CdbProviderClosure, CdbProviderFrame, CdbReply } from './wire.js';

import { createMemoryCredentialStore } from '@dvcol/cdb';
import {
  createAgentAuthenticationProof,
  decodeBase64UrlBytes,
  generateRandomBase64Url,
  importAgentCredential,
  verifyBrokerAuthenticationProof,
} from '@dvcol/cdb/authentication';

import { cdbServiceScope } from './wire.js';

export interface ConnectCdbProviderOptions {
  readonly registration: ProviderRegistration;
  /** Preserve the existing key when moving an installation to another transport. */
  readonly pairingStore: IndexedDbPairingStore;
  readonly pairingKey: string;
  readonly confirmPairing: (brokerId: string) => boolean | Promise<boolean>;
}

export interface CdbClient {
  watch: (listener: (state: BrokerState) => void) => Promise<() => void>;
  snapshot: () => Promise<BrokerState>;
  revokeScope: (requestId: string) => Promise<void>;
  revokeGrant: (grantId: string) => Promise<boolean>;
  disconnectProvider: (providerId: string, forgetPairing?: boolean) => Promise<boolean>;
  connectSession: (input?: { readonly metadata?: JsonValue; readonly resume?: { readonly credential: string; readonly logicalSessionId: string } }) => Promise<LogicalSessionCredential>;
  terminateSession: () => Promise<boolean>;
  invoke: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** Routes cancellation for a browser call registered in the embedding host's catalogue. */
  withCancellation: <Result>(signal: AbortSignal | undefined, invoke: (operationId: string) => Promise<Result>) => Promise<Result>;
  connectProvider: (options: ConnectCdbProviderOptions) => Promise<ProviderConnection>;
  disconnected: () => void;
  dispose: () => Promise<void>;
}

const clients = new WeakMap<object, CdbClient>();

export interface CdbClientSession {
  connect: (client: CdbClient) => Promise<void>;
  terminate: (client: CdbClient) => Promise<void>;
}

/** Retains and rotates one principal's resume credential; hosts forward connection lifecycle events. */
export function createCdbClientSession(options: {
  readonly credentialKey: string;
  readonly credentialStore?: CredentialStore;
  readonly metadata?: JsonValue;
}): CdbClientSession {
  const store = options.credentialStore ?? createMemoryCredentialStore();
  const input = options.metadata === undefined ? {} : { metadata: options.metadata };
  let pending = Promise.resolve();
  return {
    async connect(client) {
      const operation = pending.catch(() => {}).then(async () => {
        const resume = await store.get(options.credentialKey);
        let connected: LogicalSessionCredential;
        try {
          connected = await client.connectSession({ ...input, ...(resume === undefined ? {} : { resume }) });
        } catch (error) {
          if (resume === undefined || !(error instanceof Error) || !('code' in error)
            || (error.code !== 'SESSION_NOT_FOUND' && error.code !== 'SESSION_EXPIRED')) throw error;
          await store.delete(options.credentialKey);
          connected = await client.connectSession(input);
        }
        await store.set(options.credentialKey, { credential: connected.resumeCredential, logicalSessionId: connected.logicalSessionId });
      });
      pending = operation;
      return operation;
    },
    async terminate(client) {
      await pending;
      await client.terminateSession();
      await store.delete(options.credentialKey);
    },
  };
}

/** Uses the supplied Devframe peer. It neither creates nor closes a socket or another RPC client. */
export function createCdbClient(client: CdbDevframeClient): CdbClient {
  const existing = clients.get(client);
  if (existing !== undefined) return existing;
  const rpc = client.scope(cdbServiceScope).rpc;
  const stateListeners = new Set<(state: BrokerState) => void>();
  let provider: { readonly channelId: string; close: (code?: number, reason?: string) => void; receive: (message: BrokerToAgentMessage) => void } | undefined;
  let disposed = false;
  let watching: Promise<BrokerState> | undefined;
  let state: BrokerState | undefined;

  async function call<Value>(name: string, ...arguments_: unknown[]): Promise<Value> {
    if (disposed) throw new Error('The CDB client has been disposed.');
    const result = await rpc.call(name, ...arguments_) as CdbReply<Value>;
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.value;
  }

  function publish(value: BrokerState): void {
    if (disposed || (state !== undefined && value.revision < state.revision)) return;
    state = value;
    for (const listener of stateListeners) listener(value);
  }

  rpc.register({ name: 'state-changed', type: 'event', handler: publish });
  rpc.register({ name: 'provider-frame', type: 'event', handler(envelope: CdbProviderFrame) {
    if (!disposed && provider?.channelId === envelope.channelId) provider.receive(envelope.message);
  } });
  rpc.register({ name: 'provider-closed', type: 'event', handler(closure: CdbProviderClosure) {
    if (!disposed && provider?.channelId === closure.channelId) provider.close(closure.code, closure.reason);
  } });

  async function watch(listener: (state: BrokerState) => void): Promise<() => void> {
    watching ??= call<BrokerState>('watch').then((value) => {
      publish(value);
      return value;
    }).catch((error) => {
      watching = undefined;
      throw error;
    });
    const initial = await watching;
    if (disposed) throw new Error('The CDB client has been disposed.');
    stateListeners.add(listener);
    listener(state ?? initial);
    return () => {
      stateListeners.delete(listener);
    };
  }

  const handle: CdbClient = {
    watch,
    snapshot: async () => call<BrokerState>('state'),
    revokeScope: async (requestId: string) => call<void>('revoke-scope', requestId),
    revokeGrant: async (grantId: string) => call<boolean>('revoke-grant', grantId),
    disconnectProvider: async (providerId: string, forgetPairing = false) => call<boolean>('disconnect-provider', providerId, forgetPairing),
    connectSession: async (input = {}) => call<LogicalSessionCredential>('session-connect', input),
    terminateSession: async () => call<boolean>('session-terminate'),
    async invoke(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
      return handle.withCancellation(signal, async operationId => call('invoke', { operationId, name, arguments: input }));
    },
    async withCancellation(signal, invoke) {
      signal?.throwIfAborted();
      const operationId = crypto.randomUUID();
      const cancel = (): void => {
        rpc.callEvent('cancel', operationId);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await invoke(operationId);
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    async connectProvider(options: ConnectCdbProviderOptions): Promise<ProviderConnection> {
      const { brokerId } = await call<{ readonly brokerId: string }>('provider-register', options.registration);
      let pairing = await options.pairingStore.load(options.pairingKey);
      pairing ??= await options.pairingStore.findByIdentity?.(brokerId, options.registration.instanceId);
      if (pairing !== undefined && (pairing.brokerId !== brokerId || pairing.agentId !== options.registration.instanceId))
        throw new Error('The broker or provider identity changed. Explicitly forget the old pairing before pairing again.');
      let invitation: { readonly code: string; readonly credential: string } | undefined;
      if (pairing === undefined) {
        if (!await options.confirmPairing(brokerId)) throw new Error('Broker pairing was declined.');
        const offer = await call<{ readonly code: string }>('provider-pair');
        const credential = generateRandomBase64Url(32);
        invitation = { code: offer.code, credential };
        pairing = { brokerId, agentId: options.registration.instanceId, credentialId: crypto.randomUUID(), endpoint: options.pairingKey, key: await importAgentCredential(decodeBase64UrlBytes(credential)) } satisfies StoredBrokerPairing;
      }
      const clientNonce = generateRandomBase64Url(32);
      const transcript = await call<import('@dvcol/cdb/authentication').AgentAuthenticationTranscript>('provider-challenge', { credentialId: pairing.credentialId, clientNonce, ...(invitation === undefined ? {} : { pairing: invitation }) });
      if (transcript.brokerId !== brokerId || transcript.agentId !== pairing.agentId || transcript.credentialId !== pairing.credentialId || transcript.clientNonce !== clientNonce || transcript.transportProtocol !== 'chrome-debugger-bridge.rpc.v1')
        throw new Error('The broker authentication challenge is not bound to this provider.');
      const result = await call<ProviderAuthenticationResult & { readonly channelId: string }>('provider-authenticate', await createAgentAuthenticationProof(pairing.key, transcript));
      try {
        if (disposed || result.claims.principalId !== pairing.agentId || !await verifyBrokerAuthenticationProof(pairing.key, transcript, result.claims, result.proof))
          throw new Error('The broker authentication proof is invalid or the client was disposed.');
        if (invitation !== undefined) await options.pairingStore.save(pairing);
      } catch (error) {
        rpc.callEvent('provider-close', result.channelId);
        throw error;
      }
      provider?.close(4000, 'Provider connection replaced');
      const closed = Promise.withResolvers<{ readonly code: number; readonly reason: string }>();
      const listeners = new Set<(message: BrokerToAgentMessage) => void>();
      let active = true;
      const channel = {
        channelId: result.channelId,
        close(this: void, code = 1000, reason = 'Provider channel closed') {
          if (!active) return;
          active = false;
          listeners.clear();
          closed.resolve({ code, reason });
          if (!disposed) rpc.callEvent('provider-close', result.channelId);
        },
        receive(message: BrokerToAgentMessage) {
          if (active) for (const listener of listeners) listener(message);
        },
      };
      provider = channel;
      async function providerCall<Value>(name: string, ...arguments_: unknown[]): Promise<Value> {
        if (!active) throw new Error('The provider channel is closed.');
        return call<Value>(name, ...arguments_);
      }
      return {
        brokerId,
        registration: options.registration,
        generation: result.claims.connectionGeneration,
        closed: closed.promise,
        close: channel.close,
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async send(message) {
          if (!active) throw new Error('The provider channel is closed.');
          await call('provider-frame', { channelId: channel.channelId, message });
        },
        snapshot: async () => providerCall<BrokerState>('state'),
        claim: async requestId => providerCall('provider-claim', requestId),
        release: async claim => providerCall('provider-release', claim),
        approve: async (claim, targets) => providerCall('provider-approve', claim, targets),
        reconcile: async targets => providerCall('provider-reconcile', targets),
        reconcileScope: async (requestId, targets) => providerCall('provider-scope', requestId, targets),
        revokeScope: async requestId => providerCall('revoke-scope', requestId),
        watch,
      };
    },
    /** The embedding host calls this for transport loss. A later reconnect reuses this client context. */
    disconnected() {
      provider?.close(1006, 'Devframe connection lost');
      watching = undefined;
      state = undefined;
    },
    async dispose() {
      if (disposed) return;
      provider?.close(1000, 'CDB client disposed');
      try {
        if (watching !== undefined) await call('unwatch');
      } finally {
        disposed = true;
        stateListeners.clear();
        watching = undefined;
        state = undefined;
      }
    },
  };
  clients.set(client, handle);
  return handle;
}
