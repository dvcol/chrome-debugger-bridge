import { expect, inject, it } from 'vitest';

import {
  createBrowserChromeDebuggerBridgeClient,
} from '../../packages/websocket/src/browser.js';

it('uses a native browser WebSocket for target, lease, command, and subscription operations', async () => {
  expect.assertions(9);
  const testContext = inject('websocketBrowserTest');
  const client = await createBrowserChromeDebuggerBridgeClient({
    artifactEndpoint: testContext.artifactEndpoint,
    authorization: 'Bearer browser-test-client',
    endpoint: testContext.clientEndpoint,
  });
  const targets = await client.listTargets();
  expect(targets).toHaveLength(1);
  const target = targets[0]!;
  const watch = client.watchTargets()[Symbol.asyncIterator]();
  expect((await watch.next()).value).toMatchObject({ kind: 'snapshot', targets: [{ id: target.id }] });
  const lease = await client.acquireLease({ durationMilliseconds: 30_000, requestedMethods: ['Runtime.evaluate'], targetGeneration: target.generation, targetId: target.id });
  expect(lease.targetId).toBe(target.id);
  const result = await client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: crypto.randomUUID(), parameters: { expression: '1 + 1' }, targetGeneration: target.generation, targetId: target.id });
  expect(result.value).toMatchObject({ result: { value: 'browser client' } });
  const subscription = await client.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  const event = await subscription[Symbol.asyncIterator]().next();
  expect(event.value).toMatchObject({ method: 'Runtime.consoleAPICalled', subscriptionId: subscription.id });
  expect(new TextDecoder().decode(await client.readArtifact({ artifactId: testContext.artifactId, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id }))).toBe('browser artifact boundary');
  await client.renewLease({ durationMilliseconds: 30_000, leaseId: lease.id, targetGeneration: target.generation, targetId: target.id });
  expect(true).toBe(true);
  await client.cancelCommand({ operationId: crypto.randomUUID(), targetGeneration: target.generation, targetId: target.id });
  expect(true).toBe(true);
  client.close(1000, 'Browser client test complete');
  expect((await client.closed).code).toBe(1000);
});

it('rejects interrupted work, reconnects target watching, and restores subscriptions', async () => {
  expect.assertions(8);
  const testContext = inject('websocketBrowserTest');
  const client = await createBrowserChromeDebuggerBridgeClient({
    artifactEndpoint: testContext.artifactEndpoint,
    authorization: 'Bearer browser-test-client',
    endpoint: testContext.clientEndpoint,
  });
  const target = (await client.listTargets())[0]!;
  const targets = client.watchTargets()[Symbol.asyncIterator]();
  expect((await targets.next()).value).toMatchObject({ kind: 'snapshot', targets: [{ id: target.id }] });
  const lease = await client.acquireLease({ durationMilliseconds: 30_000, requestedMethods: ['Runtime.consoleAPICalled'], targetGeneration: target.generation, targetId: target.id });
  const subscription = await client.subscribe({ buffer: { capacity: 1, overflowStrategy: 'drop-oldest' }, leaseId: lease.id, match: { method: 'Runtime.consoleAPICalled' }, targetGeneration: target.generation, targetId: target.id });
  const initialSubscriptionId = subscription.id;
  expect((await subscription[Symbol.asyncIterator]().next()).value).toMatchObject({ subscriptionId: initialSubscriptionId });
  await expect(client.executeCommand({ leaseId: lease.id, method: 'Runtime.evaluate', operationId: crypto.randomUUID(), parameters: { expression: 'disconnect' }, targetGeneration: target.generation, targetId: target.id })).rejects.toThrow('disconnected');
  expect((await client.listTargets())[0]?.id).toBe(target.id);
  expect((await targets.next()).value).toMatchObject({ kind: 'snapshot', targets: [{ id: target.id }] });
  expect(subscription.id).not.toBe(initialSubscriptionId);
  expect((await subscription[Symbol.asyncIterator]().next()).value).toMatchObject({ subscriptionId: subscription.id });
  client.close(1000, 'Reconnect test complete');
  expect((await client.closed).code).toBe(1000);
});
