import type { Spec, UIElement } from '@devframes/json-render';
import type { BrokerState } from '@dvcol/cdb-broker/contract';

export interface BrowserControlPanelComponents {
  readonly [component: string]: { readonly type?: string; readonly props?: Record<string, unknown> };
}

/** One view for the reference renderer and host-supplied component registries. */
export function buildBrowserControlPanelView(state: BrokerState, components: BrowserControlPanelComponents = {}): Spec {
  const elements: Record<string, UIElement> = {};
  function element(id: string, type: string, props: Record<string, unknown>, children?: string[]): string {
    const override = components[type];
    elements[id] = { type: override?.type ?? type, props: { ...props, ...override?.props }, ...(children === undefined ? {} : { children }) };
    return id;
  }
  function stack(id: string, children: string[], row = false): string {
    return element(id, 'Stack', { direction: row ? 'row' : 'column', gap: 12, ...(row ? { wrap: true, align: 'stretch' } : {}) }, children);
  }
  function text(id: string, value: string, variant = 'body'): string {
    return element(id, 'Text', { text: value, variant });
  }
  function button(id: string, label: string, action: string, parameters: Record<string, unknown>, danger = false): string {
    element(id, 'Button', { label, variant: danger ? 'danger' : 'secondary' });
    elements[id]!.on = { press: { action: `cdb:panel:${action}`, params: parameters } };
    return stack(`${id}-actions`, [id], true);
  }
  function facts(id: string, data: Record<string, unknown>): string {
    return element(id, 'KeyValueTable', { data });
  }
  function details(id: string, data: Record<string, unknown>, actions: string[] = []): string {
    return element(id, 'Card', { title: 'Connection details', collapsible: true, defaultCollapsed: true }, [stack(`${id}-body`, [facts(`${id}-facts`, data), ...actions])]);
  }
  function card(id: string, title: string, children: string[]): string {
    return element(id, 'Card', { title }, [stack(`${id}-body`, children)]);
  }
  function section(id: string, children: string[], empty: string): string {
    return stack(id, children.length === 0 ? [text(`${id}-empty`, empty)] : children);
  }
  const summaries = [
    ['providers', 'Connected browsers', state.providers.filter(provider => provider.state === 'ready').length],
    ['requests', 'Pending requests', state.requests.length],
    ['access', 'Active grants', state.grants.filter(grant => grant.state === 'active').length],
    ['operations', 'Active operations', state.leases.length],
  ] as const;
  const summary = stack('summary', summaries.map(([id, title, count]) => element(`summary-${id}-cell`, 'Stack', { flex: '1 1 140px' }, [card(`summary-${id}`, title, [text(`summary-${id}-value`, String(count), 'heading')])])), true);
  const requests = state.requests.map(request => card(`request-${request.id}`, request.principalLabel, [
    facts(`request-${request.id}-facts`, { Grant: request.level, Navigation: request.navigation, Status: request.state }),
    text(`request-${request.id}-help`, 'Review this request in the browser tab you want to share.', 'caption'),
  ]));
  const access = state.grants.map((grant) => {
    const id = `grant-${grant.id}`;
    const target = state.targets.find(candidate => candidate.id === grant.targetId);
    const badge = element(`${id}-status`, 'Badge', { text: grant.state, variant: grant.state === 'active' ? 'success' : 'warning' });
    return card(id, target?.title ?? 'Approved tab', [
      stack(`${id}-header`, [text(`${id}-client`, grant.principalLabel), badge], true),
      facts(`${id}-access`, { Grant: grant.level, Navigation: grant.navigation, Origin: grant.approvedOrigin }),
      ...(target?.url === undefined ? [] : [text(`${id}-url`, target.url, 'caption')]),
      button(`${id}-revoke`, 'Revoke target', 'revoke-target', { grantId: grant.id }, true),
      details(`${id}-details`, { 'Grant ID': grant.id, 'Target ID': grant.targetId, 'Provider': grant.providerId }),
    ]);
  });
  const providers = state.providers.map((provider) => {
    const id = `provider-${provider.id}`;
    return card(id, provider.name, [
      element(`${id}-status`, 'Badge', { text: provider.state, variant: provider.state === 'ready' ? 'success' : 'warning' }),
      facts(`${id}-facts`, { Tabs: provider.targetCount, Version: provider.version, Pairing: provider.paired ? 'Paired' : 'Not paired' }),
      button(`${id}-disconnect`, 'Disconnect', 'disconnect', { providerId: provider.id }),
      details(`${id}-details`, { 'Provider ID': provider.id, 'Installation ID': provider.instanceId, 'Maximum access': provider.maximumLevel }, [button(`${id}-forget`, 'Forget pairing', 'forget', { providerId: provider.id }, true)]),
    ]);
  });
  const operations = state.leases.map((lease, index) => card(`operation-${index}`, state.principals.find(principal => principal.id === lease.principalId)?.label ?? 'Browser client', [facts(`operation-${index}-facts`, { Mode: lease.mode, Methods: lease.methods.join(', ') })]));
  const panels = [
    section('requests', requests, 'No pending requests. An agent can request access when it needs a browser tab.'),
    section('access', access, 'No shared tabs. Approve an agent request in the browser to grant access.'),
    section('providers', providers, 'Connect a browser extension to begin.'),
    section('operations', operations, 'No actions are running.'),
  ];
  const tabs = element('tabs', 'Tabs', {
    defaultValue: state.requests.length > 0 ? 'requests' : 'access',
    tabs: [
      { value: 'requests', label: 'Requests' },
      { value: 'access', label: 'Access' },
      { value: 'providers', label: 'Providers' },
      { value: 'operations', label: 'Activity' },
    ],
  }, panels);
  stack('root', [summary, tabs]);
  return { root: 'root', elements };
}
