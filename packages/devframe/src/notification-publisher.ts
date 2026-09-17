import type { BrowserControlErrorData } from '@dvcol/cdb-broker/contract';
import type { BrowserControlNotificationController } from '@dvcol/cdb-extension/notifications';

import type { BrowserControlMessages, BrowserControlNotificationItem } from './notification-items.js';

import { styleText } from 'node:util';

import { normalizeBrowserControlError } from '@dvcol/cdb-broker/contract';

import { browserControlNotificationItems } from './notification-items.js';

/** The panel host owns shared messages; page clients own only their local command registrations. */
export function publishBrowserControlNotifications(
  controller: BrowserControlNotificationController,
  messages: BrowserControlMessages,
  approvalAction: 'review' | 'accept' = 'review',
  onError?: (error: BrowserControlErrorData) => void,
): () => void {
  const notifications = new Map<string, { description: string; update: (description: string) => void; remove: () => void }>();
  const pending = new Map<string, Promise<void>>();

  /** Keep removal ordered before re-creation of the same ID during connection replacement. */
  function enqueue(id: string, operation: () => Promise<void>): void {
    const next = (pending.get(id) ?? Promise.resolve()).then(operation).catch((error) => {
      const failure = normalizeBrowserControlError(error);
      if (onError === undefined) console.error(styleText('red', '❌ [cdb]'), 'Unable to publish browser-control notification.', failure);
      else onError(failure);
    });
    pending.set(id, next);
    void next.then(() => {
      if (pending.get(id) === next) pending.delete(id);
    });
  }

  function createNotification(item: BrowserControlNotificationItem): void {
    let active = true;
    let handle: Awaited<ReturnType<BrowserControlMessages['info']>> | undefined;
    enqueue(item.id, async () => {
      if (!active) return;
      handle = await messages.info(item.title, { id: item.id, description: item.description, notify: true, autoDismiss: false, actions: item.actions.map(action => ({ id: action.id, label: action.label, kind: 'command', command: { id: `${item.id}:${action.id}` } })) });
    });
    notifications.set(item.id, {
      description: item.description,
      update(description) {
        enqueue(item.id, async () => {
          if (active) await handle?.update({ description });
        });
      },
      remove() {
        active = false;
        enqueue(item.id, async () => {
          await handle?.dismiss();
        });
      },
    });
  }

  const unsubscribe = controller.subscribe((state) => {
    const items = browserControlNotificationItems(state, approvalAction);
    const activeIds = new Set(items.map(item => item.id));
    for (const [id, notification] of notifications) {
      if (activeIds.has(id)) continue;
      notification.remove();
      notifications.delete(id);
    }
    for (const item of items) {
      const notification = notifications.get(item.id);
      if (notification === undefined) {
        createNotification(item);
        continue;
      }
      if (notification.description === item.description) continue;
      notification.description = item.description;
      notification.update(item.description);
    }
  });

  return function dispose(): void {
    unsubscribe();
    for (const notification of notifications.values()) notification.remove();
    notifications.clear();
  };
}
