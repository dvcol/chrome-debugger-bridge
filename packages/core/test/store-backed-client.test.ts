import type { ClientTargetConnection } from '../src/client-target-connection.js';
import type { BrokerToClientMessage, ClientToBrokerMessage, PublishedTarget } from '../src/protocol.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryAuthorityStore } from '../src/authority.js';
import { createTargetBroker } from '../src/broker.js';
import { connectStoreBackedClientTargetBroker } from '../src/client-target-connection.js';

const target: PublishedTarget = {
  availability: 'available',
  capabilities: { level: 'debug' },
  generation: 1,
  id: 'target-1',
  scopeId: 'scope-1',
  title: 'Target',
  type: 'page',
};

afterEach(() => vi.useRealTimers());

function connection() {
  let listener: ((message: ClientToBrokerMessage) => void) | undefined;
  const sent: BrokerToClientMessage[] = [];
  const value: ClientTargetConnection = {
    onMessage(nextListener) {
      listener = nextListener;
      return () => listener = undefined;
    },
    async send(message) {
      sent.push(message);
    },
  };
  return { listener: () => listener, sent, value };
}

describe('connectStoreBackedClientTargetBroker', () => {
  it('applies reactive generation-bound authority without reconnecting', async () => {
    expect.assertions(3);
    const authorityStore = createMemoryAuthorityStore([{
      activeConnectionId: 'connection-1',
      bindings: [{ bindingId: 'binding-1', capabilities: { level: 'inspect' }, targetGeneration: 1, targetId: target.id }],
      connectionGeneration: 1,
      logicalSessionId: 'session-1',
      principalId: 'principal-1',
    }]);
    const broker = createTargetBroker();
    broker.publishTarget(target);
    const clientConnection = connection();
    const disconnect = await connectStoreBackedClientTargetBroker(clientConnection.value, broker, {
      authorityStore,
      connectionId: 'connection-1',
      logicalSessionId: 'session-1',
    });
    await vi.waitFor(() => {
      if (!clientConnection.sent.some(message => message.kind === 'notification'
        && message.method === 'targets.snapshot'
        && message.parameters.targets.length === 1)) throw new Error('Missing authorized target snapshot.');
    });
    expect(clientConnection.sent.some(message => message.kind === 'notification'
      && message.method === 'targets.snapshot'
      && message.parameters.targets.length === 1)).toBe(true);

    await authorityStore.update('session-1', current => ({ ...current!, bindings: [] }));
    await vi.waitFor(() => {
      if (!clientConnection.sent.some(message => message.kind === 'notification'
        && message.method === 'targets.snapshot'
        && message.parameters.targets.length === 0)) throw new Error('Missing revoked target snapshot.');
    });
    expect(clientConnection.sent.some(message => message.kind === 'notification'
      && message.method === 'targets.snapshot'
      && message.parameters.targets.length === 0)).toBe(true);

    disconnect();
    expect(broker.listTargets()).toStrictEqual([target]);
  });

  it('reactively expires a binding while the logical session remains connected', async () => {
    expect.assertions(2);
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const authorityStore = createMemoryAuthorityStore([{
      activeConnectionId: 'connection-1',
      bindings: [{
        bindingId: 'binding-1',
        capabilities: { level: 'debug' },
        expiresAt: new Date(1_050).toISOString(),
        targetGeneration: 1,
        targetId: target.id,
      }],
      connectionGeneration: 1,
      logicalSessionId: 'session-1',
      principalId: 'principal-1',
    }]);
    const broker = createTargetBroker({ now: Date.now });
    broker.publishTarget(target);
    const clientConnection = connection();
    const disconnect = await connectStoreBackedClientTargetBroker(clientConnection.value, broker, {
      authorityStore,
      connectionId: 'connection-1',
      logicalSessionId: 'session-1',
      now: Date.now,
    });
    const lease = broker.acquireLease({
      durationMilliseconds: 25,
      mode: 'exclusive-control',
      requestedMethods: ['Runtime.evaluate'],
      targetGeneration: 1,
      targetId: target.id,
    }, {
      connectionId: 'connection-1',
      principalId: 'principal-1',
      targetGrants: [{ bindingId: 'binding-1', capabilities: { level: 'debug' }, targetGeneration: 1, targetId: target.id }],
    });
    expect(lease.targetId).toBe(target.id);
    await vi.advanceTimersByTimeAsync(50);

    const targetListRequest: ClientToBrokerMessage = {
      kind: 'request',
      method: 'targets.list',
      parameters: {},
      protocolVersion: 1,
      requestId: 'request-1',
    };
    clientConnection.listener()?.(targetListRequest);
    await vi.waitFor(() => {
      if (!clientConnection.sent.some(message => message.kind === 'response'
        && message.method === 'targets.list'
        && message.result.targets.length === 0)) throw new Error('Missing expired target response.');
    });
    expect(clientConnection.sent.some(message => message.kind === 'response'
      && message.method === 'targets.list'
      && message.result.targets.length === 0)).toBe(true);
    disconnect();
  });
});
