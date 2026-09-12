import type { AutomationProvider } from '../src/automation.js';
import type { TargetBroker } from '../src/broker.js';
import type {
  AgentToBrokerMessage,
  BrokerToAgentMessage,
  BrokerToClientMessage,
  CdpCommand,
  ClientToBrokerMessage,
  PublishedTarget,
} from '../src/protocol.js';

import { expect, it, vi } from 'vitest';

import { AutomationProviderError } from '../src/automation.js';
import { createTargetBroker } from '../src/broker.js';
import {
  createChromeDebuggerBridgeClient,
  createClientFacadeAdapter,
} from '../src/client.js';
import {
  connectAgentTargetBroker,
  connectClientTargetBroker,
} from '../src/index.js';
import { artifactResultSchema } from '../src/protocol.js';

const target = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: '60000000-0000-4000-8000-000000000001',
  scopeId: '40000000-0000-4000-8000-000000000001',
  title: 'Example target',
  type: 'page',
  url: 'https://example.com/',
} satisfies PublishedTarget;

async function artifactId(value: unknown): Promise<string> {
  const result = await artifactResultSchema['~standard'].validate(value);
  if ('issues' in result) throw new Error('Expected an artifact result.');
  return result.value.artifact.id;
}

function completeAgentHello(
  listener: ((message: AgentToBrokerMessage) => void) | undefined,
): void {
  listener?.({
    kind: 'request',
    method: 'agent.hello',
    parameters: {
      connectionGeneration: 1,
      features: [],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: {
        instanceId: '60000000-0000-4000-8000-000000000099',
        name: 'target-directory-test',
        role: 'agent',
        version: '0.0.0',
      },
      limits: {
        maximumArtifactBytes: 16_777_216,
        maximumInlineResultBytes: 65_536,
        maximumMessageBytes: 16_384,
      },
      protocolVersions: { maximum: 1, minimum: 1 },
    },
    protocolVersion: 1,
    requestId: '60000000-0000-4000-8000-000000000098',
  });
}

function createLocalClientFacadeAdapter(broker: TargetBroker) {
  return createClientFacadeAdapter({
    acquireLease: request => broker.acquireLease(request),
    async executeCommand(command) {
      return broker.executeCommand(command);
    },
    listTargets: () => broker.listTargets(),
    readArtifact: request => broker.readArtifact(request),
    releaseArtifact: request => broker.releaseArtifact(request),
    releaseLease: request => broker.releaseLease(request),
    renewLease: request => broker.renewLease(request),
    async subscribe(request) {
      return broker.subscribe(request);
    },
    watchTargets: () => broker.watchTargets(),
  });
}

it('lists only opaque targets published by the agent', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  const client = createChromeDebuggerBridgeClient(
    createLocalClientFacadeAdapter(broker),
  );

  broker.publishTarget(target);
  const targets = await client.listTargets();
  broker.revokeTarget(target.id, target.generation);

  expect(targets).toEqual([target]);
  expect(Object.keys(targets[0] ?? {})).not.toContain('tabId');
  expect(await client.listTargets()).toEqual([]);
});

it('projects only granted targets and intersects their capabilities for one client authority', async () => {
  expect.assertions(5);
  const broker = createTargetBroker();
  const secondTarget = {
    ...target,
    id: '60000000-0000-4000-8000-000000000002',
    title: 'Other target',
  };
  const authority = {
    connectionId: 'client-1',
    principalId: 'principal-1',
    targetGrants: [
      { bindingId: 'binding-1', capabilities: { level: 'debug' as const }, targetGeneration: target.generation, targetId: target.id },
    ],
  };
  broker.publishTarget(target);
  broker.publishTarget(secondTarget);
  const watcher = broker.watchTargets(authority)[Symbol.asyncIterator]();

  expect(broker.listTargets(authority)).toEqual([
    { ...target, capabilities: { level: 'debug' } },
  ]);
  expect(await watcher.next()).toEqual({
    done: false,
    value: {
      kind: 'snapshot',
      sequence: 2,
      targets: [{ ...target, capabilities: { level: 'debug' } }],
    },
  });
  expect(() =>
    broker.acquireLease(
      {
        durationMilliseconds: 1_000,
        mode: 'exclusive-control',
        requestedMethods: ['Debugger.setBreakpointByUrl'],
        targetGeneration: target.generation,
        targetId: target.id,
      },
      authority,
    ),
  ).not.toThrow();
  expect(() =>
    broker.acquireLease(
      {
        durationMilliseconds: 1_000,
        requestedMethods: ['Runtime.consoleAPICalled'],
        targetGeneration: secondTarget.generation,
        targetId: secondTarget.id,
      },
      authority,
    ),
  ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  expect(() =>
    broker.acquireLease(
      {
        durationMilliseconds: 1_000,
        mode: 'exclusive-control',
        requestedMethods: ['Unknown.unsafeCommand'],
        targetGeneration: target.generation,
        targetId: target.id,
      },
      authority,
    ),
  ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
});

it('fences a binding when the target advances to another generation', () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  const authority = {
    connectionId: 'client-1',
    principalId: 'principal-1',
    targetGrants: [{
      bindingId: 'binding-1',
      capabilities: { level: 'inspect' as const },
      targetGeneration: target.generation,
      targetId: target.id,
    }],
  };
  broker.publishTarget(target);
  broker.revokeTarget(target.id, target.generation);
  broker.publishTarget({ ...target, generation: target.generation + 1 });

  expect(broker.listTargets(authority)).toStrictEqual([]);
  expect(() => broker.acquireLease({
    durationMilliseconds: 1_000,
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation + 1,
    targetId: target.id,
  }, authority)).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
});

const capabilityLevels = [
  'observe',
  'inspect',
  'interact',
  'debug',
  'unsafe',
] as const;

it.each(capabilityLevels.flatMap(left => capabilityLevels.map(right => [left, right] as const)))(
  'combines duplicate %s and %s grants without depending on insertion order',
  (left, right) => {
    expect.assertions(2);
    const broker = createTargetBroker();
    const expectedLevel = capabilityLevels[Math.max(
      capabilityLevels.indexOf(left),
      capabilityLevels.indexOf(right),
    )];
    const targetWithExactCapabilities: PublishedTarget = {
      ...target,
      capabilities: {
        allow: ['Custom.first', 'Custom.second'],
        level: 'unsafe',
      },
    };
    const createAuthority = (reverse: boolean) => ({
      connectionId: 'client-1',
      principalId: 'principal-1',
      targetGrants: (reverse
        ? [
            { bindingId: 'binding-2', capabilities: { allow: ['Custom.second'], level: right }, targetGeneration: target.generation, targetId: target.id },
            { bindingId: 'binding-1', capabilities: { allow: ['Custom.first'], level: left }, targetGeneration: target.generation, targetId: target.id },
          ]
        : [
            { bindingId: 'binding-1', capabilities: { allow: ['Custom.first'], level: left }, targetGeneration: target.generation, targetId: target.id },
            { bindingId: 'binding-2', capabilities: { allow: ['Custom.second'], level: right }, targetGeneration: target.generation, targetId: target.id },
          ]),
    });
    broker.publishTarget(targetWithExactCapabilities);

    expect(broker.listTargets(createAuthority(false))).toEqual([{
      ...targetWithExactCapabilities,
      capabilities: {
        allow: ['Custom.first', 'Custom.second'],
        level: expectedLevel,
      },
    }]);
    expect(broker.listTargets(createAuthority(true))).toEqual([{
      ...targetWithExactCapabilities,
      capabilities: {
        allow: ['Custom.first', 'Custom.second'],
        level: expectedLevel,
      },
    }]);
  },
);

it('reports exclusive lease ownership and advisory retry timing', () => {
  expect.assertions(4);
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const broker = createTargetBroker({ now: () => now });
  const firstAuthority = {
    connectionId: 'client-1',
    displayName: 'Agent one',
    principalId: 'principal-1',
  };
  const secondAuthority = {
    connectionId: 'client-2',
    displayName: 'Agent two',
    principalId: 'principal-2',
  };
  broker.publishTarget(target);
  broker.acquireLease(
    {
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Debugger.setBreakpointByUrl'],
      targetGeneration: target.generation,
      targetId: target.id,
    },
    firstAuthority,
  );

  let conflict: unknown;
  try {
    broker.acquireLease(
      {
        durationMilliseconds: 1_000,
        mode: 'exclusive-control',
        requestedMethods: ['Debugger.setBreakpointByUrl'],
        targetGeneration: target.generation,
        targetId: target.id,
      },
      secondAuthority,
    );
  } catch (error) {
    conflict = error;
  }

  expect(conflict).toMatchObject({
    code: 'LEASE_CONFLICT',
    retryable: true,
    retryAfterMs: 1_000,
  });
  expect(conflict).toMatchObject({
    details: {
      controller: 'principal-1',
      expiresAt: '2030-01-01T00:00:01.000Z',
    },
  });
  expect(conflict).toMatchObject({
    message: 'Another client currently holds the exclusive controller lease.',
  });
  expect(secondAuthority.displayName).toBe('Agent two');
  broker.dispose();
});

it('keeps leases principal-owned across reconnect grace while isolating connections', async () => {
  expect.assertions(6);
  vi.useFakeTimers();
  try {
    const broker = createTargetBroker({ timing: { reconnectGraceMilliseconds: 5_000 } });
    const firstConnection = {
      connectionId: 'first',
      principalId: 'principal-a',
    };
    const secondConnection = {
      connectionId: 'second',
      principalId: 'principal-a',
    };
    const otherPrincipal = {
      connectionId: 'other',
      principalId: 'principal-b',
    };
    broker.publishTarget(target);
    broker.connectClient(firstConnection);
    const lease = broker.acquireLease(
      {
        durationMilliseconds: 1_000,
        mode: 'exclusive-control',
        requestedMethods: ['Runtime.evaluate'],
        targetGeneration: target.generation,
        targetId: target.id,
      },
      firstConnection,
    );
    expect(() =>
      broker.renewLease(
        {
          durationMilliseconds: 1_000,
          leaseId: lease.id,
          targetGeneration: target.generation,
          targetId: target.id,
        },
        otherPrincipal,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
    broker.disconnectClient(firstConnection);
    expect(() =>
      broker.acquireLease(
        {
          durationMilliseconds: 1_000,
          mode: 'exclusive-control',
          requestedMethods: ['Runtime.evaluate'],
          targetGeneration: target.generation,
          targetId: target.id,
        },
        otherPrincipal,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LEASE_CONFLICT' }));
    broker.connectClient(secondConnection);
    expect(
      broker.renewLease(
        {
          durationMilliseconds: 1_000,
          leaseId: lease.id,
          targetGeneration: target.generation,
          targetId: target.id,
        },
        secondConnection,
      ).id,
    ).toBe(lease.id);
    broker.disconnectClient(secondConnection);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(() =>
      broker.renewLease(
        {
          durationMilliseconds: 1_000,
          leaseId: lease.id,
          targetGeneration: target.generation,
          targetId: target.id,
        },
        secondConnection,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
    broker.connectClient(firstConnection);
    const immediateLease = broker.acquireLease(
      {
        durationMilliseconds: 1_000,
        requestedMethods: ['Runtime.consoleAPICalled'],
        targetGeneration: target.generation,
        targetId: target.id,
      },
      firstConnection,
    );
    broker.disconnectClient(firstConnection);
    expect(immediateLease.id).toMatch(/^[0-9a-f-]{36}$/u);
    broker.dispose();
    const immediateBroker = createTargetBroker({
      timing: { reconnectGraceMilliseconds: 0 },
    });
    immediateBroker.publishTarget(target);
    immediateBroker.connectClient(firstConnection);
    const zeroGraceLease = immediateBroker.acquireLease(
      {
        durationMilliseconds: 1_000,
        requestedMethods: ['Runtime.consoleAPICalled'],
        targetGeneration: target.generation,
        targetId: target.id,
      },
      firstConnection,
    );
    immediateBroker.disconnectClient(firstConnection);
    expect(() =>
      immediateBroker.renewLease(
        {
          durationMilliseconds: 1_000,
          leaseId: zeroGraceLease.id,
          targetGeneration: target.generation,
          targetId: target.id,
        },
        firstConnection,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
    immediateBroker.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it('terminates a subscription when its lease expires without further traffic', async () => {
  expect.assertions(1);
  vi.useFakeTimers();
  try {
    const broker = createTargetBroker();
    broker.publishTarget(target);
    const lease = broker.acquireLease({
      durationMilliseconds: 10,
      requestedMethods: ['Runtime.consoleAPICalled'],
      targetGeneration: target.generation,
      targetId: target.id,
    });
    const subscription = await broker.subscribe({
      buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
      leaseId: lease.id,
      match: { method: 'Runtime.consoleAPICalled' },
      targetGeneration: target.generation,
      targetId: target.id,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  } finally {
    vi.useRealTimers();
  }
});

it('keeps a lifecycle-managed command domain active for the lease and disables it on release', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  const actions: string[] = [];
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, {
    async execute(command) {
      actions.push(`execute:${command.method}`);
      return {};
    },
    async setSubscriptionDemand(methodPrefix, active) {
      actions.push(`${active ? 'enable' : 'disable'}:${methodPrefix}`);
    },
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: [
      'Debugger.setBreakpointByUrl',
      'Debugger.removeBreakpoint',
    ],
    targetGeneration: target.generation,
    targetId: target.id,
  });

  await broker.executeCommand({
    leaseId: lease.id,
    method: 'Debugger.setBreakpointByUrl',
    operationId: '30000000-0000-4000-8000-000000000101',
    targetGeneration: target.generation,
    targetId: target.id,
  });
  await broker.executeCommand({
    leaseId: lease.id,
    method: 'Debugger.removeBreakpoint',
    operationId: '30000000-0000-4000-8000-000000000102',
    targetGeneration: target.generation,
    targetId: target.id,
  });

  expect(actions).toEqual([
    'enable:Debugger.',
    'execute:Debugger.setBreakpointByUrl',
    'execute:Debugger.removeBreakpoint',
  ]);
  broker.releaseLease({
    leaseId: lease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  });
  await Promise.resolve();
  expect(actions).toEqual([
    'enable:Debugger.',
    'execute:Debugger.setBreakpointByUrl',
    'execute:Debugger.removeBreakpoint',
    'disable:Debugger.',
  ]);
  expect(broker.listTargets()).toEqual([target]);
  broker.dispose();
});

it('reference-counts lifecycle-managed domains across shared leases', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  const demandChanges: string[] = [];
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, {
    async execute() {
      return {};
    },
    async setSubscriptionDemand(methodPrefix, active) {
      demandChanges.push(`${active ? 'enable' : 'disable'}:${methodPrefix}`);
    },
  });
  const firstLease = broker.acquireLease({
    durationMilliseconds: 1_000,
    requestedMethods: ['Runtime.getProperties'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const secondLease = broker.acquireLease({
    durationMilliseconds: 1_000,
    requestedMethods: ['Runtime.getProperties'],
    targetGeneration: target.generation,
    targetId: target.id,
  });

  await broker.executeCommand({
    leaseId: firstLease.id,
    method: 'Runtime.getProperties',
    operationId: '30000000-0000-4000-8000-000000000103',
    targetGeneration: target.generation,
    targetId: target.id,
  });
  await broker.executeCommand({
    leaseId: secondLease.id,
    method: 'Runtime.getProperties',
    operationId: '30000000-0000-4000-8000-000000000104',
    targetGeneration: target.generation,
    targetId: target.id,
  });
  expect(demandChanges).toEqual(['enable:Runtime.']);

  broker.releaseLease({
    leaseId: firstLease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  });
  await Promise.resolve();
  expect(demandChanges).toEqual(['enable:Runtime.']);
  broker.releaseLease({
    leaseId: secondLease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  });
  await Promise.resolve();
  expect(demandChanges).toEqual(['enable:Runtime.', 'disable:Runtime.']);
  broker.dispose();
});

it('orders target changes and starts every watcher from a fresh snapshot', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  const watcher = broker.watchTargets()[Symbol.asyncIterator]();
  broker.publishTarget(target);
  broker.updateTarget({ ...target, title: 'Changed title' });
  broker.revokeTarget(target.id, target.generation, 'closed');

  expect(await watcher.next()).toEqual({
    done: false,
    value: { kind: 'snapshot', sequence: 0, targets: [] },
  });
  expect(await watcher.next()).toMatchObject({
    done: false,
    value: { kind: 'published', sequence: 1, target },
  });
  expect(await watcher.next()).toMatchObject({
    done: false,
    value: { kind: 'updated', sequence: 2, target: { title: 'Changed title' } },
  });
  expect(await watcher.next()).toEqual({
    done: false,
    value: {
      kind: 'revoked',
      reason: 'closed',
      sequence: 3,
      targetGeneration: 1,
      targetId: target.id,
    },
  });
});

it('reconciles agent state without accepting a stale target generation', () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget({ ...target, generation: 2 });
  broker.reconcileTargets([
    { ...target, generation: 3, title: 'Reconnected target' },
  ]);

  expect(broker.listTargets()).toEqual([
    { ...target, generation: 3, title: 'Reconnected target' },
  ]);
  broker.revokeTarget(target.id, 3);
  expect(() => broker.reconcileTargets([target])).toThrowError(
    'The requested target operation is not available.',
  );
  expect(broker.listTargets()).toEqual([]);
});

it('isolates reconciliation by authenticated agent authority', () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  const firstAuthority = { principalId: 'provider-1' };
  const secondAuthority = { principalId: 'provider-2' };
  const secondTarget = {
    ...target,
    id: '60000000-0000-4000-8000-000000000002',
  };
  broker.publishTarget(target, firstAuthority);
  broker.publishTarget(secondTarget, secondAuthority);
  broker.reconcileTargets([], firstAuthority);

  expect(broker.listTargets()).toEqual([secondTarget]);
  expect(() =>
    broker.updateTarget({ ...secondTarget, title: 'Stolen' }, firstAuthority),
  ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
});

it('fences an obsolete provider connection generation without letting its cleanup revoke the replacement', () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  const firstAuthority = { connectionGeneration: 1, principalId: 'provider-1' };
  const replacementAuthority = { connectionGeneration: 2, principalId: 'provider-1' };
  broker.publishTarget(target, firstAuthority);
  const replacementTarget = { ...target, generation: 2, title: 'Replacement connection' };
  broker.publishTarget(replacementTarget, replacementAuthority);

  expect(broker.listTargets()).toEqual([replacementTarget]);
  expect(() => broker.updateTarget({ ...replacementTarget, title: 'Stale update' }, firstAuthority))
    .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  broker.revokeAgentTargets(firstAuthority);
  expect(broker.listTargets()).toEqual([replacementTarget]);
});

it('retains targets for host-managed recovery and reconciles a higher generation', () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  const authority = { principalId: 'provider-1' };
  let firstListener: ((message: AgentToBrokerMessage) => void) | undefined;
  const disconnectFirst = connectAgentTargetBroker(
    {
      onMessage(receivedListener) {
        firstListener = receivedListener;
        return () => (firstListener = undefined);
      },
    },
    broker,
    { authority, revokeTargetsOnDisconnect: false },
  );
  completeAgentHello(firstListener);
  firstListener?.({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target },
    protocolVersion: 1,
  });
  disconnectFirst();

  expect(broker.listTargets()).toEqual([target]);

  let secondListener: ((message: AgentToBrokerMessage) => void) | undefined;
  const disconnectSecond = connectAgentTargetBroker(
    {
      onMessage(receivedListener) {
        secondListener = receivedListener;
        return () => (secondListener = undefined);
      },
    },
    broker,
    { authority, revokeTargetsOnDisconnect: false },
  );
  completeAgentHello(secondListener);
  secondListener?.({
    kind: 'notification',
    method: 'targets.reconcile',
    parameters: { targets: [{ ...target, generation: 2 }] },
    protocolVersion: 1,
  });

  expect(broker.listTargets()).toEqual([{ ...target, generation: 2 }]);
  disconnectSecond();
});

it('applies authenticated agent lifecycle notifications to the broker', () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  const disconnect = connectAgentTargetBroker(
    {
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
    },
    broker,
  );

  completeAgentHello(listener);
  listener?.({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target },
    protocolVersion: 1,
  });
  expect(broker.listTargets()).toEqual([target]);
  listener?.({
    kind: 'notification',
    method: 'targets.reconcile',
    parameters: { targets: [] },
    protocolVersion: 1,
  });
  expect(broker.listTargets()).toEqual([]);
  disconnect();
});

it('rejects agent traffic until one matching hello completes', () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  let closeCode: number | undefined;
  const disconnect = connectAgentTargetBroker(
    {
      close(code) {
        closeCode = code;
      },
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
    },
    broker,
  );

  listener?.({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target },
    protocolVersion: 1,
  });
  expect(broker.listTargets()).toEqual([]);
  expect(closeCode).toBe(1008);
  completeAgentHello(listener);
  listener?.({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target },
    protocolVersion: 1,
  });
  expect(broker.listTargets()).toEqual([]);
  disconnect();
});

it('answers only a post-handshake heartbeat for the active connection generation', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  let closeCode: number | undefined;
  const disconnect = connectAgentTargetBroker(
    {
      close(code) {
        closeCode = code;
      },
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
    },
    broker,
  );

  listener?.({
    kind: 'request',
    method: 'agent.heartbeat',
    parameters: { connectionGeneration: 1 },
    protocolVersion: 1,
    requestId: '60000000-0000-4000-8000-000000000097',
  });
  expect(closeCode).toBe(1008);
  disconnect();

  const activeMessages: BrokerToAgentMessage[] = [];
  closeCode = undefined;
  const activeDisconnect = connectAgentTargetBroker(
    {
      close(code) {
        closeCode = code;
      },
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
      async send(message) {
        activeMessages.push(message);
      },
    },
    broker,
  );
  completeAgentHello(listener);
  listener?.({
    kind: 'request',
    method: 'agent.heartbeat',
    parameters: { connectionGeneration: 1 },
    protocolVersion: 1,
    requestId: '60000000-0000-4000-8000-000000000096',
  });
  await Promise.resolve();
  expect(activeMessages).toContainEqual({
    kind: 'response',
    method: 'agent.heartbeat',
    protocolVersion: 1,
    requestId: '60000000-0000-4000-8000-000000000096',
    result: { connectionGeneration: 1 },
  });
  expect(broker.listTargets()).toEqual([]);
  listener?.({
    kind: 'request',
    method: 'agent.heartbeat',
    parameters: { connectionGeneration: 2 },
    protocolVersion: 1,
    requestId: '60000000-0000-4000-8000-000000000095',
  });
  expect(closeCode).toBe(1008);
  activeDisconnect();
});

it('observes detached agent handshake and heartbeat sends', async () => {
  expect.assertions(1);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  const catchRejection = vi.spyOn(Promise.prototype, 'catch');
  const disconnect = connectAgentTargetBroker(
    {
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
      async send() {},
    },
    broker,
  );

  completeAgentHello(listener);
  listener?.({
    kind: 'request',
    method: 'agent.heartbeat',
    parameters: { connectionGeneration: 1 },
    protocolVersion: 1,
    requestId: '60000000-0000-4000-8000-000000000094',
  });
  await Promise.resolve();

  expect(catchRejection).toHaveBeenCalledTimes(2);
  catchRejection.mockRestore();
  disconnect();
});

it('revokes every target when its authenticated agent connection closes', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  let closeConnection: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    closeConnection = resolve;
  });
  connectAgentTargetBroker(
    {
      closed,
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
    },
    broker,
  );

  completeAgentHello(listener);
  listener?.({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target },
    protocolVersion: 1,
  });
  expect(broker.listTargets()).toEqual([target]);
  closeConnection?.();
  await Promise.resolve();
  expect(broker.listTargets()).toEqual([]);
});

it('relays broker commands and agent events through opaque published targets', async () => {
  expect.assertions(6);
  const broker = createTargetBroker();
  const sentMessages: BrokerToAgentMessage[] = [];
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  const disconnect = connectAgentTargetBroker(
    {
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
      async send(message) {
        sentMessages.push(message);
      },
    },
    broker,
  );

  completeAgentHello(listener);
  listener?.({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target },
    protocolVersion: 1,
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate', 'Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const subscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const execution = broker.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000010',
    parameters: { expression: 'document.title' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  await vi.waitFor(() => {
    if (
      !sentMessages.some(
        message =>
          message.kind === 'request' && message.method === 'cdp.execute',
      )
    )
      throw new Error('The broker command was not forwarded to the provider.');
  });
  const request = sentMessages.find(
    (
      message,
    ): message is Extract<
      BrokerToAgentMessage,
      { readonly kind: 'request'; readonly method: 'cdp.execute' }
    > => message.kind === 'request' && message.method === 'cdp.execute',
  );
  listener?.({
    kind: 'response',
    method: 'cdp.execute',
    protocolVersion: 1,
    requestId: request!.requestId,
    result: {
      operationId: '30000000-0000-4000-8000-000000000010',
      value: { result: 'Bridge target' },
    },
  });
  listener?.({
    kind: 'notification',
    method: 'cdp.event',
    parameters: {
      method: 'Runtime.consoleAPICalled',
      parameters: { type: 'log' },
      targetGeneration: target.generation,
      targetId: target.id,
    },
    protocolVersion: 1,
  });

  expect(request?.parameters.command.targetId).toBe(target.id);
  expect(request?.parameters.lease.id).toBe(lease.id);
  await expect(execution).resolves.toEqual({
    operationId: '30000000-0000-4000-8000-000000000010',
    value: { result: 'Bridge target' },
  });
  expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({
    done: false,
    value: { method: 'Runtime.consoleAPICalled', parameters: { type: 'log' } },
  });
  expect(JSON.stringify(sentMessages)).not.toContain('tabId');
  expect(listener).toBeDefined();
  disconnect();
});

it('rejects a pending command while its outbound agent send is still settling', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  const commandSent = Promise.withResolvers<void>();
  const finishSending = Promise.withResolvers<void>();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  const disconnect = connectAgentTargetBroker(
    {
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
      async send(message) {
        if (message.kind !== 'request' || message.method !== 'cdp.execute') return;
        commandSent.resolve();
        await finishSending.promise;
      },
    },
    broker,
    { revokeTargetsOnDisconnect: false },
  );

  completeAgentHello(listener);
  listener?.({
    kind: 'notification',
    method: 'targets.publish',
    parameters: { target },
    protocolVersion: 1,
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const execution = broker.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000011',
    targetGeneration: target.generation,
    targetId: target.id,
  });
  await commandSent.promise;

  disconnect();

  await expect(execution).rejects.toThrow('The agent connection closed.');
  expect(broker.listTargets()).toEqual([target]);
  finishSending.resolve();
});

it('streams a fresh target snapshot followed by ordered lifecycle notifications to a client', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  const messages: BrokerToClientMessage[] = [];
  let resolveFourthMessage: (() => void) | undefined;
  const fourthMessage = new Promise<void>(
    resolve => (resolveFourthMessage = resolve),
  );
  const disconnect = connectClientTargetBroker(
    {
      async send(message) {
        messages.push(message);
        if (messages.length === 4) resolveFourthMessage?.();
      },
    },
    broker,
  );

  broker.publishTarget(target);
  broker.updateTarget({ ...target, title: 'Updated title' });
  broker.revokeTarget(target.id, target.generation, 'closed');
  await fourthMessage;
  disconnect();

  expect(messages[0]).toEqual({
    kind: 'notification',
    method: 'targets.snapshot',
    parameters: { sequence: 0, targets: [] },
    protocolVersion: 1,
  });
  expect(messages[1]).toMatchObject({
    method: 'targets.published',
    parameters: { target },
  });
  expect(messages[2]).toMatchObject({
    method: 'targets.updated',
    parameters: { target: { title: 'Updated title' } },
  });
  expect(messages[3]).toEqual({
    kind: 'notification',
    method: 'targets.revoked',
    parameters: { reason: 'closed', targetGeneration: 1, targetId: target.id },
    protocolVersion: 1,
  });
});

it('serves independent subscription responses and event streams over the client-plane connection', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  const messages: BrokerToClientMessage[] = [];
  let listener: ((message: ClientToBrokerMessage) => void) | undefined;
  let resolveSubscribed: (() => void) | undefined;
  let resolveEvent: (() => void) | undefined;
  let resolveUnsubscribed: (() => void) | undefined;
  const subscribed = new Promise<void>(
    resolve => (resolveSubscribed = resolve),
  );
  const eventDelivered = new Promise<void>(
    resolve => (resolveEvent = resolve),
  );
  const unsubscribed = new Promise<void>(
    resolve => (resolveUnsubscribed = resolve),
  );
  const disconnect = connectClientTargetBroker(
    {
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
      async send(message) {
        messages.push(message);
        if (message.kind === 'response' && message.method === 'cdp.subscribe')
          resolveSubscribed?.();
        if (message.kind === 'response' && message.method === 'cdp.unsubscribe')
          resolveUnsubscribed?.();
        if (message.kind === 'notification' && message.method === 'cdp.event')
          resolveEvent?.();
      },
    },
    broker,
  );
  broker.publishTarget(target);
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  listener?.({
    kind: 'request',
    method: 'cdp.subscribe',
    parameters: {
      buffer: { capacity: 1, overflowStrategy: 'disconnect' },
      leaseId: lease.id,
      match: { method: 'Runtime.consoleAPICalled' },
      targetGeneration: target.generation,
      targetId: target.id,
    },
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000001',
  });
  await subscribed;
  broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' });
  await eventDelivered;
  const response = messages.find(
    message =>
      message.kind === 'response' && message.method === 'cdp.subscribe',
  );
  const event = messages.find(
    message =>
      message.kind === 'notification' && message.method === 'cdp.event',
  );
  const subscriptionId
    = response?.kind === 'response' && response.method === 'cdp.subscribe'
      ? response.result.subscriptionId
      : undefined;
  listener?.({
    kind: 'request',
    method: 'cdp.unsubscribe',
    parameters: { subscriptionId: subscriptionId! },
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000002',
  });
  await unsubscribed;
  disconnect();

  expect(subscriptionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(event).toMatchObject({
    parameters: {
      method: 'Runtime.consoleAPICalled',
      parameters: { type: 'log' },
    },
  });
  expect(
    messages.some(
      message =>
        message.kind === 'response' && message.method === 'cdp.unsubscribe',
    ),
  ).toBe(true);
  expect(listener).toBeUndefined();
});

it('serves target listing, leases, and authorized commands over the client-plane connection', async () => {
  expect.assertions(5);
  const broker = createTargetBroker();
  const messages: BrokerToClientMessage[] = [];
  let listener: ((message: ClientToBrokerMessage) => void) | undefined;
  let resolveResponse: ((message: BrokerToClientMessage) => void) | undefined;
  const disconnect = connectClientTargetBroker(
    {
      onMessage(receivedListener) {
        listener = receivedListener;
        return () => (listener = undefined);
      },
      async send(message) {
        messages.push(message);
        resolveResponse?.(message);
      },
    },
    broker,
  );
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, {
    async execute(command) {
      return { result: command.parameters?.expression ?? '' };
    },
  });
  const waitForResponse = async (
    method: Extract<
      BrokerToClientMessage,
      { readonly kind: 'response' }
    >['method'],
  ): Promise<Extract<BrokerToClientMessage, { readonly kind: 'response' }>> =>
    new Promise((resolve) => {
      resolveResponse = (message) => {
        if (message.kind === 'response' && message.method === method) {
          resolveResponse = undefined;
          resolve(message);
        }
      };
    });

  const listed = waitForResponse('targets.list');
  listener?.({
    kind: 'request',
    method: 'targets.list',
    parameters: {},
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000020',
  });
  const listedResponse = await listed;
  const acquired = waitForResponse('leases.acquire');
  listener?.({
    kind: 'request',
    method: 'leases.acquire',
    parameters: {
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Runtime.evaluate'],
      targetGeneration: target.generation,
      targetId: target.id,
    },
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000021',
  });
  const acquiredResponse = await acquired;
  const lease
    = acquiredResponse.kind === 'response'
      && acquiredResponse.method === 'leases.acquire'
      ? acquiredResponse.result.lease
      : undefined;
  const executed = waitForResponse('cdp.send');
  listener?.({
    kind: 'request',
    method: 'cdp.send',
    parameters: {
      leaseId: lease!.id,
      method: 'Runtime.evaluate',
      operationId: '30000000-0000-4000-8000-000000000020',
      parameters: { expression: 'document.title' },
      targetGeneration: target.generation,
      targetId: target.id,
    },
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000022',
  });
  const executedResponse = await executed;
  disconnect();

  expect(listedResponse).toMatchObject({
    result: { targets: [{ id: target.id }] },
  });
  expect(lease?.mode).toBe('exclusive-control');
  expect(executedResponse).toMatchObject({
    result: {
      operationId: '30000000-0000-4000-8000-000000000020',
      value: { result: 'document.title' },
    },
  });
  expect(JSON.stringify(messages)).not.toContain('tabId');
  expect(listener).toBeUndefined();
});

it('executes only a non-expired lease grant through the registered opaque target executor', async () => {
  expect.assertions(6);
  let currentTime = Date.parse('2026-08-04T12:00:00.000Z');
  const broker = createTargetBroker({ now: () => currentTime });
  const client = createChromeDebuggerBridgeClient(
    createLocalClientFacadeAdapter(broker),
  );
  broker.publishTarget(target);
  const execute = vi.fn(async (command: CdpCommand) => ({
    expression: command.parameters?.expression ?? '',
  }));
  broker.registerTargetExecutor(target, { execute });
  const lease = await client.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const result = await client.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000001',
    parameters: { expression: 'document.title' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  currentTime += 1_000;

  expect(result).toEqual({
    operationId: '30000000-0000-4000-8000-000000000001',
    value: { expression: 'document.title' },
  });
  expect(execute).toHaveBeenCalledOnce();
  await expect(
    client.acquireLease({
      durationMilliseconds: 1,
      requestedMethods: ['Page.navigate'],
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  await expect(
    client.executeCommand({
      leaseId: lease.id,
      method: 'Runtime.evaluate',
      operationId: '30000000-0000-4000-8000-000000000002',
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  await expect(
    client.executeCommand({
      leaseId: globalThis.crypto.randomUUID(),
      method: 'Runtime.evaluate',
      operationId: '30000000-0000-4000-8000-000000000003',
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  expect(Object.keys(result.value)).not.toContain('tabId');
});

it('externalizes large command results and invalidates their access with the target grant', async () => {
  expect.assertions(6);
  const broker = createTargetBroker({
    maximumArtifactBytes: 100,
    maximumInlineResultBytes: 4,
    timing: { artifactLifetimeMilliseconds: 1_000 },
  });
  const client = createChromeDebuggerBridgeClient(
    createLocalClientFacadeAdapter(broker),
  );
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, {
    async execute() {
      return { value: 'large result' };
    },
  });
  const lease = await client.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const result = await client.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000007',
    targetGeneration: target.generation,
    targetId: target.id,
  });

  expect(result.value).toHaveProperty('artifact.mediaType', 'application/json');
  expect(result.value).not.toHaveProperty('artifact.path');
  const request = {
    artifactId: await artifactId(result.value),
    leaseId: lease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  };
  expect(await client.readArtifact(request)).toEqual(
    new TextEncoder().encode(JSON.stringify({ value: 'large result' })),
  );
  expect(
    await client.readArtifact({ ...request, range: { length: 5, offset: 2 } }),
  ).toEqual(
    new TextEncoder()
      .encode(JSON.stringify({ value: 'large result' }))
      .slice(2, 7),
  );
  await client.releaseArtifact(request);
  await expect(client.readArtifact(request)).rejects.toThrow('not available');
  const secondResult = await client.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000008',
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.revokeTarget(target.id, target.generation);
  await expect(
    client.readArtifact({
      ...request,
      artifactId: await artifactId(secondResult.value),
    }),
  ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
});

it('arbitrates shared reads and exclusive control, with renewal, release, expiry, and policy-reduction cleanup', () => {
  expect.assertions(8);
  let currentTime = Date.parse('2026-08-04T12:00:00.000Z');
  const broker = createTargetBroker({ now: () => currentTime });
  broker.publishTarget(target);
  const sharedReadLease = broker.acquireLease({
    durationMilliseconds: 1_000,
    requestedMethods: ['Network.canEmulateNetworkConditions'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const controllerLease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const renewedLease = broker.renewLease({
    durationMilliseconds: 2_000,
    leaseId: controllerLease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  });

  expect(sharedReadLease.mode).toBe('shared-read');
  expect(controllerLease.mode).toBe('exclusive-control');
  expect(renewedLease.expiresAt).toBe('2026-08-04T12:00:02.000Z');
  expect(() =>
    broker.acquireLease({
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Runtime.evaluate'],
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).toThrowError(expect.objectContaining({ code: 'LEASE_CONFLICT' }));
  broker.releaseLease({
    leaseId: controllerLease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  });
  expect(
    broker.acquireLease({
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Runtime.evaluate'],
      targetGeneration: target.generation,
      targetId: target.id,
    }).mode,
  ).toBe('exclusive-control');
  currentTime += 1_000;
  expect(() =>
    broker.renewLease({
      durationMilliseconds: 1_000,
      leaseId: sharedReadLease.id,
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).toThrowError(expect.objectContaining({ code: 'LEASE_EXPIRED' }));
  const policyLease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.updateTarget({ ...target, capabilities: { level: 'observe' } });
  expect(() =>
    broker.renewLease({
      durationMilliseconds: 1_000,
      leaseId: policyLease.id,
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
  expect(broker.listTargets()).toEqual([
    { ...target, capabilities: { level: 'observe' } },
  ]);
});

it('compiles hierarchy and exact-name grants into catalogue-backed lease authority', () => {
  expect.assertions(6);
  const broker = createTargetBroker();
  const inspectTarget = {
    ...target,
    capabilities: { level: 'inspect' as const },
  };
  broker.publishTarget(inspectTarget);

  expect(
    broker.acquireLease({
      durationMilliseconds: 1_000,
      requestedMethods: ['DOM.getDocument'],
      targetGeneration: target.generation,
      targetId: target.id,
    }).mode,
  ).toBe('shared-read');
  expect(() =>
    broker.acquireLease({
      durationMilliseconds: 1_000,
      requestedMethods: ['Runtime.evaluate'],
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  broker.updateTarget({
    ...inspectTarget,
    capabilities: { allow: ['Page.navigate'] },
  });
  expect(() =>
    broker.acquireLease({
      durationMilliseconds: 1_000,
      requestedMethods: ['Page.navigate'],
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  const exactNameLease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Page.navigate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  expect(exactNameLease.mode).toBe('exclusive-control');
  broker.releaseLease({
    leaseId: exactNameLease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.updateTarget({ ...inspectTarget, capabilities: { level: 'unsafe' } });
  expect(() =>
    broker.acquireLease({
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Target.attachToTarget'],
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  expect(
    broker.acquireLease({
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Experimental.newCommand'],
      targetGeneration: target.generation,
      targetId: target.id,
    }).mode,
  ).toBe('exclusive-control');
});

it('cancels a pending command and disposes its eventual response', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  let resolveCommand:
    ((value: { readonly result: string }) => void) | undefined;
  broker.registerTargetExecutor(target, {
    async execute() {
      return new Promise(resolve => (resolveCommand = resolve));
    },
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const operationId = '30000000-0000-4000-8000-000000000004';
  const command = broker.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId,
    targetGeneration: target.generation,
    targetId: target.id,
  });

  broker.cancelCommand(operationId);
  resolveCommand?.({ result: 'late response' });

  await expect(command).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  expect(resolveCommand).toBeDefined();
  expect(broker.listTargets()).toEqual([target]);
});

it('preserves a structured child-session error from the target executor', async () => {
  expect.assertions(1);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, {
    async execute() {
      throw Object.assign(new Error('The child session was replaced.'), {
        code: 'SESSION_NOT_FOUND',
        details: { sessionId: '80000000-0000-4000-8000-000000000001' },
        retryable: true,
      });
    },
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });

  await expect(broker.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000014',
    sessionId: '80000000-0000-4000-8000-000000000001',
    targetGeneration: target.generation,
    targetId: target.id,
  })).rejects.toMatchObject({
    code: 'SESSION_NOT_FOUND',
    details: { sessionId: '80000000-0000-4000-8000-000000000001' },
    retryable: true,
  });
});

it('delivers bounded matching events with opaque sequence numbers and closes on revocation', async () => {
  expect.assertions(5);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const subscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' });
  broker.publishEvent(target, 'Network.requestWillBeSent', {});
  const iterator = subscription[Symbol.asyncIterator]();
  const event = await iterator.next();
  broker.revokeTarget(target.id, target.generation);

  expect(event).toMatchObject({
    done: false,
    value: {
      method: 'Runtime.consoleAPICalled',
      sequence: 1,
      subscriptionId: subscription.id,
    },
  });
  expect(event.done ? [] : Object.keys(event.value)).not.toContain('sessionId');
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(broker.listTargets()).toEqual([]);
  expect(subscription.id).toMatch(/^[0-9a-f-]{36}$/u);
});

it('reports overflow and retains the newest event for a drop-oldest subscription', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const subscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});
  const event = await subscription[Symbol.asyncIterator]().next();

  expect(subscription.overflowed).toBe(true);
  expect(event).toMatchObject({
    done: false,
    value: { method: 'Runtime.consoleAPICalled', sequence: 2 },
  });
  expect(Object.keys(event.done ? {} : event.value)).not.toContain('sessionId');
});

it('filters event payloads, flushes independent batches, and records drop-newest overflow', async () => {
  expect.assertions(6);
  vi.useFakeTimers();
  try {
    const broker = createTargetBroker();
    broker.publishTarget(target);
    const lease = broker.acquireLease({
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Runtime.consoleAPICalled'],
      targetGeneration: target.generation,
      targetId: target.id,
    });
    const sessionId = '80000000-0000-4000-8000-000000000001';
    const subscription = await broker.subscribe({
      batch: { flushMilliseconds: 10, maximumEvents: 1 },
      buffer: { capacity: 1, overflowStrategy: 'drop-newest' },
      leaseId: lease.id,
      match: { domain: 'Runtime' },
      predicate: { equals: 'log', path: ['type'] },
      sessionId,
      targetGeneration: target.generation,
      targetId: target.id,
    });
    broker.publishEvent(
      target,
      'Runtime.consoleAPICalled',
      { type: 'warning' },
      sessionId,
    );
    broker.publishEvent(
      target,
      'Runtime.consoleAPICalled',
      { type: 'log' },
      '80000000-0000-4000-8000-000000000002',
    );
    broker.publishEvent(
      target,
      'Runtime.consoleAPICalled',
      { type: 'log' },
      sessionId,
    );
    const event = subscription[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(10);

    expect(await event).toMatchObject({
      done: false,
      value: { parameters: { type: 'log' }, sequence: 1 },
    });
    expect(subscription.droppedCount).toBe(0);
    broker.publishEvent(
      target,
      'Runtime.consoleAPICalled',
      { type: 'log' },
      sessionId,
    );
    broker.publishEvent(
      target,
      'Runtime.consoleAPICalled',
      { type: 'log' },
      sessionId,
    );
    expect(subscription.overflowed).toBe(true);
    expect(subscription.droppedCount).toBe(1);
    expect(subscription.lastDeliveredSequence).toBe(1);
    expect(
      (await subscription[Symbol.asyncIterator]().next()).value,
    ).toMatchObject({ sequence: 2 });
  } finally {
    vi.useRealTimers();
  }
});

it('disconnects a saturated subscriber without affecting independent subscribers', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const disconnected = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'disconnect' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const healthy = await broker.subscribe({
    buffer: { capacity: 2, overflowStrategy: 'drop-oldest' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});

  expect(disconnected.droppedCount).toBe(1);
  expect(await disconnected[Symbol.asyncIterator]().next()).toEqual({
    done: true,
    value: undefined,
  });
  expect((await healthy[Symbol.asyncIterator]().next()).value).toMatchObject({
    sequence: 1,
  });
});

it('returns subscription demand to the extension executor when the client closes', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const setSubscriptionDemand = vi.fn(async () => {});
  broker.registerTargetExecutor(target, {
    async execute() {
      return {};
    },
    setSubscriptionDemand,
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const subscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'disconnect' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  subscription.close();

  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    1,
    'Runtime.consoleAPICalled',
    true,
  );
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    2,
    'Runtime.consoleAPICalled',
    false,
  );
});

it('tracks distinct event demands within the same CDP domain', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const setSubscriptionDemand = vi.fn(async () => {});
  broker.registerTargetExecutor(target, {
    async execute() {
      return {};
    },
    setSubscriptionDemand,
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.bindingCalled', 'Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const bindingSubscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
    leaseId: lease.id,
    match: { method: 'Runtime.bindingCalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const consoleSubscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'drop-oldest' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  });

  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    1,
    'Runtime.bindingCalled',
    true,
  );
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    2,
    'Runtime.consoleAPICalled',
    true,
  );
  bindingSubscription.close();
  consoleSubscription.close();
  await Promise.resolve();
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    3,
    'Runtime.bindingCalled',
    false,
  );
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    4,
    'Runtime.consoleAPICalled',
    false,
  );
});

it('routes subscription demand through an opaque child session', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  const setSubscriptionDemand = vi.fn(async () => {});
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, {
    async execute() {
      return {};
    },
    setSubscriptionDemand,
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const sessionId = '80000000-0000-4000-8000-000000000001';
  const subscription = await broker.subscribe({
    buffer: { capacity: 1, overflowStrategy: 'disconnect' },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    sessionId,
    targetGeneration: target.generation,
    targetId: target.id,
  });
  subscription.close();
  await Promise.resolve();

  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    1,
    'Runtime.consoleAPICalled',
    true,
    sessionId,
  );
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(
    2,
    'Runtime.consoleAPICalled',
    false,
    sessionId,
  );
});

it('reference-counts domain demand and reconciles activation failures and revocation', async () => {
  expect.assertions(7);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const setSubscriptionDemand = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValue(undefined);
  broker.registerTargetExecutor(target, {
    async execute() {
      return {};
    },
    setSubscriptionDemand,
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.consoleAPICalled'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const request = {
    buffer: { capacity: 1, overflowStrategy: 'disconnect' as const },
    leaseId: lease.id,
    match: { method: 'Runtime.consoleAPICalled' },
    targetGeneration: target.generation,
    targetId: target.id,
  };

  await expect(broker.subscribe(request)).rejects.toMatchObject({
    code: 'CDP_COMMAND_FAILED',
  });
  const first = await broker.subscribe(request);
  const second = await broker.subscribe(request);
  expect(setSubscriptionDemand).toHaveBeenCalledTimes(2);
  expect(setSubscriptionDemand).toHaveBeenLastCalledWith(
    'Runtime.consoleAPICalled',
    true,
  );
  first.close();
  expect(setSubscriptionDemand).toHaveBeenCalledTimes(2);
  second.close();
  await Promise.resolve();
  expect(setSubscriptionDemand).toHaveBeenLastCalledWith(
    'Runtime.consoleAPICalled',
    false,
  );
  const active = await broker.subscribe(request);
  broker.revokeTarget(target.id, target.generation);
  await Promise.resolve();
  expect(active.droppedCount).toBe(0);
  expect(setSubscriptionDemand).toHaveBeenLastCalledWith(
    'Runtime.consoleAPICalled',
    false,
  );
});

it('applies a tighter buffer limit to stateful subscription domains', async () => {
  expect.assertions(1);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Tracing.tracingComplete'],
    targetGeneration: target.generation,
    targetId: target.id,
  });

  await expect(
    broker.subscribe({
      buffer: { capacity: 17, overflowStrategy: 'drop-oldest' },
      leaseId: lease.id,
      match: { method: 'Tracing.tracingComplete' },
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
});

it('rejects commands carrying the stale generation after a target is republished', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.revokeTarget(target.id, target.generation);
  broker.publishTarget({ ...target, generation: 2 });

  await expect(
    broker.executeCommand({
      leaseId: lease.id,
      method: 'Runtime.evaluate',
      operationId: '30000000-0000-4000-8000-000000000005',
      targetGeneration: target.generation,
      targetId: target.id,
    }),
  ).rejects.toMatchObject({ code: 'TARGET_GENERATION_STALE' });
  expect(broker.listTargets()).toEqual([{ ...target, generation: 2 }]);
});

it('aborts an in-flight command when its target is revoked', async () => {
  expect.assertions(1);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, {
    async execute(_command, abortSignal) {
      return new Promise(resolve =>
        abortSignal.addEventListener('abort', () => resolve({}), {
          once: true,
        }),
      );
    },
  });
  const lease = broker.acquireLease({
    durationMilliseconds: 1_000,
    mode: 'exclusive-control',
    requestedMethods: ['Runtime.evaluate'],
    targetGeneration: target.generation,
    targetId: target.id,
  });
  const command = broker.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000006',
    targetGeneration: target.generation,
    targetId: target.id,
  });
  broker.revokeTarget(target.id, target.generation);
  await expect(command).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
});

it('routes automation through one target-owner provider with scoped handles and CDP instrumentation', async () => {
  expect.assertions(15);
  const broker = createTargetBroker();
  const agentAuthority = { principalId: 'extension-provider-installation' };
  const clientAuthority = {
    connectionId: 'embedding-host-session-1',
    principalId: 'mcp-principal-1',
    targetGrants: [
      { bindingId: 'binding-1', capabilities: { level: 'interact' as const }, targetGeneration: target.generation, targetId: target.id },
    ],
  };
  const execute = vi.fn(async (command: CdpCommand) => ({
    method: command.method,
  }));
  const setSubscriptionDemand = vi.fn(async () => {});
  const receivedEvents: string[] = [];
  const providerOperations: unknown[] = [];
  const provider: AutomationProvider = {
    descriptor: {
      capabilities: {
        actions: ['click'],
        operations: ['action', 'snapshot'],
        snapshotModes: ['interactive'],
      },
      id: 'playwright',
      version: '1.62.1',
    },
    dispose: vi.fn(),
    async execute(request, context) {
      providerOperations.push(request.operation);
      if (request.operation.kind === 'snapshot') {
        context.onCdpEvent(event => receivedEvents.push(event.method));
        await context.setDomainDemand('DOM', true);
        const value = await context.executeCdp('DOM.getDocument');
        return {
          elements: [{ handle: 'playwright-element-1', metadata: { role: 'cell' } }],
          snapshotId: 'playwright-snapshot-1',
          value,
        };
      }
      if (request.operation.kind !== 'action')
        throw new Error('The test provider only supports snapshots and actions.');
      if (request.operation.elementHandleId === undefined)
        throw new Error('The test action requires an element handle.');
      return { value: { handled: request.operation.elementHandleId } };
    },
  };
  broker.publishTarget(target, agentAuthority);
  broker.registerTargetExecutor(
    target,
    { execute, setSubscriptionDemand },
    agentAuthority,
  );
  broker.registerAutomationProvider(provider, agentAuthority);
  const lease = broker.acquireLease(
    {
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: [],
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  );
  const snapshot = await broker.executeAutomation(
    {
      leaseId: lease.id,
      operation: {
        kind: 'snapshot',
        maximumDepth: 10,
        maximumNodes: 100,
        mode: 'interactive',
      },
      operationId: '30000000-0000-4000-8000-000000000030',
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  );
  const elementHandleId = snapshot.elements?.[0]?.id;
  if (elementHandleId === undefined)
    throw new Error('The provider did not return an element handle.');
  broker.publishEvent(target, 'DOM.documentUpdated', {});
  const action = await broker.executeAutomation(
    {
      leaseId: lease.id,
      operation: {
        action: 'click',
        button: 'left',
        clickCount: 1,
        elementHandleId,
        kind: 'action',
      },
      operationId: '30000000-0000-4000-8000-000000000031',
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  );

  expect(snapshot.provider).toEqual(provider.descriptor);
  expect(snapshot.snapshotId).toBe('playwright-snapshot-1');
  expect(snapshot.elements?.[0]?.metadata).toEqual({ role: 'cell' });
  expect(snapshot.metrics.cdpCommandCount).toBe(1);
  expect(snapshot.metrics.totalDurationMilliseconds).toBeGreaterThanOrEqual(0);
  expect(snapshot.metrics.providerDurationMilliseconds).toBeGreaterThanOrEqual(0);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'DOM.getDocument' }),
    expect.any(AbortSignal),
    { ...lease, methods: ['DOM.getDocument'] },
  );
  expect(setSubscriptionDemand).toHaveBeenCalledWith('DOM.', true);
  expect(receivedEvents).toEqual(['DOM.documentUpdated']);
  expect(action.value).toEqual({ handled: 'playwright-element-1' });
  expect(providerOperations).toEqual([
    expect.objectContaining({ kind: 'snapshot' }),
    expect.objectContaining({
      elementHandleId: 'playwright-element-1',
      kind: 'action',
    }),
  ]);
  expect(elementHandleId).toEqual(expect.any(String));
  expect(elementHandleId).not.toBe('playwright-element-1');
  expect(action.metrics.cdpCommandCount).toBe(0);
  expect(provider.dispose).not.toHaveBeenCalled();
});

it('preserves structured automation-provider failures', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  const agentAuthority = { principalId: 'extension-provider-installation' };
  const clientAuthority = {
    connectionId: 'embedding-host-session-1',
    principalId: 'mcp-principal-1',
    targetGrants: [
      { bindingId: 'binding-1', capabilities: { level: 'interact' as const }, targetGeneration: target.generation, targetId: target.id },
    ],
  };
  const provider: AutomationProvider = {
    descriptor: {
      capabilities: {
        actions: ['click'],
        operations: ['action'],
        snapshotModes: [],
      },
      id: 'playwright',
      version: '1.62.1',
    },
    dispose() {},
    async execute() {
      throw new AutomationProviderError(
        'AUTOMATION_ELEMENT_COVERED',
        'Another element intercepts pointer events.',
        { selector: 'internal:role=button' },
        true,
      );
    },
  };
  broker.publishTarget(target, agentAuthority);
  broker.registerTargetExecutor(target, { execute: vi.fn(async () => ({})) }, agentAuthority);
  broker.registerAutomationProvider(provider, agentAuthority);
  const lease = broker.acquireLease(
    {
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: [],
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  );

  const result = broker.executeAutomation(
    {
      leaseId: lease.id,
      operation: { action: 'click', button: 'left', clickCount: 1, kind: 'action', locator: { role: 'button' } },
      operationId: '30000000-0000-4000-8000-000000000035',
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  );

  await expect(result).rejects.toMatchObject({
    code: 'CDP_COMMAND_FAILED',
    details: {
      automationCode: 'AUTOMATION_ELEMENT_COVERED',
      providerId: 'playwright',
      selector: 'internal:role=button',
    },
    retryable: true,
  });
  await expect(result).rejects.toThrow('Another element intercepts pointer events.');
  expect(provider.descriptor.id).toBe('playwright');
});

it('fences automation cancellation, forbidden provider commands, replacement, and generation renewal', async () => {
  expect.assertions(9);
  const broker = createTargetBroker();
  const agentAuthority = { principalId: 'extension-provider-installation' };
  const clientAuthority = {
    connectionId: 'embedding-host-session-1',
    principalId: 'mcp-principal-1',
    targetGrants: [
      { bindingId: 'binding-1', capabilities: { level: 'interact' as const }, targetGeneration: target.generation, targetId: target.id },
    ],
  };
  const provider: AutomationProvider = {
    descriptor: {
      capabilities: {
        actions: ['click'],
        operations: ['action', 'snapshot'],
        snapshotModes: ['interactive'],
      },
      id: 'playwright',
      version: '1.62.1',
    },
    dispose: vi.fn(),
    async execute(request, context) {
      if (request.operation.kind === 'snapshot') {
        await context.executeCdp('Target.attachToTarget');
        return { value: {} };
      }
      return new Promise((_resolve, reject) => {
        context.abortSignal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      });
    },
    invalidateTarget: vi.fn(),
  };
  broker.publishTarget(target, agentAuthority);
  broker.registerTargetExecutor(target, { execute: vi.fn(async () => ({})) }, agentAuthority);
  broker.registerAutomationProvider(provider, agentAuthority);
  const lease = broker.acquireLease(
    {
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: [],
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  );
  await expect(broker.executeAutomation(
    {
      leaseId: lease.id,
      operation: {
        kind: 'snapshot',
        maximumDepth: 10,
        maximumNodes: 100,
        mode: 'interactive',
      },
      operationId: '30000000-0000-4000-8000-000000000032',
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  const pending = broker.executeAutomation(
    {
      leaseId: lease.id,
      operation: {
        action: 'click',
        button: 'left',
        clickCount: 1,
        kind: 'action',
        locator: { text: { exact: true, pattern: 'Save' } },
      },
      operationId: '30000000-0000-4000-8000-000000000033',
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  );
  broker.cancelAutomation(
    '30000000-0000-4000-8000-000000000033',
    clientAuthority,
  );
  await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  broker.revokeTarget(target.id, target.generation, 'detached', agentAuthority);

  expect(provider.invalidateTarget).toHaveBeenCalledWith(target);
  expect(provider.dispose).not.toHaveBeenCalled();
  broker.publishTarget({ ...target, generation: 2 }, agentAuthority);
  broker.registerTargetExecutor(
    { generation: 2, id: target.id },
    { execute: vi.fn(async () => ({})) },
    agentAuthority,
  );
  await expect(broker.executeAutomation(
    {
      leaseId: lease.id,
      operation: {
        action: 'click',
        button: 'left',
        clickCount: 1,
        kind: 'action',
        locator: { text: { pattern: 'Save' } },
      },
      operationId: '30000000-0000-4000-8000-000000000034',
      targetGeneration: target.generation,
      targetId: target.id,
    },
    clientAuthority,
  )).rejects.toMatchObject({ code: 'TARGET_GENERATION_STALE' });
  broker.unregisterAutomationProvider(agentAuthority);

  expect(provider.dispose).toHaveBeenCalledOnce();
  expect(provider.invalidateTarget).toHaveBeenCalledOnce();
  expect(broker.listTargets()).toEqual([{ ...target, generation: 2 }]);
  expect(() => broker.unregisterAutomationProvider(agentAuthority)).not.toThrow();
});

it('disposes the client binding when a late reply cannot be delivered', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  const disconnected = vi.spyOn(broker, 'disconnectClient');
  let listener: ((message: ClientToBrokerMessage) => void) | undefined;
  const disconnect = connectClientTargetBroker({
    onMessage(received) {
      listener = received;
      return () => {
        listener = undefined;
      };
    },
    async send(message) {
      if (message.kind !== 'notification') throw new Error('The client transport closed before its reply.');
    },
  }, broker);
  try {
    listener!({ kind: 'request', method: 'targets.list', parameters: {}, protocolVersion: 1, requestId: '70000000-0000-4000-8000-000000000099' });
    await vi.waitUntil(() => disconnected.mock.calls.length > 0);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(listener).toBeUndefined();
  } finally {
    disconnect();
    broker.dispose();
  }
});
