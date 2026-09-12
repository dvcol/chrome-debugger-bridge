import type { BrokerGrant, BrokerRequest, BrokerState } from '@dvcol/cdb-broker/contract';

export interface BrowserControlNotification {
  readonly grants: readonly BrokerGrant[];
  readonly requests: readonly BrokerRequest[];
}

export interface BrowserControlNotificationController {
  dismiss: (requestId: string) => void;
  dispose: () => void;
  review: (requestId: string) => Promise<void>;
  revoke: (requestId: string) => Promise<void>;
  snapshot: () => BrowserControlNotification;
  subscribe: (listener: (notification: BrowserControlNotification) => void) => () => void;
  update: (state: Pick<BrokerState, 'requests' | 'grants'>) => void;
}

export interface BrowserControlNotificationOptions {
  readonly targetId?: string;
  /** Opens the embedding application's approval UI. This callback does not itself grant authority. */
  readonly onReview: (request: BrokerRequest) => void | Promise<void>;
  readonly onRevoke: (requestId: string) => Promise<void>;
}

/** Derives notification state from the broker. Dismissal is presentation-only and never rejects a request. */
export function createBrowserControlNotificationController(options: BrowserControlNotificationOptions): BrowserControlNotificationController {
  const dismissed = new Set<string>();
  const listeners = new Set<(value: BrowserControlNotification) => void>();
  let state: Pick<BrokerState, 'requests' | 'grants'> | undefined;
  let disposed = false;
  let expiration: ReturnType<typeof setTimeout> | undefined;

  function snapshot(): BrowserControlNotification {
    return {
      grants: disposed ? [] : state?.grants.filter(grant => options.targetId === undefined || grant.targetId === options.targetId) ?? [],
      requests: disposed
        ? []
        : state?.requests.filter(request => !dismissed.has(request.id)
          && (request.expiresAt === null || request.expiresAt > Date.now())
          && (options.targetId === undefined || request.requestedTargetId === undefined || request.requestedTargetId === options.targetId)) ?? [],
    };
  }
  function notify(): void {
    if (expiration !== undefined) clearTimeout(expiration);
    const notification = snapshot();
    const deadlines = notification.requests.flatMap(request => request.expiresAt === null ? [] : [request.expiresAt]);
    if (deadlines.length > 0) expiration = setTimeout(notify, Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - Date.now())));
    for (const listener of listeners) listener(notification);
  }
  return {
    snapshot,
    dismiss(requestId) {
      dismissed.add(requestId);
      notify();
    },
    dispose() {
      disposed = true;
      if (expiration !== undefined) clearTimeout(expiration);
      state = undefined;
      listeners.clear();
      dismissed.clear();
    },
    async review(requestId) {
      const request = snapshot().requests.find(candidate => candidate.id === requestId);
      if (request === undefined) throw new Error('The browser access request is no longer pending.');
      await options.onReview(request);
    },
    async revoke(requestId) {
      if (!snapshot().grants.some(grant => grant.requestId === requestId)) throw new Error('The approved scope is no longer present.');
      await options.onRevoke(requestId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(nextState) {
      if (disposed) return;
      state = nextState;
      for (const requestId of dismissed) if (!state.requests.some(request => request.id === requestId)) dismissed.delete(requestId);
      notify();
    },
  };
}

export interface BrowserControlNotificationRendererOptions {
  readonly controller: BrowserControlNotificationController;
  readonly container: HTMLElement;
  readonly branding?: { readonly title?: string; readonly accent?: string };
  /** Describe the host's action, including direct approval when the host provides that policy. */
  readonly reviewLabel?: (request: BrokerRequest) => string;
  readonly clientLabel?: (request: BrokerRequest) => string;
  /** Rejects the pending request through the host; dismissal remains local. */
  readonly onReject?: (request: BrokerRequest) => Promise<void>;
  /** Host-supplied CSS, applied inside the isolated notification root. */
  readonly css?: string;
}

/** Optional neutral presentation. Review buttons delegate to the host's trusted final approval UI. */
export function renderBrowserControlNotifications(options: BrowserControlNotificationRendererOptions): { dispose: () => void } {
  const document = options.container.ownerDocument;
  const host = document.createElement('section');
  host.dataset.cdbNotifications = '';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; font: 14px/1.5 system-ui, sans-serif; color: #172033; color-scheme: light dark; }
    article { background: Canvas; color: CanvasText; padding: 12px 16px; margin: 8px 0; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; }
    h2, p { margin: 0 0 8px; } h2 { font-size: 15px; } p { overflow-wrap: anywhere; }
    button { padding: 6px 10px; margin: 4px 6px 0 0; cursor: pointer; border-radius: 4px; border: 1px solid currentColor; background: transparent; color: var(--cdb-accent, #7356c8); font: inherit; }
    article { position: relative; } h2 { padding-right: 28px; }
    .dismiss { position: absolute; top: 5px; right: 6px; margin: 0; border: 0; }
    dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; text-align: left; }
    dt { font-size: 12px; opacity: .75; } dd { margin: 4px 0 0; overflow-wrap: anywhere; }
    code { font: 12px/1.5 ui-monospace, monospace; }
    button:disabled { opacity: .6; cursor: wait; } [role=alert] { color: #b42318; }
    ${options.css ?? ''}
  `;
  if (options.branding?.accent !== undefined) host.style.setProperty('--cdb-accent', options.branding.accent);
  const content = document.createElement('div');
  root.append(style, content);
  options.container.append(host);
  let disposed = false;
  let renderedNotification: string | undefined;

  function button(article: HTMLElement, label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.onclick = () => {
      element.disabled = true;
      void Promise.resolve().then(action).catch((error: unknown) => {
        if (disposed) return;
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.textContent = error instanceof Error ? error.message : 'The browser request could not be completed.';
        article.append(message);
      }).finally(() => {
        element.disabled = false;
      });
    };
    article.append(element);
    return element;
  }
  function article(title: string, description?: string): HTMLElement {
    const element = document.createElement('article');
    const heading = document.createElement('h2');
    heading.textContent = title;
    element.append(heading);
    if (description !== undefined) {
      const text = document.createElement('p');
      text.textContent = description;
      element.append(text);
    }
    return element;
  }
  function render(notification: BrowserControlNotification): void {
    if (disposed) return;
    /** Unrelated broker publications must not replace focused or pending controls. */
    const serializedNotification = JSON.stringify(notification);
    if (serializedNotification === renderedNotification) return;
    renderedNotification = serializedNotification;
    content.replaceChildren();
    for (const request of notification.requests) {
      const element = article(options.branding?.title ?? 'Browser control requested');
      const dismiss = button(element, '×', () => options.controller.dismiss(request.id));
      dismiss.className = 'dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.title = 'Dismiss notification';
      const details = document.createElement('dl');
      for (const [label, value] of [['Client', options.clientLabel?.(request) ?? request.principalLabel], ['Grant', request.level], ['Navigation', request.navigation]] as const) {
        const column = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        const definition = document.createElement('dd');
        const badge = document.createElement('code');
        badge.textContent = value;
        if (label === 'Grant') badge.dataset.level = request.level;
        definition.append(badge);
        column.append(term, definition);
        details.append(column);
      }
      element.append(details);
      const actions = document.createElement('footer');
      element.append(actions);
      button(actions, options.reviewLabel?.(request) ?? 'Review request', async () => options.controller.review(request.id));
      const reject = options.onReject;
      if (reject !== undefined) button(actions, 'Reject', async () => reject(request));
      content.append(element);
    }
    const grouped = Map.groupBy(notification.grants, grant => grant.requestId);
    for (const [requestId, grants] of grouped) {
      const grant = grants[0]!;
      const element = article(options.branding?.title ?? 'Browser control', `${grant.principalLabel}: ${grant.level}, ${grant.navigation}. ${grants.length} approved ${grants.length === 1 ? 'tab' : 'tabs'}.`);
      button(element, 'Stop control', async () => options.controller.revoke(requestId));
      content.append(element);
    }
  }
  const unsubscribe = options.controller.subscribe(render);
  render(options.controller.snapshot());
  return { dispose() {
    disposed = true;
    unsubscribe();
    host.remove();
  } };
}
