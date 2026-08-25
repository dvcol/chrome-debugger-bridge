import type { AgentToBrokerMessage, BrokerToAgentMessage } from '@dvcol/cdb/protocol';

/** The minimum authenticated transport operations needed for an agent heartbeat. */
export interface HeartbeatAgentConnection {
  close: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: BrokerToAgentMessage) => void) => () => void;
  send: (message: AgentToBrokerMessage) => Promise<void>;
}

/** Sends a generation-bound control heartbeat and rejects if the broker does not acknowledge it in time. */
export async function sendAgentHeartbeat(
  connection: HeartbeatAgentConnection,
  connectionGeneration: number,
  timeoutMilliseconds: number,
): Promise<void> {
  const requestId = globalThis.crypto.randomUUID();
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  await new Promise<void>((resolve, reject) => {
    const removeListener = connection.onMessage((message) => {
      if (message.kind !== 'response' || message.method !== 'agent.heartbeat' || message.requestId !== requestId) return;
      removeListener();
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      if (message.protocolVersion !== 1 || message.result.connectionGeneration !== connectionGeneration) {
        reject(new Error('The broker heartbeat response is invalid.'));
        return;
      }
      resolve();
    });
    timeout = globalThis.setTimeout(() => {
      removeListener();
      reject(new Error('The broker heartbeat timed out.'));
    }, timeoutMilliseconds);
    void connection.send({
      kind: 'request',
      method: 'agent.heartbeat',
      parameters: { connectionGeneration },
      protocolVersion: 1,
      requestId,
    }).catch((error: unknown) => {
      removeListener();
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error('The agent heartbeat could not be sent.'));
    });
  });
}
