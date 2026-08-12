import type { AgentToBrokerMessage, BrokerToAgentMessage, BrokerToClientMessage, CdpCommand, ClientToBrokerMessage, PublishedTarget } from '../src/protocol.js';

import { expect, it, vi } from 'vitest';

import { createTargetBroker } from '../src/broker.js';
import { createChromeDebuggerBridgeClient } from '../src/client.js';
import { connectAgentTargetBroker, connectClientTargetBroker } from '../src/index.js';
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

function completeAgentHello(listener: ((message: AgentToBrokerMessage) => void) | undefined): void {
  listener?.({
    kind: 'request',
    method: 'agent.hello',
    parameters: {
      connectionGeneration: 1,
      features: [],
      heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
      implementation: { instanceId: '60000000-0000-4000-8000-000000000099', name: 'target-directory-test', role: 'agent', version: '0.0.0' },
      limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 16_384 },
      protocolVersions: { maximum: 1, minimum: 1 },
    },
    protocolVersion: 1,
    requestId: '60000000-0000-4000-8000-000000000098',
  });
}

it('lists only opaque targets published by the agent', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  const client = createChromeDebuggerBridgeClient(broker);

  broker.publishTarget(target);
  const targets = await client.listTargets();
  broker.revokeTarget(target.id, target.generation);

  expect(targets).toEqual([target]);
  expect(Object.keys(targets[0] ?? {})).not.toContain('tabId');
  expect(await client.listTargets()).toEqual([]);
});

it('keeps leases principal-owned across reconnect grace while isolating connections', async () => {
  expect.assertions(6);
  vi.useFakeTimers();
  try {
    const broker = createTargetBroker({ reconnectGraceMilliseconds: 5_000 });
    const firstConnection = { connectionId: 'first', principalId: 'principal-a' };
    const secondConnection = { connectionId: 'second', principalId: 'principal-a' };
    const otherPrincipal = { connectionId: 'other', principalId: 'principal-b' };
    broker.publishTarget(target);
    broker.connectClient(firstConnection);
    const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }, firstConnection);
    expect(() => broker.renewLease({ durationMilliseconds: 1_000, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id }, otherPrincipal)).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
    broker.disconnectClient(firstConnection);
    expect(() => broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }, otherPrincipal)).toThrowError(expect.objectContaining({ code: 'LEASE_CONFLICT' }));
    broker.connectClient(secondConnection);
    expect(broker.renewLease({ durationMilliseconds: 1_000, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id }, secondConnection).id).toBe(lease.id);
    broker.disconnectClient(secondConnection);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(() => broker.renewLease({ durationMilliseconds: 1_000, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id }, secondConnection)).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
    broker.connectClient(firstConnection);
    const immediateLease = broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id }, firstConnection);
    broker.disconnectClient(firstConnection);
    expect(immediateLease.id).toMatch(/^[0-9a-f-]{36}$/u);
    broker.dispose();
    const immediateBroker = createTargetBroker({ reconnectGraceMilliseconds: 0 });
    immediateBroker.publishTarget(target);
    immediateBroker.connectClient(firstConnection);
    const zeroGraceLease = immediateBroker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id }, firstConnection);
    immediateBroker.disconnectClient(firstConnection);
    expect(() => immediateBroker.renewLease({ durationMilliseconds: 1_000, leaseId: zeroGraceLease.id, targetGeneration: target.generation, targetId: target.id }, firstConnection)).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
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
    const lease = broker.acquireLease({ durationMilliseconds: 10, requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
    const subscription = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
    await vi.advanceTimersByTimeAsync(10);
    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined });
  } finally {
    vi.useRealTimers();
  }
});

it('orders target changes and starts every watcher from a fresh snapshot', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  const watcher = broker.watchTargets()[Symbol.asyncIterator]();
  broker.publishTarget(target);
  broker.updateTarget({ ...target, title: 'Changed title' });
  broker.revokeTarget(target.id, target.generation, 'closed');

  expect(await watcher.next()).toEqual({ done: false, value: { kind: 'snapshot', sequence: 0, targets: [] } });
  expect(await watcher.next()).toMatchObject({ done: false, value: { kind: 'published', sequence: 1, target } });
  expect(await watcher.next()).toMatchObject({ done: false, value: { kind: 'updated', sequence: 2, target: { title: 'Changed title' } } });
  expect(await watcher.next()).toEqual({ done: false, value: { kind: 'revoked', reason: 'closed', sequence: 3, targetGeneration: 1, targetId: target.id } });
});

it('reconciles agent state without accepting a stale target generation', () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget({ ...target, generation: 2 });
  broker.reconcileTargets([{ ...target, generation: 3, title: 'Reconnected target' }]);

  expect(broker.listTargets()).toEqual([{ ...target, generation: 3, title: 'Reconnected target' }]);
  broker.revokeTarget(target.id, 3);
  expect(() => broker.reconcileTargets([target])).toThrowError('The requested target operation is not available.');
  expect(broker.listTargets()).toEqual([]);
});

it('applies authenticated agent lifecycle notifications to the broker', () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  const disconnect = connectAgentTargetBroker({ onMessage(receivedListener) {
    listener = receivedListener;
    return () => listener = undefined;
  } }, broker);

  completeAgentHello(listener);
  listener?.({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
  expect(broker.listTargets()).toEqual([target]);
  listener?.({ kind: 'notification', method: 'targets.reconcile', parameters: { targets: [] }, protocolVersion: 1 });
  expect(broker.listTargets()).toEqual([]);
  disconnect();
});

it('rejects agent traffic until one matching hello completes', () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  let listener: ((message: AgentToBrokerMessage) => void) | undefined;
  let closeCode: number | undefined;
  const disconnect = connectAgentTargetBroker({
    close(code) {
      closeCode = code;
    },
    onMessage(receivedListener) {
      listener = receivedListener;
      return () => listener = undefined;
    },
  }, broker);

  listener?.({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
  expect(broker.listTargets()).toEqual([]);
  expect(closeCode).toBe(1008);
  completeAgentHello(listener);
  listener?.({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
  expect(broker.listTargets()).toEqual([]);
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
  connectAgentTargetBroker({
    closed,
    onMessage(receivedListener) {
      listener = receivedListener;
      return () => listener = undefined;
    },
  }, broker);

  completeAgentHello(listener);
  listener?.({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
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
  const disconnect = connectAgentTargetBroker({
    onMessage(receivedListener) {
      listener = receivedListener;
      return () => listener = undefined;
    },
    async send(message) {
      sentMessages.push(message);
    },
  }, broker);

  completeAgentHello(listener);
  listener?.({ kind: 'notification', method: 'targets.publish', parameters: { target }, protocolVersion: 1 });
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate', 'Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  const subscription = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  const execution = broker.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000010', parameters: { expression: 'document.title' }, targetGeneration: target.generation, targetId: target.id });
  const request = sentMessages.find((message): message is Extract<BrokerToAgentMessage, { readonly kind: 'request'; readonly method: 'cdp.execute' }> => message.kind === 'request' && message.method === 'cdp.execute');
  listener?.({ kind: 'response', method: 'cdp.execute', protocolVersion: 1, requestId: request!.requestId, result: { operationId: '30000000-0000-4000-8000-000000000010', value: { result: 'Bridge target' } } });
  listener?.({ kind: 'notification', method: 'cdp.event', parameters: { method: 'Runtime.consoleAPICalled', parameters: { type: 'log' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1 });

  expect(request?.parameters.command.targetId).toBe(target.id);
  expect(request?.parameters.lease.id).toBe(lease.id);
  await expect(execution).resolves.toEqual({ operationId: '30000000-0000-4000-8000-000000000010', value: { result: 'Bridge target' } });
  expect(await subscription[Symbol.asyncIterator]().next()).toMatchObject({ done: false, value: { method: 'Runtime.consoleAPICalled', parameters: { type: 'log' } } });
  expect(JSON.stringify(sentMessages)).not.toContain('tabId');
  expect(listener).toBeDefined();
  disconnect();
});

it('streams a fresh target snapshot followed by ordered lifecycle notifications to a client', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  const messages: BrokerToClientMessage[] = [];
  let resolveFourthMessage: (() => void) | undefined;
  const fourthMessage = new Promise<void>(resolve => resolveFourthMessage = resolve);
  const disconnect = connectClientTargetBroker({ async send(message) {
    messages.push(message);
    if (messages.length === 4) resolveFourthMessage?.();
  } }, broker);

  broker.publishTarget(target);
  broker.updateTarget({ ...target, title: 'Updated title' });
  broker.revokeTarget(target.id, target.generation, 'closed');
  await fourthMessage;
  disconnect();

  expect(messages[0]).toEqual({ kind: 'notification', method: 'targets.snapshot', parameters: { sequence: 0, targets: [] }, protocolVersion: 1 });
  expect(messages[1]).toMatchObject({ method: 'targets.published', parameters: { target } });
  expect(messages[2]).toMatchObject({ method: 'targets.updated', parameters: { target: { title: 'Updated title' } } });
  expect(messages[3]).toEqual({ kind: 'notification', method: 'targets.revoked', parameters: { reason: 'closed', targetGeneration: 1, targetId: target.id }, protocolVersion: 1 });
});

it('serves independent subscription responses and event streams over the client-plane connection', async () => {
  expect.assertions(4);
  const broker = createTargetBroker();
  const messages: BrokerToClientMessage[] = [];
  let listener: ((message: ClientToBrokerMessage) => void) | undefined;
  let resolveSubscribed: (() => void) | undefined;
  let resolveEvent: (() => void) | undefined;
  let resolveUnsubscribed: (() => void) | undefined;
  const subscribed = new Promise<void>(resolve => resolveSubscribed = resolve);
  const eventDelivered = new Promise<void>(resolve => resolveEvent = resolve);
  const unsubscribed = new Promise<void>(resolve => resolveUnsubscribed = resolve);
  const disconnect = connectClientTargetBroker({
    onMessage(receivedListener) {
      listener = receivedListener;
      return () => listener = undefined;
    },
    async send(message) {
      messages.push(message);
      if (message.kind === 'response' && message.method === 'cdp.subscribe') resolveSubscribed?.();
      if (message.kind === 'response' && message.method === 'cdp.unsubscribe') resolveUnsubscribed?.();
      if (message.kind === 'notification' && message.method === 'cdp.event') resolveEvent?.();
    },
  }, broker);
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  listener?.({
    kind: 'request',
    method: 'cdp.subscribe',
    parameters: { buffer: { capacity: 1, overflowStrategy: 'disconnect' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id },
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000001',
  });
  await subscribed;
  broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' });
  await eventDelivered;
  const response = messages.find(message => message.kind === 'response' && message.method === 'cdp.subscribe');
  const event = messages.find(message => message.kind === 'notification' && message.method === 'cdp.event');
  const subscriptionId = response?.kind === 'response' && response.method === 'cdp.subscribe' ? response.result.subscriptionId : undefined;
  listener?.({ kind: 'request', method: 'cdp.unsubscribe', parameters: { subscriptionId: subscriptionId! }, protocolVersion: 1, requestId: '70000000-0000-4000-8000-000000000002' });
  await unsubscribed;
  disconnect();

  expect(subscriptionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(event).toMatchObject({ parameters: { method: 'Runtime.consoleAPICalled', parameters: { type: 'log' } } });
  expect(messages.some(message => message.kind === 'response' && message.method === 'cdp.unsubscribe')).toBe(true);
  expect(listener).toBeUndefined();
});

it('serves target listing, leases, and authorized commands over the client-plane connection', async () => {
  expect.assertions(5);
  const broker = createTargetBroker();
  const messages: BrokerToClientMessage[] = [];
  let listener: ((message: ClientToBrokerMessage) => void) | undefined;
  let resolveResponse: ((message: BrokerToClientMessage) => void) | undefined;
  const disconnect = connectClientTargetBroker({
    onMessage(receivedListener) {
      listener = receivedListener;
      return () => listener = undefined;
    },
    async send(message) {
      messages.push(message);
      resolveResponse?.(message);
    },
  }, broker);
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, { async execute(command) {
    return { result: command.parameters?.expression ?? '' };
  } });
  const waitForResponse = async (method: Extract<BrokerToClientMessage, { readonly kind: 'response' }>['method']): Promise<Extract<BrokerToClientMessage, { readonly kind: 'response' }>> => new Promise((resolve) => {
    resolveResponse = (message) => {
      if (message.kind === 'response' && message.method === method) {
        resolveResponse = undefined;
        resolve(message);
      }
    };
  });

  const listed = waitForResponse('targets.list');
  listener?.({ kind: 'request', method: 'targets.list', parameters: {}, protocolVersion: 1, requestId: '70000000-0000-4000-8000-000000000020' });
  const listedResponse = await listed;
  const acquired = waitForResponse('leases.acquire');
  listener?.({ kind: 'request', method: 'leases.acquire', parameters: { durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: '70000000-0000-4000-8000-000000000021' });
  const acquiredResponse = await acquired;
  const lease = acquiredResponse.kind === 'response' && acquiredResponse.method === 'leases.acquire' ? acquiredResponse.result.lease : undefined;
  const executed = waitForResponse('cdp.send');
  listener?.({ kind: 'request', method: 'cdp.send', parameters: { leaseId: lease!.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000020', parameters: { expression: 'document.title' }, targetGeneration: target.generation, targetId: target.id }, protocolVersion: 1, requestId: '70000000-0000-4000-8000-000000000022' });
  const executedResponse = await executed;
  disconnect();

  expect(listedResponse).toMatchObject({ result: { targets: [{ id: target.id }] } });
  expect(lease?.mode).toBe('exclusive-control');
  expect(executedResponse).toMatchObject({ result: { operationId: '30000000-0000-4000-8000-000000000020', value: { result: 'document.title' } } });
  expect(JSON.stringify(messages)).not.toContain('tabId');
  expect(listener).toBeUndefined();
});

it('executes only a non-expired lease grant through the registered opaque target executor', async () => {
  expect.assertions(6);
  let currentTime = Date.parse('2026-08-04T12:00:00.000Z');
  const broker = createTargetBroker({ now: () => currentTime });
  const client = createChromeDebuggerBridgeClient(broker);
  broker.publishTarget(target);
  const execute = vi.fn(async (command: CdpCommand) => ({ expression: command.parameters?.expression ?? '' }));
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

  expect(result).toEqual({ operationId: '30000000-0000-4000-8000-000000000001', value: { expression: 'document.title' } });
  expect(execute).toHaveBeenCalledOnce();
  await expect(client.acquireLease({
    durationMilliseconds: 1,
    requestedMethods: ['Page.navigate'],
    targetGeneration: target.generation,
    targetId: target.id,
  })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  await expect(client.executeCommand({
    leaseId: lease.id,
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000002',
    targetGeneration: target.generation,
    targetId: target.id,
  })).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  await expect(client.executeCommand({
    leaseId: globalThis.crypto.randomUUID(),
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000003',
    targetGeneration: target.generation,
    targetId: target.id,
  })).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  expect(Object.keys(result.value)).not.toContain('tabId');
});

it('externalizes large command results and invalidates their access with the target grant', async () => {
  expect.assertions(6);
  const broker = createTargetBroker({ artifactLifetimeMilliseconds: 1_000, maximumArtifactBytes: 100, maximumInlineResultBytes: 4 });
  const client = createChromeDebuggerBridgeClient(broker);
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, { async execute() {
    return { value: 'large result' };
  } });
  const lease = await client.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  const result = await client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000007', targetGeneration: target.generation, targetId: target.id });

  expect(result.value).toHaveProperty('artifact.mediaType', 'application/json');
  expect(result.value).not.toHaveProperty('artifact.path');
  const request = { artifactId: await artifactId(result.value), leaseId: lease.id, targetGeneration: target.generation, targetId: target.id };
  expect(await client.readArtifact(request)).toEqual(new TextEncoder().encode(JSON.stringify({ value: 'large result' })));
  expect(await client.readArtifact({ ...request, range: { length: 5, offset: 2 } })).toEqual(new TextEncoder().encode(JSON.stringify({ value: 'large result' })).slice(2, 7));
  await client.releaseArtifact(request);
  await expect(client.readArtifact(request)).rejects.toThrow('not available');
  const secondResult = await client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000008', targetGeneration: target.generation, targetId: target.id });
  broker.revokeTarget(target.id, target.generation);
  await expect(client.readArtifact({ ...request, artifactId: await artifactId(secondResult.value) })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
});

it('arbitrates shared reads and exclusive control, with renewal, release, expiry, and policy-reduction cleanup', () => {
  expect.assertions(8);
  let currentTime = Date.parse('2026-08-04T12:00:00.000Z');
  const broker = createTargetBroker({ now: () => currentTime });
  broker.publishTarget(target);
  const sharedReadLease = broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Network.canEmulateNetworkConditions'], targetGeneration: target.generation, targetId: target.id });
  const controllerLease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  const renewedLease = broker.renewLease({ durationMilliseconds: 2_000, leaseId: controllerLease.id, targetGeneration: target.generation, targetId: target.id });

  expect(sharedReadLease.mode).toBe('shared-read');
  expect(controllerLease.mode).toBe('exclusive-control');
  expect(renewedLease.expiresAt).toBe('2026-08-04T12:00:02.000Z');
  expect(() => broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id })).toThrowError(expect.objectContaining({ code: 'LEASE_CONFLICT' }));
  broker.releaseLease({ leaseId: controllerLease.id, targetGeneration: target.generation, targetId: target.id });
  expect(broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id }).mode).toBe('exclusive-control');
  currentTime += 1_000;
  expect(() => broker.renewLease({ durationMilliseconds: 1_000, leaseId: sharedReadLease.id, targetGeneration: target.generation, targetId: target.id })).toThrowError(expect.objectContaining({ code: 'LEASE_EXPIRED' }));
  const policyLease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  broker.updateTarget({ ...target, capabilities: { level: 'observe' } });
  expect(() => broker.renewLease({ durationMilliseconds: 1_000, leaseId: policyLease.id, targetGeneration: target.generation, targetId: target.id })).toThrowError(expect.objectContaining({ code: 'LEASE_REQUIRED' }));
  expect(broker.listTargets()).toEqual([{ ...target, capabilities: { level: 'observe' } }]);
});

it('compiles hierarchy and exact-name grants into catalogue-backed lease authority', () => {
  expect.assertions(6);
  const broker = createTargetBroker();
  const inspectTarget = { ...target, capabilities: { level: 'inspect' as const } };
  broker.publishTarget(inspectTarget);

  expect(broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['DOM.getDocument'], targetGeneration: target.generation, targetId: target.id }).mode).toBe('shared-read');
  expect(() => broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  broker.updateTarget({ ...inspectTarget, capabilities: { allow: ['Page.navigate'] } });
  expect(() => broker.acquireLease({ durationMilliseconds: 1_000, requestedMethods: ['Page.navigate'], targetGeneration: target.generation, targetId: target.id })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  const exactNameLease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Page.navigate'], targetGeneration: target.generation, targetId: target.id });
  expect(exactNameLease.mode).toBe('exclusive-control');
  broker.releaseLease({ leaseId: exactNameLease.id, targetGeneration: target.generation, targetId: target.id });
  broker.updateTarget({ ...inspectTarget, capabilities: { level: 'unsafe' } });
  expect(() => broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Target.attachToTarget'], targetGeneration: target.generation, targetId: target.id })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
  expect(broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Experimental.newCommand'], targetGeneration: target.generation, targetId: target.id }).mode).toBe('exclusive-control');
});

it('cancels a pending command and disposes its eventual response', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  let resolveCommand: ((value: { readonly result: string }) => void) | undefined;
  broker.registerTargetExecutor(target, {
    async execute() {
      return new Promise(resolve => resolveCommand = resolve);
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

it('delivers bounded matching events with opaque sequence numbers and closes on revocation', async () => {
  expect.assertions(5);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
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

  expect(event).toMatchObject({ done: false, value: { method: 'Runtime.consoleAPICalled', sequence: 1, subscriptionId: subscription.id } });
  expect(event.done ? [] : Object.keys(event.value)).not.toContain('sessionId');
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(broker.listTargets()).toEqual([]);
  expect(subscription.id).toMatch(/^[0-9a-f-]{36}$/u);
});

it('reports overflow and retains the newest event for a drop-oldest subscription', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  const subscription = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});
  const event = await subscription[Symbol.asyncIterator]().next();

  expect(subscription.overflowed).toBe(true);
  expect(event).toMatchObject({ done: false, value: { method: 'Runtime.consoleAPICalled', sequence: 2 } });
  expect(Object.keys(event.done ? {} : event.value)).not.toContain('sessionId');
});

it('filters event payloads, flushes independent batches, and records drop-newest overflow', async () => {
  expect.assertions(6);
  vi.useFakeTimers();
  try {
    const broker = createTargetBroker();
    broker.publishTarget(target);
    const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
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
    broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'warning' }, sessionId);
    broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' }, '80000000-0000-4000-8000-000000000002');
    broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' }, sessionId);
    const event = subscription[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(10);

    expect(await event).toMatchObject({ done: false, value: { parameters: { type: 'log' }, sequence: 1 } });
    expect(subscription.droppedCount).toBe(0);
    broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' }, sessionId);
    broker.publishEvent(target, 'Runtime.consoleAPICalled', { type: 'log' }, sessionId);
    expect(subscription.overflowed).toBe(true);
    expect(subscription.droppedCount).toBe(1);
    expect(subscription.lastDeliveredSequence).toBe(1);
    expect((await subscription[Symbol.asyncIterator]().next()).value).toMatchObject({ sequence: 2 });
  } finally {
    vi.useRealTimers();
  }
});

it('disconnects a saturated subscriber without affecting independent subscribers', async () => {
  expect.assertions(3);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  const disconnected = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'disconnect' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  const healthy = await broker.subscribe({ buffer: { capacity: 2, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});
  broker.publishEvent(target, 'Runtime.consoleAPICalled', {});

  expect(disconnected.droppedCount).toBe(1);
  expect(await disconnected[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
  expect((await healthy[Symbol.asyncIterator]().next()).value).toMatchObject({ sequence: 1 });
});

it('returns subscription demand to the extension executor when the client closes', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const setSubscriptionDemand = vi.fn(async () => {});
  broker.registerTargetExecutor(target, { async execute() {
    return {};
  }, setSubscriptionDemand });
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  const subscription = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'disconnect' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  subscription.close();

  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(1, 'Runtime.consoleAPICalled', true);
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(2, 'Runtime.consoleAPICalled', false);
});

it('routes subscription demand through an opaque child session', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  const setSubscriptionDemand = vi.fn(async () => {});
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, { async execute() {
    return {};
  }, setSubscriptionDemand });
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  const sessionId = '80000000-0000-4000-8000-000000000001';
  const subscription = await broker.subscribe({ buffer: { capacity: 1, overflowStrategy: 'disconnect' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, sessionId, targetGeneration: target.generation, targetId: target.id });
  subscription.close();
  await Promise.resolve();

  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(1, 'Runtime.consoleAPICalled', true, sessionId);
  expect(setSubscriptionDemand).toHaveBeenNthCalledWith(2, 'Runtime.consoleAPICalled', false, sessionId);
});

it('reference-counts domain demand and reconciles activation failures and revocation', async () => {
  expect.assertions(7);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const setSubscriptionDemand = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(undefined);
  broker.registerTargetExecutor(target, { async execute() {
    return {};
  }, setSubscriptionDemand });
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  const request = { buffer: { capacity: 1, overflowStrategy: 'disconnect' as const }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id };

  await expect(broker.subscribe(request)).rejects.toMatchObject({ code: 'CDP_COMMAND_FAILED' });
  const first = await broker.subscribe(request);
  const second = await broker.subscribe(request);
  expect(setSubscriptionDemand).toHaveBeenCalledTimes(2);
  expect(setSubscriptionDemand).toHaveBeenLastCalledWith('Runtime.consoleAPICalled', true);
  first.close();
  expect(setSubscriptionDemand).toHaveBeenCalledTimes(2);
  second.close();
  await Promise.resolve();
  expect(setSubscriptionDemand).toHaveBeenLastCalledWith('Runtime.consoleAPICalled', false);
  const active = await broker.subscribe(request);
  broker.revokeTarget(target.id, target.generation);
  await Promise.resolve();
  expect(active.droppedCount).toBe(0);
  expect(setSubscriptionDemand).toHaveBeenLastCalledWith('Runtime.consoleAPICalled', false);
});

it('applies a tighter buffer limit to stateful subscription domains', async () => {
  expect.assertions(1);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Tracing.tracingComplete'], targetGeneration: target.generation, targetId: target.id });

  await expect(broker.subscribe({ buffer: { capacity: 17, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Tracing.tracingComplete' }, targetGeneration: target.generation, targetId: target.id })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
});

it('rejects commands carrying the stale generation after a target is republished', async () => {
  expect.assertions(2);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  broker.revokeTarget(target.id, target.generation);
  broker.publishTarget({ ...target, generation: 2 });

  await expect(broker.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000005', targetGeneration: target.generation, targetId: target.id })).rejects.toMatchObject({ code: 'TARGET_GENERATION_STALE' });
  expect(broker.listTargets()).toEqual([{ ...target, generation: 2 }]);
});

it('aborts an in-flight command when its target is revoked', async () => {
  expect.assertions(1);
  const broker = createTargetBroker();
  broker.publishTarget(target);
  broker.registerTargetExecutor(target, { async execute(_command, abortSignal) {
    return new Promise(resolve => abortSignal.addEventListener('abort', () => resolve({}), { once: true }));
  } });
  const lease = broker.acquireLease({ durationMilliseconds: 1_000, mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  const command = broker.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000006', targetGeneration: target.generation, targetId: target.id });
  broker.revokeTarget(target.id, target.generation);
  await expect(command).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
});
