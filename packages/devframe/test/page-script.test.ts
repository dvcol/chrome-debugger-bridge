// @vitest-environment jsdom
import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlPageContext } from '../src/page-script.js';

import { expect, it, vi } from 'vitest';

import setupBrowserControlPage, { setupBrowserControlAcceptPage } from '../src/page-script.js';
import * as panel from '../src/panel.js';

it.each(['review', 'accept'] as const)('uses native hub notifications with %s and removes ended requests', async (approvalAction) => {
  expect.assertions(9);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  let update: (state: BrokerState) => void = () => {};
  const stopWatching = vi.fn();
  const dismiss = vi.fn(async () => {});
  const unregister = vi.fn();
  const register = vi.fn<BrowserControlPageContext['commands']['register']>(() => unregister);
  const info = vi.fn(async () => ({ dismiss }));
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
    expect(info).toHaveBeenCalledWith('Browser control requested', expect.objectContaining({ notify: true, autoDismiss: false, description: 'Agent requests interact access with same-origin navigation.' }));
    expect(document.querySelector('aside')).toBeNull();
    expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(true);
    const command = register.mock.calls[0]![0];
    expect(command.title).toBe(approvalAction === 'accept' ? 'Accept' : 'Review request');
    await command.action();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: `cdb:${approvalAction}-request`, detail: { requestId: 'request' } }));
    update({ ...state, requests: [] });
    await vi.waitUntil(() => dismiss.mock.calls.length === 1);
    expect(unregister).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  } finally {
    dispose();
    client.mockRestore();
    dispatch.mockRestore();
  }
  expect(stopWatching).toHaveBeenCalledOnce();
  expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(false);
});
