// @vitest-environment jsdom
import type { BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlPanelClient } from '../src/panel.js';

import { expect, it, vi } from 'vitest';

import { mountBrowserControlPanel } from '../src/panel.js';

it('uses supplied management actions and releases its subscription without disposing the broker connection', async () => {
  expect.assertions(6);
  const state: BrokerState = { revision: 1, providers: [{ id: 'provider', instanceId: 'installation', name: 'Fixture provider', version: '1.0.0', maximumLevel: 'debug', paired: true, state: 'ready', targetCount: 0 }], principals: [], requests: [], grants: [], scopes: [], targets: [], leases: [] };
  const unsubscribe = vi.fn();
  const disconnect = vi.fn(async () => true);
  const client: BrowserControlPanelClient = { snapshot: () => state, watch(listener) {
    listener(state);
    return unsubscribe;
  }, revokeScope: async () => {}, revokeGrant: async () => true, disconnectProvider: disconnect };
  const container = document.createElement('div');
  const panel = await mountBrowserControlPanel({ client, container, onReview: async () => {} });
  const root = container.querySelector('section')!.shadowRoot!;
  expect(root.textContent).toContain('Fixture provider');
  expect(root.textContent).toContain('installation');
  [...root.querySelectorAll('button')].find(button => button.textContent === 'Disconnect')!.click();
  await vi.waitUntil(() => disconnect.mock.calls.length === 1);
  expect(disconnect).toHaveBeenCalledWith('provider');
  panel.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(container.children).toHaveLength(0);
  expect(client.snapshot()).toEqual(state);
});
