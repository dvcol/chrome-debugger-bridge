import type { TargetBroker } from './broker.js';
import type { AgentToBrokerMessage, BrokerToAgentMessage, CdpCommand, JsonObject, Lease, PublishedTarget } from './protocol.js';

export interface AgentTargetConnection {
  readonly closed?: Promise<unknown>;
  onMessage: (listener: (message: AgentToBrokerMessage) => void) => () => void;
  send?: (message: BrokerToAgentMessage) => Promise<void>;
}

/** Connects one authenticated agent's opaque target lifecycle, commands, and events to a broker. */
export function connectAgentTargetBroker(connection: AgentTargetConnection, broker: TargetBroker): () => void {
  const publishedTargets = new Map<string, PublishedTarget>();
  const pendingCommands = new Map<string, {
    readonly reject: (reason: Error) => void;
    readonly resolve: (value: JsonObject) => void;
  }>();

  async function executeCommand(command: CdpCommand, abortSignal: AbortSignal, _lease: Lease): Promise<JsonObject> {
    if (connection.send === undefined) throw new Error('The agent connection cannot execute debugger commands.');
    const requestId = globalThis.crypto.randomUUID();
    const commandResult = new Promise<JsonObject>((resolve, reject) => {
      pendingCommands.set(requestId, { reject, resolve });
    });
    const cancelCommand = (): void => {
      pendingCommands.get(requestId)?.reject(new Error('The debugger command was cancelled.'));
      pendingCommands.delete(requestId);
      void connection.send?.({ kind: 'notification', method: 'cdp.cancel', parameters: { operationId: command.operationId, targetGeneration: command.targetGeneration, targetId: command.targetId }, protocolVersion: 1 });
    };
    abortSignal.addEventListener('abort', cancelCommand, { once: true });
    try {
      await connection.send({ kind: 'request', method: 'cdp.execute', parameters: { command, lease: _lease }, protocolVersion: 1, requestId });
      return await commandResult;
    } finally {
      abortSignal.removeEventListener('abort', cancelCommand);
      pendingCommands.delete(requestId);
    }
  }

  const disconnect = connection.onMessage((message) => {
    if (message.kind === 'response' && message.method === 'cdp.execute') {
      pendingCommands.get(message.requestId)?.resolve(message.result.value);
      return;
    }
    if (message.kind === 'error' && message.method === 'cdp.execute') {
      pendingCommands.get(message.requestId)?.reject(new Error(message.error.message));
      return;
    }
    if (message.kind !== 'notification') return;
    if (message.method === 'targets.publish') {
      broker.publishTarget(message.parameters.target);
      publishedTargets.set(message.parameters.target.id, message.parameters.target);
      if (connection.send !== undefined) {
        const target = message.parameters.target;
        broker.registerTargetExecutor(target, {
          execute: executeCommand,
          async setSubscriptionDemand(methodPrefix, active, sessionId) {
            await connection.send?.({
              kind: 'notification',
              method: 'cdp.subscription-demand',
              parameters: { active, methodPrefix, ...(sessionId === undefined ? {} : { sessionId }), targetGeneration: target.generation, targetId: target.id },
              protocolVersion: 1,
            });
          },
        });
      }
    } else if (message.method === 'targets.reconcile') {
      broker.reconcileTargets(message.parameters.targets);
      publishedTargets.clear();
      for (const target of message.parameters.targets) publishedTargets.set(target.id, target);
    } else if (message.method === 'targets.revoke') {
      broker.revokeTarget(message.parameters.targetId, message.parameters.targetGeneration, message.parameters.reason);
      publishedTargets.delete(message.parameters.targetId);
    } else if (message.method === 'targets.update') {
      broker.updateTarget(message.parameters.target);
      publishedTargets.set(message.parameters.target.id, message.parameters.target);
    } else if (message.method === 'cdp.event') broker.publishEvent(
      { generation: message.parameters.targetGeneration, id: message.parameters.targetId },
      message.parameters.method,
      message.parameters.parameters,
      message.parameters.sessionId,
    );
  });
  const revokePublishedTargets = (): void => {
    for (const target of publishedTargets.values()) broker.revokeTarget(target.id, target.generation, 'detached');
    publishedTargets.clear();
  };
  void connection.closed?.then(revokePublishedTargets, revokePublishedTargets);
  return () => {
    disconnect();
    revokePublishedTargets();
    for (const pendingCommand of pendingCommands.values()) pendingCommand.reject(new Error('The agent connection closed.'));
    pendingCommands.clear();
  };
}
