import type { CdpSubscription, TargetBroker, TargetBrokerError } from './broker.js';
import type { BrokerToClientMessage, ClientToBrokerMessage } from './protocol.js';

export interface ClientTargetConnection {
  onMessage?: (listener: (message: ClientToBrokerMessage) => void) => () => void;
  send: (message: BrokerToClientMessage) => Promise<void>;
}

/** Streams an initial target snapshot and ordered lifecycle changes to one authenticated client. */
export function connectClientTargetBroker(connection: ClientTargetConnection, broker: TargetBroker): () => void {
  const iterator = broker.watchTargets()[Symbol.asyncIterator]();
  const subscriptions = new Map<string, CdpSubscription>();
  let stopped = false;
  async function sendError(message: Extract<ClientToBrokerMessage, { readonly kind: 'request' }>, error: unknown): Promise<void> {
    const code = error instanceof Error && 'code' in error ? (error as TargetBrokerError).code : 'FEATURE_UNSUPPORTED';
    await connection.send({
      error: {
        code,
        message: 'The requested target operation is not available.',
        retryable: false,
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
          const subscription = await broker.subscribe(message.parameters);
          subscriptions.set(subscription.id, subscription);
          void streamSubscription(subscription).finally(() => subscriptions.delete(subscription.id));
          await connection.send({ kind: 'response', method: 'cdp.subscribe', protocolVersion: 1, requestId: message.requestId, result: { subscriptionId: subscription.id } });
        } else if (message.method === 'cdp.unsubscribe') {
          subscriptions.get(message.parameters.subscriptionId)?.close();
          subscriptions.delete(message.parameters.subscriptionId);
          await connection.send({ kind: 'response', method: 'cdp.unsubscribe', protocolVersion: 1, requestId: message.requestId, result: {} });
        } else if (message.method === 'targets.list') {
          await connection.send({ kind: 'response', method: 'targets.list', protocolVersion: 1, requestId: message.requestId, result: { targets: [...broker.listTargets()] } });
        } else if (message.method === 'leases.acquire') {
          const lease = broker.acquireLease(message.parameters);
          await connection.send({ kind: 'response', method: 'leases.acquire', protocolVersion: 1, requestId: message.requestId, result: { lease } });
        } else if (message.method === 'leases.renew') {
          const lease = broker.renewLease(message.parameters);
          await connection.send({ kind: 'response', method: 'leases.renew', protocolVersion: 1, requestId: message.requestId, result: { lease } });
        } else if (message.method === 'leases.release') {
          broker.releaseLease(message.parameters);
          await connection.send({ kind: 'response', method: 'leases.release', protocolVersion: 1, requestId: message.requestId, result: {} });
        } else if (message.method === 'cdp.send') {
          const result = await broker.executeCommand(message.parameters);
          await connection.send({ kind: 'response', method: 'cdp.send', protocolVersion: 1, requestId: message.requestId, result });
        } else if (message.method === 'cdp.cancel') {
          broker.cancelCommand(message.parameters.operationId);
          await connection.send({ kind: 'response', method: 'cdp.cancel', protocolVersion: 1, requestId: message.requestId, result: {} });
        } else {
          await sendError(message, new Error('Unsupported request'));
        }
      } catch (error) {
        await sendError(message, error);
      }
    })();
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
  })().catch(() => {});
  return () => {
    stopped = true;
    disconnectMessages?.();
    for (const subscription of subscriptions.values()) subscription.close();
    subscriptions.clear();
    void iterator.return?.();
  };
}
