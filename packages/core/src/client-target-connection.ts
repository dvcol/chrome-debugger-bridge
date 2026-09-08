import type { AuthorityRecord, AuthorityStore } from './authority.js';
import type { CdpSubscription, ClientAuthority, TargetBroker } from './broker.js';
import type { BrokerToClientMessage, ClientToBrokerMessage } from './protocol.js';

import { TargetBrokerError } from './broker.js';
import { scheduleTimeout } from './timing.js';

export interface ClientTargetConnection {
  onMessage?: (listener: (message: ClientToBrokerMessage) => void) => () => void;
  send: (message: BrokerToClientMessage) => Promise<void>;
}

export interface StoreBackedClientTargetConnectionOptions {
  readonly authorityStore: AuthorityStore;
  readonly connectionId: string;
  readonly displayName?: string;
  readonly logicalSessionId: string;
  readonly now?: () => number;
}

function authorityStoreError(): TargetBrokerError {
  return new TargetBrokerError('CAPABILITY_DENIED', {
    details: { reason: 'authority-store-unavailable' },
    message: 'The authority store is temporarily unavailable.',
    retryable: true,
  });
}

function assertConnectedRecord(
  record: AuthorityRecord | undefined,
  options: StoreBackedClientTargetConnectionOptions,
): AuthorityRecord {
  if (record === undefined) throw authorityStoreError();
  if (record.activeConnectionId !== options.connectionId) {
    throw new TargetBrokerError('CAPABILITY_DENIED', {
      details: { reason: 'logical-session-fenced' },
      message: 'The logical session connection was fenced.',
      retryable: false,
    });
  }
  return record;
}

/** Connects one client using a live AuthorityStore record instead of a captured grant snapshot. */
export async function connectStoreBackedClientTargetBroker(
  connection: ClientTargetConnection,
  broker: TargetBroker,
  options: StoreBackedClientTargetConnectionOptions,
): Promise<() => void> {
  let available = true;
  let record: AuthorityRecord;
  try {
    record = assertConnectedRecord(await options.authorityStore.get(options.logicalSessionId), options);
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw authorityStoreError();
  }
  const principalId = record.principalId;
  const now = options.now ?? Date.now;
  let bindingExpiryTimeout: ReturnType<typeof setTimeout> | undefined;
  const activeBindings = (): AuthorityRecord['bindings'] => record.bindings.filter(binding => (
    binding.expiresAt === undefined
    || binding.expiresAt === null
    || Date.parse(binding.expiresAt) > now()
  ));
  const authority: ClientAuthority = {
    get authorityAvailable() {
      return available;
    },
    connectionId: options.connectionId,
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    logicalSessionId: options.logicalSessionId,
    principalId,
    get targetGrants() {
      return activeBindings().map(binding => ({
        bindingId: binding.bindingId,
        capabilities: binding.capabilities,
        targetGeneration: binding.targetGeneration,
        targetId: binding.targetId,
      }));
    },
  };
  let disposed = false;
  let refresh = Promise.resolve();
  const scheduleBindingExpiry = (): void => {
    if (bindingExpiryTimeout !== undefined) clearTimeout(bindingExpiryTimeout);
    bindingExpiryTimeout = undefined;
    const nextExpiry = activeBindings().reduce<number | undefined>((next, binding) => {
      if (binding.expiresAt === undefined || binding.expiresAt === null) return next;
      const expiration = Date.parse(binding.expiresAt);
      return next === undefined || expiration < next ? expiration : next;
    }, undefined);
    if (nextExpiry === undefined) return;
    bindingExpiryTimeout = scheduleTimeout(() => {
      bindingExpiryTimeout = undefined;
      broker.refreshClientAuthority(authority);
      scheduleBindingExpiry();
    }, Math.max(0, nextExpiry - now()));
  };
  const unsubscribe = options.authorityStore.subscribe((change) => {
    if (change.logicalSessionId !== options.logicalSessionId || disposed) return;
    refresh = refresh.then(async () => {
      try {
        const nextRecord = assertConnectedRecord(
          await options.authorityStore.get(options.logicalSessionId),
          options,
        );
        if (nextRecord.principalId !== principalId) throw authorityStoreError();
        record = nextRecord;
        available = true;
      } catch {
        record = { ...record, bindings: [] };
        available = false;
      }
      broker.refreshClientAuthority(authority);
      scheduleBindingExpiry();
    });
  });
  const disconnect = connectClientTargetBroker(connection, broker, authority);
  scheduleBindingExpiry();
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (bindingExpiryTimeout !== undefined) clearTimeout(bindingExpiryTimeout);
    disconnect();
  };
}

/** Streams an initial target snapshot and ordered lifecycle changes to one authenticated client. */
export function connectClientTargetBroker(connection: ClientTargetConnection, broker: TargetBroker, authority: ClientAuthority = { connectionId: 'local', principalId: 'local' }): () => void {
  broker.connectClient(authority);
  const iterator = broker.watchTargets(authority)[Symbol.asyncIterator]();
  const subscriptions = new Map<string, CdpSubscription>();
  let stopped = false;
  async function sendError(message: Extract<ClientToBrokerMessage, { readonly kind: 'request' }>, error: unknown): Promise<void> {
    if (stopped) return;
    const targetBrokerError = error instanceof Error && 'code' in error ? error as TargetBrokerError : undefined;
    const code = targetBrokerError?.code ?? 'FEATURE_UNSUPPORTED';
    await connection.send({
      error: {
        code,
        ...(targetBrokerError?.details === undefined ? {} : { details: targetBrokerError.details }),
        message: targetBrokerError?.message ?? 'The requested target operation is not available.',
        ...(targetBrokerError?.retryAfterMs === undefined ? {} : { retryAfterMs: targetBrokerError.retryAfterMs }),
        retryable: targetBrokerError?.retryable ?? false,
      },
      kind: 'error',
      method: message.method,
      protocolVersion: 1,
      requestId: message.requestId,
    });
  }
  async function streamSubscription(subscription: CdpSubscription): Promise<void> {
    let reportedDroppedCount = 0;
    async function reportOverflow(): Promise<void> {
      if (subscription.droppedCount === reportedDroppedCount) return;
      reportedDroppedCount = subscription.droppedCount;
      await connection.send({ kind: 'notification', method: 'subscriptions.overflow', parameters: { droppedCount: subscription.droppedCount, lastDeliveredSequence: subscription.lastDeliveredSequence, subscriptionId: subscription.id, targetGeneration: subscription.targetGeneration, targetId: subscription.targetId }, protocolVersion: 1 });
    }
    try {
      for await (const event of subscription) {
        if (stopped) return;
        await connection.send({ kind: 'notification', method: 'cdp.event', parameters: event, protocolVersion: 1 });
        await reportOverflow();
      }
    } catch {
      subscription.close();
    } finally {
      if (!stopped) await reportOverflow();
    }
  }
  const disconnectMessages = connection.onMessage?.((message) => {
    if (message.kind !== 'request' || stopped) return;
    void (async () => {
      try {
        if (message.method === 'cdp.subscribe') {
          const subscription = await broker.subscribe(message.parameters, authority);
          subscriptions.set(subscription.id, subscription);
          void streamSubscription(subscription).finally(() => subscriptions.delete(subscription.id)).catch(disconnect);
          await connection.send({ kind: 'response', method: 'cdp.subscribe', protocolVersion: 1, requestId: message.requestId, result: { subscriptionId: subscription.id } });
        } else if (message.method === 'cdp.unsubscribe') {
          subscriptions.get(message.parameters.subscriptionId)?.close();
          subscriptions.delete(message.parameters.subscriptionId);
          await connection.send({ kind: 'response', method: 'cdp.unsubscribe', protocolVersion: 1, requestId: message.requestId, result: {} });
        } else if (message.method === 'targets.list') {
          await connection.send({ kind: 'response', method: 'targets.list', protocolVersion: 1, requestId: message.requestId, result: { targets: [...broker.listTargets(authority)] } });
        } else if (message.method === 'leases.acquire') {
          const lease = broker.acquireLease(message.parameters, authority);
          await connection.send({ kind: 'response', method: 'leases.acquire', protocolVersion: 1, requestId: message.requestId, result: { lease } });
        } else if (message.method === 'leases.renew') {
          const lease = broker.renewLease(message.parameters, authority);
          await connection.send({ kind: 'response', method: 'leases.renew', protocolVersion: 1, requestId: message.requestId, result: { lease } });
        } else if (message.method === 'leases.release') {
          broker.releaseLease(message.parameters, authority);
          await connection.send({ kind: 'response', method: 'leases.release', protocolVersion: 1, requestId: message.requestId, result: {} });
        } else if (message.method === 'cdp.send') {
          const result = await broker.executeCommand(message.parameters, authority);
          await connection.send({ kind: 'response', method: 'cdp.send', protocolVersion: 1, requestId: message.requestId, result });
        } else if (message.method === 'cdp.cancel') {
          broker.cancelCommand(message.parameters.operationId, authority);
          await connection.send({ kind: 'response', method: 'cdp.cancel', protocolVersion: 1, requestId: message.requestId, result: {} });
        } else {
          await sendError(message, new Error('Unsupported request'));
        }
      } catch (error) {
        await sendError(message, error);
      }
    })().catch(disconnect);
  });
  void (async () => {
    while (true) {
      const result = await iterator.next();
      if (result.done || stopped) return;
      const change = result.value;
      if (change.kind === 'snapshot') {
        await connection.send({ kind: 'notification', method: 'targets.snapshot', parameters: { sequence: change.sequence, targets: [...change.targets] }, protocolVersion: 1 });
      } else if (change.kind === 'published') {
        await connection.send({ kind: 'notification', method: 'targets.published', parameters: { target: change.target }, protocolVersion: 1 });
      } else if (change.kind === 'updated') {
        await connection.send({ kind: 'notification', method: 'targets.updated', parameters: { target: change.target }, protocolVersion: 1 });
      } else {
        await connection.send({ kind: 'notification', method: 'targets.revoked', parameters: { reason: change.reason, targetGeneration: change.targetGeneration, targetId: change.targetId }, protocolVersion: 1 });
      }
    }
  })().catch(disconnect);
  return disconnect;

  function disconnect(): void {
    if (stopped) return;
    stopped = true;
    disconnectMessages?.();
    for (const subscription of subscriptions.values()) subscription.close();
    subscriptions.clear();
    broker.disconnectClient(authority);
    void iterator.return?.();
  }
}
