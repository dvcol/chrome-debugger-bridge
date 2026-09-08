import type { BrokerState } from '@dvcol/cdb-broker/contract';

import { expect, it } from 'vitest';

import { buildBrowserControlPanelView } from '../src/panel-view.js';

const state: BrokerState = {
  revision: 1,
  providers: [{ id: 'provider', instanceId: 'installation', name: 'Fixture browser', version: '1.0.0', maximumLevel: 'debug', paired: true, state: 'ready', targetCount: 1 }],
  principals: [{ id: 'client', label: 'Fixture client', connectedAt: 1, metadata: { privateDetail: 'not-for-display' } }],
  requests: [],
  grants: [{ id: 'grant', requestId: 'request', principalId: 'client', principalLabel: 'Fixture client', providerId: 'provider', targetId: 'target', targetGeneration: 1, level: 'interact', navigation: 'same-origin', approvedOrigin: 'https://fixture.test', createdAt: 1, state: 'active' }],
  targets: [{ id: 'target', generation: 1, scopeId: 'scope', title: 'Fixture page', url: 'https://fixture.test', providerId: 'provider', state: 'available' }],
  scopes: [],
  leases: [],
};

it('projects summary counts, tabbed access and exact management actions without private metadata', () => {
  expect.assertions(8);
  const view = buildBrowserControlPanelView(state);
  expect(view.elements['summary-providers-value']?.props).toMatchObject({ text: '1' });
  expect(view.elements['summary-access-value']?.props).toMatchObject({ text: '1' });
  expect(view.elements.tabs?.children).toEqual(['requests', 'access', 'providers', 'operations']);
  expect(view.elements['grant-grant-revoke']?.on).toEqual({ press: { action: 'cdb:panel:revoke-target', params: { grantId: 'grant' } } });
  expect(view.elements['provider-provider-forget']?.on).toEqual({ press: { action: 'cdb:panel:forget', params: { providerId: 'provider' } } });
  expect(view.elements['provider-provider-details']?.props).toMatchObject({ collapsible: true, defaultCollapsed: true });
  expect(JSON.stringify(view)).not.toContain('not-for-display');
  expect(view.elements['grant-grant']?.props).toEqual({ title: 'Fixture page' });
});

it('lets a host replace component types and styling while retaining content and action bindings', () => {
  expect.assertions(4);
  const view = buildBrowserControlPanelView(state, { Card: { type: 'HostCard', props: { interactive: true, variant: 'primary' } } });
  expect(view.elements['grant-grant']?.type).toBe('HostCard');
  expect(view.elements['grant-grant']?.props).toEqual({ title: 'Fixture page', interactive: true, variant: 'primary' });
  expect(view.elements['grant-grant']?.children).toEqual(['grant-grant-body']);
  expect(view.elements['grant-grant-revoke']?.on).toEqual({ press: { action: 'cdb:panel:revoke-target', params: { grantId: 'grant' } } });
});
