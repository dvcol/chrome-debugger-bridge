// @vitest-environment jsdom
import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlApprovalEventDetail, BrowserControlPageContext } from '../src/page-script.js';

import { expect, it, vi } from 'vitest';

import setupBrowserControlPage, { browserControlAcceptEvent, browserControlReviewEvent, setupBrowserControlAcceptPage } from '../src/page-script.js';
import * as panel from '../src/panel.js';

it.each(['review', 'accept'] as const)('registers local %s and reject commands', async (approvalAction) => {
  expect.assertions(10);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  let update: (state: BrokerState) => void = () => {};
  const stopWatching = vi.fn();
  const unregister = vi.fn();
  const register = vi.fn<BrowserControlPageContext['commands']['register']>(() => unregister);
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const approval = (event: Event): void => {
    (event as CustomEvent<BrowserControlApprovalEventDetail>).detail.respondWith(Promise.resolve());
  };
  window.addEventListener(approvalAction === 'accept' ? browserControlAcceptEvent : browserControlReviewEvent, approval);
  const revokeScope = vi.fn(async () => {});
  const client = vi.spyOn(panel, 'createBrowserControlPanelClient').mockReturnValue({
    snapshot: () => state,
    watch: (listener) => {
      update = listener;
      listener(state);
      return stopWatching;
    },
    revokeScope,
    revokeGrant: async () => true,
    disconnectProvider: async () => true,
  });
  const setupPage = approvalAction === 'accept' ? setupBrowserControlAcceptPage : setupBrowserControlPage;
  const dispose = await setupPage({ rpc: {} as BrowserControlPageContext['rpc'], commands: { register } });
  try {
    expect(document.querySelector('aside')).toBeNull();
    expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(true);
    const [acceptCommand, rejectCommand] = register.mock.calls.map(call => call[0]);
    expect(acceptCommand!.id).toBe(`cdb:browser-control:request:request:${approvalAction}`);
    expect(acceptCommand!.title).toBe(approvalAction === 'accept' ? 'Accept' : 'Review request');
    expect(rejectCommand!.title).toBe('Reject');
    await acceptCommand!.action();
    const dispatched = dispatch.mock.calls[0]![0] as CustomEvent<BrowserControlApprovalEventDetail>;
    expect({
      type: dispatched.type,
      requestId: dispatched.detail.requestId,
      respondWith: typeof dispatched.detail.respondWith,
    }).toEqual({ type: `cdb:${approvalAction}-request`, requestId: 'request', respondWith: 'function' });
    await rejectCommand!.action();
    expect(revokeScope).toHaveBeenCalledWith('request');
    update({ ...state, requests: [] });
    expect(unregister).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
    window.removeEventListener(approvalAction === 'accept' ? browserControlAcceptEvent : browserControlReviewEvent, approval);
    client.mockRestore();
    dispatch.mockRestore();
  }
  expect(stopWatching).toHaveBeenCalledOnce();
  expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(false);
});

it('returns structured approval failures to the notification command', async () => {
  expect.assertions(2);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  let command: Parameters<BrowserControlPageContext['commands']['register']>[0] | undefined;
  const mock = vi.spyOn(panel, 'createBrowserControlPanelClient').mockReturnValue({
    snapshot: () => state,
    watch(listener) {
      listener(state);
      return () => {};
    },
    revokeScope: async () => {},
    revokeGrant: async () => true,
    disconnectProvider: async () => true,
  });
  const failure = Object.assign(new Error('The selected tab disappeared.'), {
    code: 'TARGET_GONE',
    retryable: true,
    retryAfterMilliseconds: 250,
    details: { targetId: 'tab-1' },
  });
  const respond = (event: Event): void => {
    (event as CustomEvent<BrowserControlApprovalEventDetail>).detail.respondWith(Promise.reject(failure));
  };
  window.addEventListener(browserControlAcceptEvent, respond);
  const dispose = await setupBrowserControlAcceptPage({
    rpc: {} as BrowserControlPageContext['rpc'],
    commands: { register(value) {
      command ??= value;
      return () => {};
    } },
  });
  try {
    await expect(command!.action()).rejects.toMatchObject({
      code: 'TARGET_GONE',
      message: 'The selected tab disappeared.',
      retryable: true,
      retryAfterMilliseconds: 250,
      details: { targetId: 'tab-1' },
    });
    expect(command!.id).toBe('cdb:browser-control:request:request:accept');
  } finally {
    dispose();
    window.removeEventListener(browserControlAcceptEvent, respond);
    mock.mockRestore();
  }
});

it('fails approval commands when no host handler responds', async () => {
  expect.assertions(1);
  const state: BrokerState = { revision: 1, providers: [], principals: [], targets: [], grants: [], scopes: [], leases: [], requests: [{ id: 'request', principalId: 'principal', principalLabel: 'Agent', level: 'interact', navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null }] };
  let command: Parameters<BrowserControlPageContext['commands']['register']>[0] | undefined;
  const mock = vi.spyOn(panel, 'createBrowserControlPanelClient').mockReturnValue({
    snapshot: () => state,
    watch(listener) {
      listener(state);
      return () => {};
    },
    revokeScope: async () => {},
    revokeGrant: async () => true,
    disconnectProvider: async () => true,
  });
  const dispose = await setupBrowserControlPage({
    rpc: {} as BrowserControlPageContext['rpc'],
    commands: { register(value) {
      command ??= value;
      return () => {};
    } },
  });
  try {
    await expect(command!.action()).rejects.toMatchObject({ code: 'APPROVAL_HANDLER_UNAVAILABLE', retryable: false });
  } finally {
    dispose();
    mock.mockRestore();
  }
});

it('installs host approval bindings only while available and removes local commands on disable', async () => {
  expect.assertions(8);
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
  const unregister = vi.fn();
  const register = vi.fn(() => unregister);
  const dispose = await setupBrowserControlAcceptPage({ rpc: {} as BrowserControlPageContext['rpc'], commands: { register } }, { onAvailable });
  try {
    expect(onAvailable).not.toHaveBeenCalled();
    publish(state, true);
    publish(state, true);
    expect(onAvailable).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledTimes(2);
    publish(state, false);
    expect(removeBindings).toHaveBeenCalledOnce();
    expect(document.documentElement.hasAttribute('data-cdb-notifications-ready')).toBe(false);
    expect(unregister).toHaveBeenCalledTimes(2);
    publish(state, true);
    expect(onAvailable).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
    mock.mockRestore();
  }
  expect(removeBindings).toHaveBeenCalledTimes(2);
});
