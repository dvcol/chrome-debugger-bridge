import type { BrowserControlNotification } from '@dvcol/cdb-extension/notifications';

/** One command per action; a page-local command registration resolves each action independently. */
export interface BrowserControlNotificationAction {
  readonly id: 'review' | 'accept' | 'reject' | 'revoke';
  readonly label: string;
}

export interface BrowserControlNotificationItem {
  readonly id: string;
  readonly requestId: string;
  readonly kind: 'request' | 'grant';
  readonly title: string;
  readonly description: string;
  readonly actions: readonly BrowserControlNotificationAction[];
}

/** Shared message IDs resolve to a command installed independently in each viewing tab. */
export function browserControlNotificationItems(state: BrowserControlNotification, approvalAction: 'review' | 'accept' = 'review'): BrowserControlNotificationItem[] {
  const items: BrowserControlNotificationItem[] = state.requests.map(request => ({
    id: `cdb:browser-control:request:${request.id}`,
    requestId: request.id,
    kind: 'request',
    title: 'Browser control requested',
    description: `${request.principalLabel} requests ${request.level} access with ${request.navigation} navigation.`,
    actions: [
      { id: approvalAction, label: approvalAction === 'accept' ? 'Accept' : 'Review request' },
      { id: 'reject', label: 'Reject' },
    ],
  }));
  for (const [requestId, grants] of Map.groupBy(state.grants, grant => grant.requestId)) {
    const grant = grants[0]!;
    const tabLabel = grants.length === 1 ? 'tab' : 'tabs';
    items.push({
      id: `cdb:browser-control:grant:${requestId}`,
      requestId,
      kind: 'grant',
      title: 'Browser control active',
      description: `${grant.principalLabel}: ${grant.level} access to ${grants.length} approved ${tabLabel}.`,
      actions: [{ id: 'revoke', label: 'Stop control' }],
    });
  }
  return items;
}

export interface BrowserControlMessages {
  info: (message: string, options: { id: string; description: string; notify: boolean; autoDismiss: false; actions: { id: string; label: string; kind: 'command'; command: { id: string } }[] }) => Promise<{ dismiss: () => Promise<void>; update: (patch: { description: string }) => Promise<unknown> }>;
}
