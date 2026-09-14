// @vitest-environment jsdom
import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlPageContext } from '../src/page-script.js';
import type { BrowserControlPanelClient } from '../src/panel.js';

import { expect, it, vi } from 'vitest';

import { setupBrowserControlAcceptPage } from '../src/page-script.js';
import { createCdbPanel } from '../src/panel-definition.js';
import * as panel from '../src/panel.js';

vi.mock('@devframes/json-render/node', () => ({ createJsonRenderView: () => ({ update: vi.fn(), dispose: vi.fn() }) }));

it('publishes one shared notification with an action in both clients and keeps it when either client leaves', async () => {
  expect.assertions(10);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  const listeners = new Set<(state: BrokerState) => void>();
  const client: BrowserControlPanelClient = {
    snapshot: () => state,
    watch(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    revokeScope: async () => {},
    revokeGrant: async () => true,
    disconnectProvider: async () => true,
  };
  const mock = vi.spyOn(panel, 'createBrowserControlPanelClient').mockReturnValue(client);
  const dismiss = vi.fn(async () => {});
  const info = vi.fn<BrowserControlPageContext['messages']['info']>(async () => ({ dismiss, update: vi.fn(async () => {}) }));
  const messages = { info };
  const host = createCdbPanel({ client: () => client, approvalAction: 'accept' });
  const context = {
    messages,
    rpc: { sharedState: { get: vi.fn() } },
    scope: () => ({ rpc: {
      register: vi.fn(),
      sharedState: async (_key: string, options: { initialValue: unknown }) => ({ mutate: (mutate: (value: unknown) => void) => mutate(options.initialValue) }),
    } }),
  } as unknown as Parameters<typeof host.definition.setup>[0];
  const firstUnregister = vi.fn();
  const secondUnregister = vi.fn();
  const firstRegister = vi.fn<BrowserControlPageContext['commands']['register']>(() => firstUnregister);
  const secondRegister = vi.fn<BrowserControlPageContext['commands']['register']>(() => secondUnregister);
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  await host.definition.setup(context);
  const common = { rpc: {} as BrowserControlPageContext['rpc'], current: { domElements: {} }, messages };
  const disposeFirst = await setupBrowserControlAcceptPage({ ...common, commands: { register: firstRegister } });
  const disposeSecond = await setupBrowserControlAcceptPage({ ...common, commands: { register: secondRegister } });
  try {
    expect(info).toHaveBeenCalledOnce();
    const commandId = info.mock.calls[0]![1].actions[0]!.command.id;
    expect(firstRegister.mock.calls[0]![0].id).toBe(commandId);
    expect(secondRegister.mock.calls[0]![0].id).toBe(commandId);
    disposeFirst();
    await Promise.resolve();
    expect(firstUnregister).toHaveBeenCalledOnce();
    expect(secondUnregister).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    await secondRegister.mock.calls[0]![0].action();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'cdb:accept-request', detail: { requestId: 'request' } }));
    for (const listener of listeners) listener({ ...state, requests: [] });
    await vi.waitUntil(() => dismiss.mock.calls.length === 1);
    expect(secondUnregister).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    await expect(secondRegister.mock.calls[0]![0].action()).rejects.toThrow('no longer pending');
  } finally {
    disposeFirst();
    disposeSecond();
    host.dispose();
    mock.mockRestore();
    dispatch.mockRestore();
  }
});
