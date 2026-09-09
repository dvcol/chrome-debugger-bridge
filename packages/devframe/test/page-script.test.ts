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

async function notificationFixture(message = { dismiss: vi.fn(async () => {}), update: vi.fn(async (_patch: { description: string }) => {}) }, creation?: Promise<typeof message>) {
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  let publish: (state: BrokerState) => void = () => {};
  const client = vi.spyOn(panel, 'createBrowserControlPanelClient').mockReturnValue({ snapshot: () => state, watch: (listener) => {
    publish = listener;
    listener(state);
    return () => {};
  }, revokeScope: async () => {}, revokeGrant: async () => true, disconnectProvider: async () => true });
  const unregister = vi.fn();
  const register = vi.fn(() => unregister);
  const info = vi.fn(async () => creation ?? message);
  const dispose = await setupBrowserControlPage({ rpc: {} as BrowserControlPageContext['rpc'], current: { domElements: {} }, commands: { register }, messages: { info } });
  return { state, publish: (next: BrokerState) => publish(next), message, info, register, unregister, dispose: () => {
    dispose();
    client.mockRestore();
  } };
}

it('updates changed descriptions through the existing message without registering another command', async () => {
  expect.assertions(4);
  const fixture = await notificationFixture();
  try {
    fixture.publish({ ...fixture.state, revision: 2 });
    expect(fixture.message.update).not.toHaveBeenCalled();
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'Renamed agent' }] });
    await vi.waitUntil(() => fixture.message.update.mock.calls.length === 1);
    expect(fixture.message.update).toHaveBeenCalledWith({ description: 'Renamed agent requests interact access with same-origin navigation.' });
    expect(fixture.info).toHaveBeenCalledOnce();
    expect(fixture.register).toHaveBeenCalledOnce();
  } finally {
    fixture.dispose();
  }
});

it('updates overlapping-grant tab counts without notifying unchanged publications', async () => {
  expect.assertions(3);
  const fixture = await notificationFixture();
  const grant = { id: 'grant', requestId: 'request', principalId: 'principal', principalLabel: 'Agent', providerId: 'provider', targetId: 'one', targetGeneration: 1, level: 'interact' as const, navigation: 'same-origin' as const, approvedOrigin: 'https://example.test', createdAt: 0, state: 'active' as const };
  try {
    fixture.publish({ ...fixture.state, requests: [], grants: [grant] });
    fixture.publish({ ...fixture.state, requests: [], grants: [grant, { ...grant, id: 'second', targetId: 'two' }] });
    await vi.waitUntil(() => fixture.message.update.mock.calls.length === 1);
    expect(fixture.message.update).toHaveBeenLastCalledWith({ description: 'Agent: interact access to 2 approved tabs.' });
    fixture.publish({ ...fixture.state, revision: 3, requests: [], grants: [grant, { ...grant, id: 'second', targetId: 'two' }] });
    await Promise.resolve();
    expect(fixture.message.update).toHaveBeenCalledOnce();
    expect(fixture.info).toHaveBeenCalledTimes(2);
  } finally {
    fixture.dispose();
  }
});

it('serializes updates and dismisses after a pending update without publishing queued stale data', async () => {
  expect.assertions(5);
  const pending = Promise.withResolvers<void>();
  const update = vi.fn(async (_patch: { description: string }) => pending.promise);
  const fixture = await notificationFixture({ update, dismiss: vi.fn(async () => {}) });
  try {
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'First' }] });
    await vi.waitUntil(() => update.mock.calls.length === 1);
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'Second' }] });
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    fixture.publish({ ...fixture.state, requests: [] });
    expect(fixture.unregister).toHaveBeenCalledOnce();
    expect(fixture.message.dismiss).not.toHaveBeenCalled();
    pending.resolve();
    await vi.waitUntil(() => fixture.message.dismiss.mock.calls.length === 1);
    expect(update).toHaveBeenCalledOnce();
    expect(fixture.message.dismiss).toHaveBeenCalledOnce();
  } finally {
    pending.resolve();
    fixture.dispose();
  }
});

it.each(['expiry', 'disposal'] as const)('cleans up delayed message creation after %s', async (ending) => {
  expect.assertions(3);
  const message = { dismiss: vi.fn(async () => {}), update: vi.fn(async (_patch: { description: string }) => {}) };
  const creation = Promise.withResolvers<typeof message>();
  const fixture = await notificationFixture(message, creation.promise);
  try {
    if (ending === 'expiry') fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, expiresAt: 1 }] });
    else fixture.dispose();
    expect(fixture.unregister).toHaveBeenCalledOnce();
    creation.resolve(message);
    await vi.waitUntil(() => message.dismiss.mock.calls.length === 1);
    expect(message.dismiss).toHaveBeenCalledOnce();
    expect(message.update).not.toHaveBeenCalled();
  } finally {
    fixture.dispose();
  }
});

it('continues message updates after a rejected update and still removes the message', async () => {
  expect.assertions(3);
  const fixture = await notificationFixture();
  const failure = new Error('Host update failed');
  fixture.message.update.mockRejectedValueOnce(failure);
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'First' }] });
    await vi.waitUntil(() => report.mock.calls.length === 1);
    fixture.publish({ ...fixture.state, requests: [{ ...fixture.state.requests[0]!, principalLabel: 'Second' }] });
    await vi.waitUntil(() => fixture.message.update.mock.calls.length === 2);
    expect(fixture.message.update).toHaveBeenLastCalledWith({ description: 'Second requests interact access with same-origin navigation.' });
    fixture.publish({ ...fixture.state, requests: [] });
    await vi.waitUntil(() => fixture.message.dismiss.mock.calls.length === 1);
    expect(fixture.message.dismiss).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('Unable to update browser-control notification.', failure);
  } finally {
    fixture.dispose();
    report.mockRestore();
  }
});
