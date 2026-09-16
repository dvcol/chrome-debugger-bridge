import type { BrokerState } from '@dvcol/cdb-broker/contract';

import { expect, it } from 'vitest';

import { buildBrowserControlPanelView } from '../src/panel-view.js';

const state: BrokerState = {
  revision: 1,
  providers: [{ id: 'provider', instanceId: 'installation', name: 'Fixture browser', version: '1.0.0', maximumLevel: 'debug', paired: true, state: 'ready', targetCount: 1 }],
  principals: [{ id: 'client', label: 'Fixture client', connectedAt: 1, metadata: { privateDetail: 'not-for-display' } }],
  requests: [{
    id: 'request',
    principalId: 'client',
    principalLabel: 'Fixture client',
    level: 'interact',
    navigation: 'same-origin',
    createdAt: 1,
    expiresAt: 2,
    state: 'pending',
  }],
  grants: [{ id: 'grant', requestId: 'request', principalId: 'client', principalLabel: 'Fixture client', providerId: 'provider', targetId: 'target', targetGeneration: 1, level: 'interact', navigation: 'same-origin', approvedOrigin: 'https://fixture.test', createdAt: 1, state: 'active' }],
  targets: [{
    id: 'target',
    generation: 1,
    scopeId: 'scope',
    title: 'Fixture page',
    url: `https://fixture.test/${'long-path-segment/'.repeat(8)}page?session=private#section`,
    providerId: 'provider',
    state: 'available',
  }],
  scopes: [],
  leases: [{
    id: 'lease',
    principalId: 'client',
    targetId: 'target',
    targetGeneration: 1,
    mode: 'shared-read',
    methods: ['Page.navigate'],
    issuedAt: '2026-09-16T12:00:00.000Z',
    expiresAt: '2026-09-16T12:01:00.000Z',
  }],
};

it('projects each access grant as one complete card with a readable destination and footer action', () => {
  expect.assertions(19);
  const view = buildBrowserControlPanelView(state);
  expect(view.elements['summary-providers-value']?.props).toMatchObject({ text: '1' });
  expect(view.elements['summary-access-value']?.props).toMatchObject({ text: '1' });
  expect(view.elements.tabs?.children).toEqual(['requests', 'access', 'providers', 'operations']);
  expect(view.elements['grant-grant']?.children).toEqual(['grant-grant-body']);
  expect(view.elements['grant-grant-body']?.children).toEqual([
    'grant-grant-header',
    'grant-grant-destination',
    'grant-grant-access',
    'grant-grant-connection-divider',
    'grant-grant-connection',
    'grant-grant-footer',
  ]);
  expect(view.elements['grant-grant-details']).toBeUndefined();
  expect(view.elements['grant-grant-url']).toBeUndefined();
  expect(view.elements['grant-grant-destination-link']?.props).toMatchObject({
    href: state.targets[0]!.url,
    external: true,
  });
  const destination = String(view.elements['grant-grant-destination-link']?.props.label);
  expect(destination.startsWith('fixture.test/')).toBe(true);
  expect(destination).toContain('...');
  expect(destination.endsWith('page')).toBe(true);
  expect(destination).not.toContain('session=private');
  expect(view.elements['grant-grant-access']?.props.data).toEqual({ Grant: 'interact', Navigation: 'same-origin', Origin: 'https://fixture.test' });
  expect(view.elements['grant-grant-connection']?.props.data).toEqual({ 'Grant ID': 'grant', 'Target ID': 'target', 'Provider': 'provider' });
  expect(view.elements['grant-grant-footer']?.props).toMatchObject({ direction: 'row', justify: 'end' });
  expect(view.elements['grant-grant-revoke']?.on).toEqual({ press: { action: 'cdb:panel:revoke-target', params: { grantId: 'grant' } } });
  expect(view.elements['grant-grant-revoke']?.props).toMatchObject({ label: 'Revoke target', variant: 'danger' });
  expect(view.elements['provider-provider-forget']?.on).toEqual({ press: { action: 'cdb:panel:forget', params: { providerId: 'provider' } } });
  expect(JSON.stringify(view)).not.toContain('not-for-display');
});

it('renders provider metadata and actions in one flat card', () => {
  expect.assertions(17);
  const view = buildBrowserControlPanelView(state);
  expect(view.elements['provider-provider']?.props).toEqual({});
  expect(view.elements['provider-provider']?.children).toEqual(['provider-provider-body']);
  expect(view.elements['provider-provider-body']?.children).toEqual([
    'provider-provider-header',
    'provider-provider-facts',
    'provider-provider-connection-divider',
    'provider-provider-connection',
    'provider-provider-footer',
  ]);
  expect(view.elements['provider-provider-header']?.props).toMatchObject({ direction: 'row', wrap: true, justify: 'between' });
  expect(view.elements['provider-provider-header']?.children).toEqual(['provider-provider-name', 'provider-provider-status']);
  expect(view.elements['provider-provider-name']?.props).toEqual({ text: 'Fixture browser', variant: 'subheading' });
  expect(view.elements['provider-provider-status']?.props).toMatchObject({ text: 'ready', variant: 'success' });
  expect(view.elements['provider-provider-body']?.children).not.toContain('provider-provider-status');
  expect(JSON.stringify(view)).toContain('Fixture browser');
  expect(JSON.stringify(view).match(/Fixture browser/gu)).toHaveLength(1);
  expect(view.elements['provider-provider-details']).toBeUndefined();
  expect(JSON.stringify(view.elements['provider-provider'])).not.toContain('collapsible');
  expect(view.elements['provider-provider-connection-divider']?.props).toEqual({ label: 'Connection' });
  expect(view.elements['provider-provider-connection']?.props.data).toEqual({
    'Provider ID': 'provider',
    'Installation ID': 'installation',
    'Maximum access': 'debug',
  });
  expect(view.elements['provider-provider-footer']?.props).toMatchObject({ direction: 'row', wrap: true, justify: 'end' });
  expect(view.elements['provider-provider-footer']?.children).toEqual(['provider-provider-disconnect', 'provider-provider-forget']);
  expect(view.elements['provider-provider-disconnect']?.props).toMatchObject({ label: 'Disconnect', variant: 'secondary' });
});

it('wraps populated tab card collections into responsive flex cells', () => {
  expect.assertions(20);
  const view = buildBrowserControlPanelView(state);
  for (const [section, card] of [
    ['requests', 'request-request'],
    ['access', 'grant-grant'],
    ['providers', 'provider-provider'],
    ['operations', 'operation-0'],
  ] as const) {
    expect(view.elements[section]?.props).toMatchObject({ direction: 'row', wrap: true, align: 'stretch' });
    expect(view.elements[section]?.children).toEqual([`${card}-cell`]);
    expect(view.elements[`${card}-cell`]?.props).toEqual({ flex: '0 1 480px' });
    expect(view.elements[`${card}-cell`]?.props).not.toEqual({ flex: '1 1 320px' });
    expect(view.elements[`${card}-cell`]?.props).not.toHaveProperty('maxWidth');
  }
});

it('lets a host replace component types and styling while retaining content and action bindings', () => {
  expect.assertions(4);
  const view = buildBrowserControlPanelView(state, { Card: { type: 'HostCard', props: { interactive: true, variant: 'primary' } } });
  expect(view.elements['grant-grant']?.type).toBe('HostCard');
  expect(view.elements['grant-grant']?.props).toEqual({ title: 'Fixture page', interactive: true, variant: 'primary' });
  expect(view.elements['grant-grant']?.children).toEqual(['grant-grant-body']);
  expect(view.elements['grant-grant-revoke']?.on).toEqual({ press: { action: 'cdb:panel:revoke-target', params: { grantId: 'grant' } } });
});

it('renders non-web destinations as inert text', () => {
  expect.assertions(2);
  const view = buildBrowserControlPanelView({
    ...state,
    targets: [{ ...state.targets[0]!, url: 'chrome://settings/content' }],
  });
  expect(view.elements['grant-grant-destination-link']).toBeUndefined();
  expect(view.elements['grant-grant-destination-value']?.props).toEqual({ text: 'chrome://settings/content', variant: 'code' });
});
