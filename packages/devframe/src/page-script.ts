import type { DevframeRpcClient } from 'devframe/client';

import type { BrowserControlMessages } from './notification-items.js';

import { createBrowserControlNotificationController } from '@dvcol/cdb-extension/notifications';

import { browserControlNotificationItems } from './notification-items.js';
import { createBrowserControlPanelClient } from './panel.js';

/** Page events request the host's final approval UI. They never approve browser access. */
export const browserControlReviewEvent = 'cdb:review-request';
export const browserControlAcceptEvent = 'cdb:accept-request';

export interface BrowserControlPageOptions {
  /** The embedding application owns the final approval channel for either action. */
  readonly approvalAction?: 'review' | 'accept';
  /** Install host approval bindings only while this panel has an available broker. */
  readonly onAvailable?: () => void | (() => void);
}

/** Client-script entry selected by a host that supplies a direct approval channel. */
export async function setupBrowserControlAcceptPage(context: BrowserControlPageContext, options: Omit<BrowserControlPageOptions, 'approvalAction'> = {}): Promise<() => void> {
  return setupBrowserControlPage(context, { ...options, approvalAction: 'accept' });
}

export interface BrowserControlPageContext {
  readonly rpc: DevframeRpcClient;
  readonly current: { readonly domElements: { readonly iframe?: HTMLIFrameElement | null } };
  readonly commands: {
    register: (command: { id: string; title: string; source: 'client'; action: () => Promise<void>; showInPalette: boolean }) => () => void;
  };
  /** Retained for compatibility with existing page hosts; messages are published by the panel host. */
  readonly messages: BrowserControlMessages;
}

/** Uses the hub's existing page connection; the embedding extension handles the review intent. */
export default async function setupBrowserControlPage(context: BrowserControlPageContext, options: BrowserControlPageOptions = {}): Promise<() => void> {
  const client = createBrowserControlPanelClient(context.rpc);
  let disposed = false;
  let available = false;
  let stopHostBindings: (() => void) | undefined;
  const review = (requestId: string): void => {
    if (disposed || !available) return;
    window.dispatchEvent(new CustomEvent(options.approvalAction === 'accept' ? browserControlAcceptEvent : browserControlReviewEvent, { detail: { requestId } }));
  };
  const controller = createBrowserControlNotificationController({ onReview: request => review(request.id), onRevoke: async requestId => client.revokeScope(requestId) });
  const commands = new Map<string, () => void>();
  const stopNotifications = controller.subscribe((state) => {
    const items = browserControlNotificationItems(state, options.approvalAction);
    const activeIds = new Set(items.map(item => item.id));
    for (const [id, unregister] of commands) {
      if (activeIds.has(id)) continue;
      unregister();
      commands.delete(id);
    }
    for (const item of items) {
      if (commands.has(item.id)) continue;
      async function invoke(): Promise<void> {
        if (item.kind === 'request') return controller.review(item.requestId);
        await controller.revoke(item.requestId);
      }
      const unregister = context.commands.register({ id: item.id, title: item.label, source: 'client', action: invoke, showInPalette: false });
      commands.set(item.id, unregister);
    }
  });
  const receive = (event: MessageEvent<unknown>): void => {
    if (event.source !== context.current.domElements.iframe?.contentWindow || event.source === null) return;
    const data = event.data;
    if (data !== null && typeof data === 'object' && 'type' in data && data.type === browserControlReviewEvent && 'requestId' in data && typeof data.requestId === 'string') review(data.requestId);
  };
  let stopWatching: (() => void) | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopHostBindings?.();
    stopHostBindings = undefined;
    stopWatching?.();
    document.documentElement.removeAttribute('data-cdb-notifications-ready');
    stopNotifications();
    for (const unregister of commands.values()) unregister();
    commands.clear();
    controller.dispose();
    window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('pagehide', dispose, { once: true });
  try {
    stopWatching = await client.watch((state, nextAvailable = true) => {
      if (disposed) return;
      if (available !== nextAvailable) {
        available = nextAvailable;
        if (available) stopHostBindings = options.onAvailable?.() ?? undefined;
        else {
          stopHostBindings?.();
          stopHostBindings = undefined;
        }
      }
      controller.update(available ? state : { requests: [], grants: [] });
      document.documentElement.toggleAttribute('data-cdb-notifications-ready', available);
    });
    if (disposed) {
      stopWatching();
      return dispose;
    }
    window.addEventListener('message', receive);
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

export { createPageRequestBridge, type PageRequestBridge, type PageRequestBridgeOptions, type PageRequestOptions } from '@dvcol/cdb-extension';
