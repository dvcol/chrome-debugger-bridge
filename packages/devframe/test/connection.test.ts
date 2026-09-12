import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { CdbDevframeClient } from '../src/wire.js';

import { expect, it, vi } from 'vitest';

import { createCdbConnection } from '../src/connection.js';

const state: BrokerState = { revision: 1, providers: [], principals: [], requests: [], targets: [], grants: [], leases: [], scopes: [] };

function peer() {
  const handlers = new Map<string, (value: unknown) => void>();
  const call = vi.fn(async (_name: string, ..._arguments: unknown[]): Promise<unknown> => ({ ok: true, value: state }));
  const callEvent = vi.fn();
  const transport = {
    scope: () => ({ rpc: { call, callEvent, register: (definition: { name: string; handler: (value: unknown) => void }) => handlers.set(definition.name, definition.handler) } }),
    close: vi.fn(),
  };
  return { transport: transport as unknown as CdbDevframeClient, call, callEvent, handlers, close: transport.close };
}

it('shares a subscription and fences obsolete publications on replacement without closing either peer', async () => {
  expect.assertions(7);
  const first = peer();
  const second = peer();
  const connection = createCdbConnection();
  const listener = vi.fn();
  connection.attach(first.transport);
  const unsubscribe = await connection.watch(listener);
  const secondUnsubscribe = await connection.watch(vi.fn());
  expect(first.call.mock.calls.filter(([name]) => name === 'watch')).toHaveLength(1);
  const stalePublication = first.handlers.get('state-changed')!;
  connection.attach(second.transport);
  await vi.waitUntil(() => connection.current.revision === 1);
  stalePublication({ ...state, revision: 100 });
  expect(connection.current.revision).toBe(1);
  second.handlers.get('state-changed')!({ ...state, revision: 2 });
  expect(connection.current.revision).toBe(2);
  expect(first.call).toHaveBeenCalledWith('unwatch');
  unsubscribe();
  secondUnsubscribe();
  await connection.dispose();
  expect(connection.status).toBe('disposed');
  expect(first.close).not.toHaveBeenCalled();
  expect(second.close).not.toHaveBeenCalled();
});

it('cancels only the pending operation and keeps ordinary shared RPC usable', async () => {
  expect.assertions(5);
  const fixture = peer();
  const pending = Promise.withResolvers<unknown>();
  fixture.call.mockImplementation(async name => name === 'invoke' ? pending.promise : { ok: true, value: 'ordinary' });
  const connection = createCdbConnection();
  connection.attach(fixture.transport);
  const controller = new AbortController();
  const invocation = connection.invoke('browser.click', {}, controller.signal);
  await vi.waitUntil(() => fixture.call.mock.calls.some(([name]) => name === 'invoke'));
  controller.abort(new Error('Cancelled by caller'));
  await expect(invocation).rejects.toThrow('Cancelled by caller');
  expect(fixture.callEvent).toHaveBeenCalledWith('cancel', expect.any(String));
  expect(fixture.call.mock.calls.filter(([name]) => name === 'invoke')).toHaveLength(1);
  await expect(fixture.call('ordinary')).resolves.toEqual({ ok: true, value: 'ordinary' });
  pending.resolve({ ok: true, value: 'late result' });
  await connection.dispose();
  expect(fixture.close).not.toHaveBeenCalled();
});

it('does not dispatch after cancellation during session readiness', async () => {
  expect.assertions(3);
  const fixture = peer();
  const session = Promise.withResolvers<unknown>();
  fixture.call.mockImplementation(async name => name === 'session-connect' ? session.promise : { ok: true, value: state });
  const connection = createCdbConnection({ session: { credentialKey: 'principal-one' } });
  connection.attach(fixture.transport);
  expect(fixture.call).not.toHaveBeenCalled();
  const controller = new AbortController();
  const invocation = connection.invoke('browser.click', {}, controller.signal);
  await vi.waitUntil(() => fixture.call.mock.calls.some(([name]) => name === 'session-connect'));
  controller.abort();
  await expect(invocation).rejects.toThrow();
  expect(fixture.call.mock.calls.some(([name]) => name === 'invoke')).toBe(false);
  session.resolve({ ok: true, value: { sessionId: 'one', resumeToken: 'test' } });
  await connection.dispose();
});

it('can attach the same transport after disconnection and rejects obsolete results', async () => {
  expect.assertions(4);
  const fixture = peer();
  const pending = Promise.withResolvers<unknown>();
  fixture.call.mockImplementation(async name => name === 'invoke' ? pending.promise : { ok: true, value: state });
  const connection = createCdbConnection();
  connection.attach(fixture.transport);
  const invocation = connection.invoke('browser.click', {});
  await vi.waitUntil(() => fixture.call.mock.calls.some(([name]) => name === 'invoke'));
  connection.disconnected();
  await expect(invocation).rejects.toThrow('replaced or disconnected');
  expect(connection.status).toBe('disconnected');
  connection.attach(fixture.transport);
  await expect(connection.snapshot()).resolves.toEqual(state);
  pending.resolve({ ok: true, value: 'obsolete' });
  await connection.dispose();
  expect(fixture.close).not.toHaveBeenCalled();
});
