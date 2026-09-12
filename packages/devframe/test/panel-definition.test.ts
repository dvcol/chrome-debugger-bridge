import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlPanelClient } from '../src/panel.js';

import { expect, it, vi } from 'vitest';

import { createCdbPanel } from '../src/panel-definition.js';

vi.mock('@devframes/json-render/node', () => ({ createJsonRenderView: () => ({ update: vi.fn(), dispose: vi.fn() }) }));

const state: BrokerState = { revision: 1, providers: [], principals: [], requests: [], targets: [], grants: [], leases: [], scopes: [] };

function fixtureClient(revision: number) {
  let publish: (state: BrokerState) => void = () => {};
  const unsubscribe = vi.fn();
  const client: BrowserControlPanelClient = {
    snapshot: vi.fn(async () => ({ ...state, revision })),
    watch: vi.fn((listener: (state: BrokerState) => void) => {
      publish = listener;
      return unsubscribe;
    }),
    revokeScope: vi.fn(async () => {}),
    revokeGrant: vi.fn(async () => true),
    disconnectProvider: vi.fn(async () => true),
  };
  return { client, unsubscribe, publish: (revision: number) => publish({ ...state, revision }) };
}

function fixtureContext() {
  let value = { broker: state };
  const context = {
    rpc: { sharedState: { get: vi.fn() } },
    scope: () => ({ rpc: {
      register: vi.fn(),
      sharedState: vi.fn(async (_key: string, { initialValue }: { initialValue: typeof value }) => {
        value = initialValue;
        return { mutate: (mutate: (current: typeof value) => void) => mutate(value) };
      }),
    } }),
  };
  return { context: context as unknown as Parameters<ReturnType<typeof createCdbPanel>['definition']['setup']>[0], current: () => value.broker };
}

it('rebinds mounted presentation and rejects obsolete state after replacement or disabling', async () => {
  expect.assertions(7);
  const first = fixtureClient(1);
  const second = fixtureClient(2);
  const fixture = fixtureContext();
  const getClient = vi.fn(() => first.client);
  const panel = createCdbPanel({ client: getClient });
  expect(getClient).not.toHaveBeenCalled();
  await panel.definition.setup(fixture.context);
  expect(fixture.current().revision).toBe(1);
  await panel.setClient(second.client);
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  first.publish(100);
  expect(fixture.current().revision).toBe(2);
  await panel.setClient(undefined);
  expect(second.unsubscribe).toHaveBeenCalledOnce();
  second.publish(200);
  expect(fixture.current().revision).toBe(0);
  panel.dispose();
  await expect(panel.setClient(first.client)).rejects.toThrow('disposed');
});

it('does not install a stale subscription when snapshot completion races with replacement', async () => {
  expect.assertions(3);
  const first = fixtureClient(1);
  const second = fixtureClient(2);
  const pending = Promise.withResolvers<BrokerState>();
  first.client.snapshot = async () => pending.promise;
  const fixture = fixtureContext();
  const panel = createCdbPanel({ client: () => first.client });
  const setup = panel.definition.setup(fixture.context);
  await Promise.resolve();
  await panel.setClient(second.client);
  pending.resolve(state);
  await setup;
  expect(first.client.watch).not.toHaveBeenCalled();
  expect(second.client.watch).toHaveBeenCalledOnce();
  expect(fixture.current().revision).toBe(2);
  panel.dispose();
});
