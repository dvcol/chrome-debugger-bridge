import type { BrokerRequest, BrokerState } from '@dvcol/cdb-broker/contract';
import type { BrowserControlNotificationRendererOptions } from '@dvcol/cdb-extension/notifications';

import type { CdbDevframeClient } from './wire.js';

import { createBrowserControlNotificationController, renderBrowserControlNotifications } from '@dvcol/cdb-extension/notifications';

/** A panel consumes a broker connection; it does not own its runtime or transport. */
export interface BrowserControlPanelClient {
  snapshot: () => BrokerState | Promise<BrokerState>;
  watch: (listener: (state: BrokerState) => void) => (() => void) | Promise<() => void>;
  revokeScope: (requestId: string) => Promise<void>;
  revokeGrant: (grantId: string) => Promise<boolean>;
  disconnectProvider: (providerId: string, forgetPairing?: boolean) => Promise<boolean>;
}

export interface BrowserControlPanelOptions {
  readonly client: BrowserControlPanelClient;
  readonly container: HTMLElement;
  readonly onReview: (request: BrokerRequest) => void | Promise<void>;
  readonly branding?: BrowserControlNotificationRendererOptions['branding'];
  readonly css?: string;
}

/** Mounts framework-neutral management UI into an existing application. */
export async function mountBrowserControlPanel(options: BrowserControlPanelOptions): Promise<{ dispose: () => void }> {
  const document = options.container.ownerDocument;
  const host = document.createElement('section');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; color-scheme: light dark; color: CanvasText; background: Canvas; font: 14px/1.5 system-ui, sans-serif; padding: 16px; }
    h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 16px; margin: 18px 0 8px; }
    article { padding: 12px; margin: 8px 0; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; }
    p { margin: 4px 0; overflow-wrap: anywhere; } small { opacity: .75; }
    button { color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 4px; font: inherit; padding: 6px 10px; margin: 6px 8px 0 0; cursor: pointer; }
    [role=alert] { color: #b42318; }
    ${options.css ?? ''}
  `;
  const heading = document.createElement('h1');
  heading.textContent = options.branding?.title ?? 'Browser control';
  const notifications = document.createElement('div');
  const content = document.createElement('div');
  root.append(style, heading, notifications, content);
  options.container.append(host);
  let disposed = false;
  const controller = createBrowserControlNotificationController({ onReview: options.onReview, onRevoke: async requestId => options.client.revokeScope(requestId) });
  const renderer = renderBrowserControlNotifications({ controller, container: notifications, ...(options.branding === undefined ? {} : { branding: options.branding }) });

  function text(parent: HTMLElement, tag: string, value: string): void {
    const element = document.createElement(tag);
    element.textContent = value;
    parent.append(element);
  }
  function action(parent: HTMLElement, label: string, invoke: () => Promise<unknown>): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = async () => {
      button.disabled = true;
      try {
        await invoke();
      } catch (error) {
        const alert = document.createElement('p');
        alert.role = 'alert';
        alert.textContent = error instanceof Error ? error.message : String(error);
        if (!disposed) parent.append(alert);
      } finally {
        button.disabled = false;
      }
    };
    parent.append(button);
  }
  function update(state: BrokerState): void {
    if (disposed) return;
    controller.update(state);
    content.replaceChildren();
    text(content, 'h2', `Providers (${state.providers.length})`);
    if (state.providers.length === 0) text(content, 'p', 'Connect a browser extension to begin.');
    for (const provider of state.providers) {
      const row = document.createElement('article');
      text(row, 'strong', `${provider.name} · ${provider.state}`);
      text(row, 'p', `${provider.targetCount} targets · version ${provider.version}`);
      text(row, 'small', `Provider ${provider.id} · installation ${provider.instanceId}`);
      action(row, 'Disconnect', async () => options.client.disconnectProvider(provider.id));
      action(row, 'Forget pairing', async () => options.client.disconnectProvider(provider.id, true));
      content.append(row);
    }
    text(content, 'h2', `Approved targets (${state.grants.length})`);
    for (const grant of state.grants) {
      const row = document.createElement('article');
      const target = state.targets.find(candidate => candidate.id === grant.targetId);
      text(row, 'strong', `${grant.principalLabel} · ${grant.level} · ${grant.state}`);
      text(row, 'p', target?.title ?? grant.targetId);
      if (target?.url !== undefined) text(row, 'p', target.url);
      text(row, 'small', `Navigation: ${grant.navigation} · approved origin: ${grant.approvedOrigin}`);
      action(row, 'Revoke target', async () => options.client.revokeGrant(grant.id));
      content.append(row);
    }
    text(content, 'h2', `Active leases (${state.leases.length})`);
    for (const lease of state.leases) text(content, 'p', `${lease.principalId} · ${lease.mode} · ${lease.methods.join(', ')}`);
  }
  try {
    const stopWatching = await options.client.watch(update);
    return { dispose() {
      disposed = true;
      stopWatching();
      renderer.dispose();
      controller.dispose();
      host.remove();
    } };
  } catch (error) {
    renderer.dispose();
    controller.dispose();
    host.remove();
    throw error;
  }
}

/** Reads the panel projection hosted by createCdbPanel, over the supplied Devframe connection. */
export function createBrowserControlPanelClient(client: CdbDevframeClient): BrowserControlPanelClient {
  const rpc = client.scope('cdb:panel').rpc;
  return {
    snapshot: async () => rpc.call('state') as Promise<BrokerState>,
    async watch(listener) {
      const state = await rpc.sharedState<{ broker: BrokerState }>('state');
      const update = (value: ReturnType<typeof state.value> | undefined): void => {
        /** Devframe initializes shared state after the connection becomes trusted. */
        if (value !== undefined) listener(structuredClone(value.broker) as BrokerState);
      };
      const unsubscribe = state.on('updated', update);
      update(state.value());
      return unsubscribe;
    },
    revokeScope: async requestId => rpc.call('revoke-scope', requestId) as Promise<void>,
    revokeGrant: async grantId => rpc.call('revoke-grant', grantId) as Promise<boolean>,
    disconnectProvider: async (providerId, forgetPairing = false) => rpc.call('disconnect-provider', providerId, forgetPairing) as Promise<boolean>,
  };
}
