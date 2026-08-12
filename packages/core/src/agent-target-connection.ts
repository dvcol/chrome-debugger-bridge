import type { TargetBroker } from './broker.js';
import type { AgentToBrokerMessage, BrokerToAgentMessage, CdpCommand, ConnectionLimits, HeartbeatParameters, JsonObject, Lease, PublishedTarget } from './protocol.js';

export interface AgentTargetConnection {
  readonly closed?: Promise<unknown>;
  close?: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: AgentToBrokerMessage) => void) => () => void;
  send?: (message: BrokerToAgentMessage) => Promise<void>;
}

export interface ConnectAgentTargetBrokerOptions {
  /** Values negotiated with every authenticated agent before it can publish targets. */
  readonly connectionLimits?: ConnectionLimits;
  readonly connectionGeneration?: number;
  readonly features?: readonly string[];
  readonly handshakeTimeoutMilliseconds?: number;
  readonly heartbeat?: HeartbeatParameters;
  readonly implementation?: {
    readonly instanceId: string;
    readonly name: string;
    readonly role: 'broker';
    readonly version: string;
  };
}

const defaultConnectionLimits: ConnectionLimits = {
  maximumArtifactBytes: 16_777_216,
  maximumInlineResultBytes: 65_536,
  maximumMessageBytes: 16_384,
};
const defaultHeartbeat: HeartbeatParameters = { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 };

/** Connects one authenticated agent's opaque target lifecycle, commands, and events to a broker. */
export function connectAgentTargetBroker(
  connection: AgentTargetConnection,
  broker: TargetBroker,
  options: ConnectAgentTargetBrokerOptions = {},
): () => void {
  const connectionGeneration = options.connectionGeneration ?? 1;
  const handshakeTimeoutMilliseconds = options.handshakeTimeoutMilliseconds ?? 5_000;
  const heartbeat = options.heartbeat ?? defaultHeartbeat;
  const connectionLimits = options.connectionLimits ?? defaultConnectionLimits;
  const implementation = options.implementation ?? {
    instanceId: globalThis.crypto.randomUUID(),
    name: 'chrome-debugger-bridge',
    role: 'broker' as const,
    version: '0.0.0',
  };
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

  let handshakeComplete = false;
  let handshakeFailed = false;
  let disconnected = false;
  const handshakeTimeout = setTimeout(() => {
    if (!handshakeComplete) {
      handshakeFailed = true;
      connection.close?.(1008, 'Agent hello timed out');
    }
  }, handshakeTimeoutMilliseconds);

  const disconnect = connection.onMessage((message) => {
    if (handshakeFailed) return;
    if (!handshakeComplete) {
      if (message.kind !== 'request' || message.method !== 'agent.hello') {
        handshakeFailed = true;
        connection.close?.(1008, 'Agent hello required');
        return;
      }
      if (
        message.protocolVersion !== 1
        || message.parameters.connectionGeneration !== connectionGeneration
        || message.parameters.protocolVersions.minimum > 1
        || message.parameters.protocolVersions.maximum < 1
      ) {
        handshakeFailed = true;
        void Promise.resolve(connection.send?.({
          error: { code: 'CAPABILITY_DENIED', message: 'Agent hello negotiation failed.', retryable: false },
          kind: 'error',
          method: 'agent.hello',
          protocolVersion: 1,
          requestId: message.requestId,
        })).finally(() => connection.close?.(1008, 'Agent hello negotiation failed'));
        return;
      }
      handshakeComplete = true;
      clearTimeout(handshakeTimeout);
      void connection.send?.({
        kind: 'response',
        method: 'agent.hello',
        protocolVersion: 1,
        requestId: message.requestId,
        result: {
          broker: implementation,
          connectionGeneration,
          features: [...(options.features ?? [])],
          heartbeat,
          limits: connectionLimits,
          protocolVersion: 1,
        },
      });
      return;
    }
    if (message.kind === 'request' && message.method === 'agent.hello') {
      connection.close?.(1008, 'Agent hello already completed');
      return;
    }
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
  const closeConnection = (): void => {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(handshakeTimeout);
    revokePublishedTargets();
  };
  void connection.closed?.then(closeConnection, closeConnection);
  return () => {
    disconnect();
    closeConnection();
    for (const pendingCommand of pendingCommands.values()) pendingCommand.reject(new Error('The agent connection closed.'));
    pendingCommands.clear();
  };
}
