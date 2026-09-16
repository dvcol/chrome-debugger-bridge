import type { BrowserControlErrorData } from '@dvcol/cdb-broker/contract';
import type { DevframeRpcClient } from 'devframe/client';

import { normalizeBrowserControlError } from '@dvcol/cdb-broker/contract';
import { createBrowserControlNotificationController } from '@dvcol/cdb-extension/notifications';

import { browserControlNotificationItems } from './notification-items.js';
import { createBrowserControlPanelClient } from './panel.js';

/** Page events request the host's final approval UI. They never approve browser access. */
export const browserControlReviewEvent = 'cdb:review-request';
export const browserControlAcceptEvent = 'cdb:accept-request';

export interface BrowserControlApprovalEventDetail {
  readonly requestId: string;
  respondWith: (response: PromiseLike<void>) => void;
}

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
  readonly commands: {
    register: (command: { id: string; title: string; source: 'client'; action: () => Promise<void>; showInPalette: boolean }) => () => void;
  };
}

function commandError(error: unknown): Error & BrowserControlErrorData {
  const result = normalizeBrowserControlError(error);
  return Object.assign(new Error(result.message), result);
}

/** Uses the hub's existing page connection; the embedding extension handles the review intent. */
export default async function setupBrowserControlPage(context: BrowserControlPageContext, options: BrowserControlPageOptions = {}): Promise<() => void> {
  definePage(options);
  const client = createBrowserControlPanelClient(context.rpc);
  let disposed = false;
  let available = false;
  let stopHostBindings: (() => void) | undefined;
  const review = async (requestId: string): Promise<void> => {
    if (disposed || !available) throw commandError({ code: 'PROVIDER_UNAVAILABLE', message: 'Browser approval is unavailable.', retryable: false });
    let acceptingResponse = true;
    let response: PromiseLike<void> | undefined;
    let responseError: Error | undefined;
    const detail: BrowserControlApprovalEventDetail = {
      requestId,
      respondWith(value) {
        if (!acceptingResponse) {
          responseError = new Error('The approval response must be registered during event dispatch.');
          return;
        }
        if (response !== undefined) {
          responseError = new Error('The approval event already has a response.');
          return;
        }
        response = value;
      },
    };
    window.dispatchEvent(new CustomEvent<BrowserControlApprovalEventDetail>(
      options.approvalAction === 'accept' ? browserControlAcceptEvent : browserControlReviewEvent,
      { detail },
    ));
    acceptingResponse = false;
    if (responseError !== undefined) throw commandError(responseError);
    if (response === undefined) throw commandError({ code: 'APPROVAL_HANDLER_UNAVAILABLE', message: 'No browser approval handler responded.', retryable: false });
    try {
      await response;
    } catch (error) {
      throw commandError(error);
    }
  };
  const controller = createBrowserControlNotificationController({
    onReview: async request => review(request.id),
    onReject: async requestId => client.revokeScope(requestId),
    onRevoke: async requestId => client.revokeScope(requestId),
  });
  const commands = new Map<string, () => void>();
  const stopNotifications = controller.subscribe((state) => {
    const items = browserControlNotificationItems(state, options.approvalAction);
    const activeIds = new Set(items.flatMap(item => item.actions.map(action => `${item.id}:${action.id}`)));
    for (const [id, unregister] of commands) {
      if (activeIds.has(id)) continue;
      unregister();
      commands.delete(id);
    }
    for (const item of items) {
      for (const action of item.actions) {
        const commandId = `${item.id}:${action.id}`;
        if (commands.has(commandId)) continue;
        async function invoke(): Promise<void> {
          try {
            if (action.id === 'accept' || action.id === 'review') return await controller.review(item.requestId);
            if (action.id === 'reject') return await controller.reject(item.requestId);
            await controller.revoke(item.requestId);
          } catch (error) {
            throw commandError(error);
          }
        }
        const unregister = context.commands.register({ id: commandId, title: action.label, source: 'client', action: invoke, showInPalette: false });
        commands.set(commandId, unregister);
      }
    }
  });
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
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

export { createPageRequestBridge, type PageRequestBridge, type PageRequestBridgeOptions, type PageRequestOptions } from '@dvcol/cdb-extension';

/** Defines configuration without starting the adapter or calling runtime dependencies. */
export function definePage<const Definition extends BrowserControlPageOptions>(definition: Definition): Definition {
  return definition;
}
