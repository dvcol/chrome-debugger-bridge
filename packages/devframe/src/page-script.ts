import type { DevframeRpcClient } from 'devframe/client';

import { createBrowserControlNotificationController } from '@dvcol/cdb-extension/notifications';

import { createBrowserControlPanelClient } from './panel.js';

/** Page events request the host's final approval UI. They never approve browser access. */
export const browserControlReviewEvent = 'cdb:review-request';
export const browserControlAcceptEvent = 'cdb:accept-request';

export interface BrowserControlPageOptions {
  /** The embedding application owns the final approval channel for either action. */
  readonly approvalAction?: 'review' | 'accept';
}

/** Client-script entry selected by a host that supplies a direct approval channel. */
export async function setupBrowserControlAcceptPage(context: BrowserControlPageContext): Promise<() => void> {
  return setupBrowserControlPage(context, { approvalAction: 'accept' });
}

export interface BrowserControlPageContext {
  readonly rpc: DevframeRpcClient;
  readonly current: { readonly domElements: { readonly iframe?: HTMLIFrameElement | null } };
  readonly commands: {
    register: (command: { id: string; title: string; source: 'client'; action: () => Promise<void>; showInPalette: boolean }) => () => void;
  };
  readonly messages: {
    info: (message: string, options: { id: string; description: string; notify: boolean; autoDismiss: false; actions: { id: string; label: string; kind: 'command'; command: { id: string } }[] }) => Promise<{ dismiss: () => Promise<void>; update: (patch: { description: string }) => Promise<unknown> }>;
  };
}

/** Uses the hub's existing page connection; the embedding extension handles the review intent. */
export default async function setupBrowserControlPage(context: BrowserControlPageContext, options: BrowserControlPageOptions = {}): Promise<() => void> {
  const client = createBrowserControlPanelClient(context.rpc);
  const review = (requestId: string): void => {
    window.dispatchEvent(new CustomEvent(options.approvalAction === 'accept' ? browserControlAcceptEvent : browserControlReviewEvent, { detail: { requestId } }));
  };
  const controller = createBrowserControlNotificationController({ onReview: request => review(request.id), onRevoke: async requestId => client.revokeScope(requestId) });
  const notifications = new Map<string, { description: string; update: (description: string) => void; remove: () => void }>();
  const prefix = `cdb:browser-control:${crypto.randomUUID()}`;
  const stopNotifications = controller.subscribe((state) => {
    const items = [
      ...state.requests.map(request => ({ id: `request:${request.id}`, title: 'Browser control requested', description: `${request.principalLabel} requests ${request.level} access with ${request.navigation} navigation.`, label: options.approvalAction === 'accept' ? 'Accept' : 'Review request', action: async () => controller.review(request.id) })),
      ...Array.from(Map.groupBy(state.grants, grant => grant.requestId), ([requestId, grants]) => ({ id: `grant:${requestId}`, title: 'Browser control active', description: `${grants[0]!.principalLabel}: ${grants[0]!.level} access to ${grants.length} approved ${grants.length === 1 ? 'tab' : 'tabs'}.`, label: 'Stop control', action: async () => controller.revoke(requestId) })),
    ];
    for (const [id, notification] of notifications) {
      if (items.some(item => item.id === id)) continue;
      notification.remove();
      notifications.delete(id);
    }
    for (const item of items) {
      const notification = notifications.get(item.id);
      if (notification !== undefined) {
        if (notification.description !== item.description) {
          notification.description = item.description;
          notification.update(item.description);
        }
        continue;
      }
      const id = `${prefix}:${item.id}`;
      const unregister = context.commands.register({ id, title: item.label, source: 'client', action: item.action, showInPalette: false });
      const message = context.messages.info(item.title, { id, description: item.description, notify: true, autoDismiss: false, actions: [{ id: 'control', label: item.label, kind: 'command', command: { id } }] }).catch(error => console.error('Unable to show browser-control notification.', error));
      let active = true;
      let pending = Promise.resolve();
      notifications.set(item.id, {
        description: item.description,
        update(description) {
          pending = pending.then(async () => {
            const handle = await message;
            if (active) await handle?.update({ description });
          }).catch(error => console.error('Unable to update browser-control notification.', error));
        },
        remove() {
          active = false;
          unregister();
          pending = pending.then(async () => (await message)?.dismiss()).catch(error => console.error('Unable to dismiss browser-control notification.', error));
        },
      });
    }
  });
  const receive = (event: MessageEvent<unknown>): void => {
    if (event.source !== context.current.domElements.iframe?.contentWindow || event.source === null) return;
    const data = event.data;
    if (data !== null && typeof data === 'object' && 'type' in data && data.type === browserControlReviewEvent && 'requestId' in data && typeof data.requestId === 'string') review(data.requestId);
  };
  let stopWatching: (() => void) | undefined;
  const dispose = (): void => {
    stopWatching?.();
    document.documentElement.removeAttribute('data-cdb-notifications-ready');
    stopNotifications();
    for (const notification of notifications.values()) notification.remove();
    notifications.clear();
    controller.dispose();
    window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', dispose);
  };
  try {
    stopWatching = await client.watch(state => controller.update(state));
    /** Embedding extensions defer their fallback card only once this notifier is listening. */
    document.documentElement.setAttribute('data-cdb-notifications-ready', '');
    window.addEventListener('message', receive);
    window.addEventListener('pagehide', dispose, { once: true });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
