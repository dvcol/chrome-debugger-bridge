import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlPanelClient } from '../src/panel.js';

import { expect, it, vi } from 'vitest';

import { createCdbPanel } from '../src/panel-definition.js';

vi.mock('@devframes/json-render/node', () => ({ createJsonRenderView: () => ({ update: vi.fn(), dispose: vi.fn() }) }));

const state: BrokerState = { revision: 1, providers: [], principals: [], requests: [], targets: [], grants: [], leases: [], scopes: [] };

interface FixtureDockEntry {
  readonly id: string;
  readonly type: string;
  readonly visibility?: string;
  readonly action?: {
    readonly eager?: boolean;
    readonly importFrom: string;
    readonly importName?: string;
  };
}

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

function fixtureContext(options: { hub?: boolean } = {}) {
  let value = { broker: state };
  const docks = {
    views: new Map([['cdb-browser-control', { id: 'cdb-browser-control', title: 'Browser control', icon: 'ph:browser-duotone', type: 'iframe', url: '/' }]]),
    register: vi.fn((_entry: FixtureDockEntry) => ({ update: vi.fn() })),
    update: vi.fn(),
  };
  const context = {
    rpc: { sharedState: { get: vi.fn() } },
    scope: () => ({ rpc: {
      register: vi.fn(),
      sharedState: vi.fn(async (_key: string, { initialValue }: { initialValue: typeof value }) => {
        value = initialValue;
        return { mutate: (mutate: (current: typeof value) => void) => mutate(value) };
      }),
    } }),
    ...(options.hub === true ? { docks } : {}),
  };
  return { context: context as unknown as Parameters<ReturnType<typeof createCdbPanel>['definition']['setup']>[0], current: () => value.broker, docks };
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

it('registers the page integration as a hidden eager action alongside the rendered dock', async () => {
  expect.assertions(4);
  const fixture = fixtureContext({ hub: true });
  const panel = createCdbPanel({ client: () => fixtureClient(1).client });
  await panel.definition.setup(fixture.context);
  expect(fixture.docks.register).toHaveBeenCalledOnce();
  const entry = fixture.docks.register.mock.calls[0]?.[0];
  expect(entry).toMatchObject({ id: 'cdb-browser-control-page-script', type: 'action', visibility: 'false', action: { eager: true } });
  expect(entry?.action?.importFrom).toMatch(/view\/page-script\.js$/u);
  expect(entry?.action?.importName).toBeUndefined();
  panel.dispose();
});

it('selects the accept-page export for the hidden eager action when approvalAction is "accept"', async () => {
  expect.assertions(1);
  const fixture = fixtureContext({ hub: true });
  const panel = createCdbPanel({ client: () => fixtureClient(1).client, approvalAction: 'accept' });
  await panel.definition.setup(fixture.context);
  expect(fixture.docks.register.mock.calls[0]?.[0]?.action?.importName).toBe('setupBrowserControlAcceptPage');
  panel.dispose();
});
