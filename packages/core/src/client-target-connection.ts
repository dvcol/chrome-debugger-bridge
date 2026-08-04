import type { TargetBroker } from './broker.js';
import type { BrokerToClientMessage } from './protocol.js';

export interface ClientTargetConnection {
  send: (message: BrokerToClientMessage) => Promise<void>;
}

/** Streams an initial target snapshot and ordered lifecycle changes to one authenticated client. */
export function connectClientTargetBroker(connection: ClientTargetConnection, broker: TargetBroker): () => void {
  const iterator = broker.watchTargets()[Symbol.asyncIterator]();
  let stopped = false;
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
    void iterator.return?.();
  };
}
