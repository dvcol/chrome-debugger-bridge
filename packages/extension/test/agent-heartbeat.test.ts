import type { AgentToBrokerMessage, BrokerToAgentMessage } from '@dvcol/cdb/protocol';

import { expect, it } from 'vitest';

import { sendAgentHeartbeat } from '../src/agent-heartbeat.js';

it('sends only a generation-bound control request and accepts its matching response', async () => {
  expect.assertions(4);
  const listeners = new Set<(message: BrokerToAgentMessage) => void>();
  const sent: AgentToBrokerMessage[] = [];
  const connection = {
    close() {},
    onMessage(listener: (message: BrokerToAgentMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(message: AgentToBrokerMessage) {
      sent.push(message);
      if (message.kind !== 'request' || message.method !== 'agent.heartbeat') throw new Error('Expected heartbeat request.');
      for (const listener of listeners) listener({
        kind: 'response',
        method: 'agent.heartbeat',
        protocolVersion: 1,
        requestId: message.requestId,
        result: { connectionGeneration: message.parameters.connectionGeneration },
      });
    },
  };

  await expect(sendAgentHeartbeat(connection, 3, 10)).resolves.toBeUndefined();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: 'agent.heartbeat', parameters: { connectionGeneration: 3 } });
  expect(JSON.stringify(sent[0])).not.toContain('targetId');
});
