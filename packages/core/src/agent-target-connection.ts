import type { TargetBroker } from './broker.js';
import type { AgentToBrokerMessage } from './protocol.js';

export interface AgentTargetConnection {
  onMessage: (listener: (message: AgentToBrokerMessage) => void) => () => void;
}

/** Applies agent target lifecycle notifications to the broker's current publication set. */
export function connectAgentTargetBroker(connection: AgentTargetConnection, broker: TargetBroker): () => void {
  return connection.onMessage((message) => {
    if (message.kind !== 'notification') return;
    if (message.method === 'targets.publish') broker.publishTarget(message.parameters.target);
    else if (message.method === 'targets.reconcile') broker.reconcileTargets(message.parameters.targets);
    else if (message.method === 'targets.revoke') broker.revokeTarget(message.parameters.targetId, message.parameters.targetGeneration, message.parameters.reason);
    else if (message.method === 'targets.update') broker.updateTarget(message.parameters.target);
  });
}
