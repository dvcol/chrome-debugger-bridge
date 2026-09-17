import type { Spec, UIElement } from '@devframes/json-render';
import type { BrokerState } from '@dvcol/cdb-broker/contract';

export interface BrowserControlPanelComponents {
  readonly [component: string]: { readonly type?: string; readonly props?: Record<string, unknown> };
}

function truncateDestination(value: string): string {
  const maximumLength = 88;
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, 64)}...${value.slice(-(maximumLength - 67))}`;
}

function destinationPresentation(value: string): { readonly label: string; readonly href?: string } {
  try {
    const destination = new URL(value);
    if (destination.protocol === 'http:' || destination.protocol === 'https:') {
      return {
        label: truncateDestination(`${destination.host}${destination.pathname === '/' ? '' : destination.pathname}`),
        href: value,
      };
    }
  } catch {
    return { label: truncateDestination(value) };
  }
  return { label: truncateDestination(value) };
}

/** One view for the reference renderer and host-supplied component registries. */
export function buildBrowserControlPanelView(state: BrokerState, components: BrowserControlPanelComponents = {}): Spec {
  const elements: Record<string, UIElement> = {};
  function element(id: string, type: string, props: Record<string, unknown>, children?: string[]): string {
    const override = components[type];
    elements[id] = { type: override?.type ?? type, props: { ...props, ...override?.props }, ...(children === undefined ? {} : { children }) };
    return id;
  }
  function stack(id: string, children: string[], row = false, justify?: 'start' | 'end' | 'between'): string {
    return element(id, 'Stack', { direction: row ? 'row' : 'column', gap: 12, ...(row ? { wrap: true, align: 'stretch' } : {}), ...(justify === undefined ? {} : { justify }) }, children);
  }
  function text(id: string, value: string, variant = 'body'): string {
    return element(id, 'Text', { text: value, variant });
  }
  function actionButton(id: string, label: string, action: string, parameters: Record<string, unknown>, danger = false): string {
    element(id, 'Button', { label, variant: danger ? 'danger' : 'secondary' });
    elements[id]!.on = { press: { action: `cdb:panel:${action}`, params: parameters } };
    return id;
  }
  function facts(id: string, data: Record<string, unknown>): string {
    return element(id, 'KeyValueTable', { data });
  }
  function destination(id: string, value: string): string {
    const presentation = destinationPresentation(value);
    return element(id, 'Stack', { direction: 'column', gap: 4 }, [
      text(`${id}-label`, 'Destination', 'caption'),
      presentation.href === undefined
        ? text(`${id}-value`, presentation.label, 'code')
        : element(`${id}-link`, 'Link', { href: presentation.href, label: presentation.label, external: true }),
    ]);
  }
  function card(id: string, title: string, children: string[]): string {
    return element(id, 'Card', { title }, [stack(`${id}-body`, children)]);
  }
  function untitledCard(id: string, children: string[]): string {
    return element(id, 'Card', {}, [stack(`${id}-body`, children)]);
  }
  function responsiveCell(child: string): string {
    return element(`${child}-cell`, 'Stack', { flex: '0 1 480px' }, [child]);
  }
  function section(id: string, children: string[], empty: string): string {
    if (children.length === 0) return stack(id, [text(`${id}-empty`, empty)]);
    return stack(id, children.map(responsiveCell), true);
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
      stack(`${id}-header`, [text(`${id}-client`, grant.principalLabel), badge], true, 'between'),
      ...(target?.url === undefined ? [] : [destination(`${id}-destination`, target.url)]),
      facts(`${id}-access`, { Grant: grant.level, Navigation: grant.navigation, Origin: grant.approvedOrigin }),
      element(`${id}-connection-divider`, 'Divider', { label: 'Connection' }),
      facts(`${id}-connection`, { 'Grant ID': grant.id, 'Target ID': grant.targetId, 'Provider': grant.providerId }),
      stack(`${id}-footer`, [actionButton(`${id}-revoke`, 'Revoke target', 'revoke-target', { grantId: grant.id }, true)], true, 'end'),
    ]);
  });
  const providers = state.providers.map((provider) => {
    const id = `provider-${provider.id}`;
    const status = element(`${id}-status`, 'Badge', { text: provider.state, variant: provider.state === 'ready' ? 'success' : 'warning' });
    return untitledCard(id, [
      stack(`${id}-header`, [text(`${id}-name`, provider.name, 'subheading'), status], true, 'between'),
      facts(`${id}-facts`, { Tabs: provider.targetCount, Version: provider.version, Pairing: provider.paired ? 'Paired' : 'Not paired' }),
      element(`${id}-connection-divider`, 'Divider', { label: 'Connection' }),
      facts(`${id}-connection`, { 'Provider ID': provider.id, 'Installation ID': provider.instanceId, 'Maximum access': provider.maximumLevel }),
      stack(`${id}-footer`, [
        actionButton(`${id}-disconnect`, 'Disconnect', 'disconnect', { providerId: provider.id }),
        actionButton(`${id}-forget`, 'Forget pairing', 'forget', { providerId: provider.id }, true),
      ], true, 'end'),
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
