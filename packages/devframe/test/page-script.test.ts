// @vitest-environment jsdom
import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlPageContext } from '../src/page-script.js';

import { expect, it, vi } from 'vitest';

import setupBrowserControlPage, { setupBrowserControlAcceptPage } from '../src/page-script.js';
import * as panel from '../src/panel.js';

it.each(['review', 'accept'] as const)('registers local %s commands without publishing shared messages', async (approvalAction) => {
  expect.assertions(8);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  let update: (state: BrokerState) => void = () => {};
  const stopWatching = vi.fn();
  const dismiss = vi.fn(async () => {});
  const unregister = vi.fn();
  const register = vi.fn<BrowserControlPageContext['commands']['register']>(() => unregister);
  const info = vi.fn(async () => ({ dismiss, update: vi.fn(async () => {}) }));
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const client = vi.spyOn(panel, 'createBrowserControlPanelClient').mockReturnValue({
    snapshot: () => state,
    watch: (listener) => {
      update = listener;
      listener(state);
      return stopWatching;
    },
    revokeScope: async () => {},
    revokeGrant: async () => true,
    disconnectProvider: async () => true,
  });
  const setupPage = approvalAction === 'accept' ? setupBrowserControlAcceptPage : setupBrowserControlPage;
  const dispose = await setupPage({ rpc: {} as BrowserControlPageContext['rpc'], current: { domElements: {} }, commands: { register }, messages: { info } });
  try {
    expect(info).not.toHaveBeenCalled();
    expect(document.querySelector('aside')).toBeNull();
    expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(true);
    const command = register.mock.calls[0]![0];
    expect(command.title).toBe(approvalAction === 'accept' ? 'Accept' : 'Review request');
    await command.action();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: `cdb:${approvalAction}-request`, detail: { requestId: 'request' } }));
    update({ ...state, requests: [] });
    expect(unregister).toHaveBeenCalledOnce();
  } finally {
    dispose();
    client.mockRestore();
    dispatch.mockRestore();
  }
  expect(stopWatching).toHaveBeenCalledOnce();
  expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(false);
});

it('installs host approval bindings only while available and removes local commands on disable', async () => {
  expect.assertions(10);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  let publish: (state: BrokerState, available?: boolean) => void = () => {};
  const mock = vi.spyOn(panel, 'createBrowserControlPanelClient').mockReturnValue({
    snapshot: () => state,
    watch(listener) {
      publish = listener;
      listener(state, false);
      return () => {};
    },
    revokeScope: async () => {},
    revokeGrant: async () => true,
    disconnectProvider: async () => true,
  });
  const removeBindings = vi.fn();
  const onAvailable = vi.fn(() => removeBindings);
  const dismiss = vi.fn(async () => {});
  const info = vi.fn(async () => ({ dismiss, update: vi.fn(async () => {}) }));
  const unregister = vi.fn();
  const register = vi.fn(() => unregister);
  const dispose = await setupBrowserControlAcceptPage({ rpc: {} as BrowserControlPageContext['rpc'], current: { domElements: {} }, commands: { register }, messages: { info } }, { onAvailable });
  try {
    expect(onAvailable).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    publish(state, true);
    publish(state, true);
    expect(onAvailable).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    publish(state, false);
    expect(removeBindings).toHaveBeenCalledOnce();
    expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(false);
    expect(unregister).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
    publish(state, true);
    expect(onAvailable).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
    mock.mockRestore();
  }
  expect(removeBindings).toHaveBeenCalledTimes(2);
});
