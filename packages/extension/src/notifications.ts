import type { BrokerGrant, BrokerRequest, BrokerState } from '@dvcol/cdb-broker/contract';

import type { BrowserControlNotificationColorMode, BrowserControlNotificationThemeOverrides } from './notification-theme.js';

import { browserControlNotificationStyles, updateNotificationTheme } from './notification-theme.js';

export { defaultBrowserControlNotificationTheme } from './notification-theme.js';
export type { BrowserControlNotificationColorMode, BrowserControlNotificationPalette, BrowserControlNotificationTheme, BrowserControlNotificationThemeOverrides } from './notification-theme.js';

export interface BrowserControlNotification {
  readonly grants: readonly BrokerGrant[];
  readonly requests: readonly BrokerRequest[];
}

export interface BrowserControlNotificationController {
  dismiss: (requestId: string) => void;
  dispose: () => void;
  reject: (requestId: string) => Promise<void>;
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
  /** Authoritatively denies a pending request. Distinct from `dismiss`, which never rejects. */
  readonly onReject: (requestId: string) => Promise<void>;
  readonly onRevoke: (requestId: string) => Promise<void>;
}

/** Derives notification state from the broker. Dismissal is presentation-only and never rejects a request. */
export function createBrowserControlNotificationController(options: BrowserControlNotificationOptions): BrowserControlNotificationController {
  defineNotifications(options);
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
    async reject(requestId) {
      const request = snapshot().requests.find(candidate => candidate.id === requestId);
      if (request === undefined) throw new Error('The browser access request is no longer pending.');
      await options.onReject(requestId);
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
  readonly theme?: BrowserControlNotificationThemeOverrides;
  readonly colorMode?: BrowserControlNotificationColorMode;
  /** Describe the host's action, including direct approval when the host provides that policy. */
  readonly reviewLabel?: (request: BrokerRequest) => string;
  readonly clientLabel?: (request: BrokerRequest) => string;
  /** Overrides the authoritative reject action; defaults to `controller.reject`. Dismissal remains local regardless. */
  readonly onReject?: (request: BrokerRequest) => Promise<void>;
  /** Host-supplied CSS, applied inside the isolated notification root. */
  readonly css?: string;
}

export interface BrowserControlNotificationRenderer {
  dispose: () => void;
  setTheme: (theme: BrowserControlNotificationThemeOverrides) => void;
  setColorMode: (mode: BrowserControlNotificationColorMode) => void;
}

/** Optional themed presentation. Pending request cards delegate to the host's trusted final approval UI. */
export function renderBrowserControlNotifications(options: BrowserControlNotificationRendererOptions): BrowserControlNotificationRenderer {
  defineNotificationRenderer(options);
  const document = options.container.ownerDocument;
  const host = document.createElement('section');
  host.dataset.cdbNotifications = '';
  const root = host.attachShadow({ mode: 'open' });
  const window = document.defaultView;
  if (window === null) throw new Error('Notification rendering requires a document attached to a window.');
  const baseStylesheet = new window.CSSStyleSheet();
  const themeStylesheet = new window.CSSStyleSheet();
  const customStylesheet = new window.CSSStyleSheet();
  baseStylesheet.replaceSync(browserControlNotificationStyles);
  customStylesheet.replaceSync(options.css ?? '');
  root.adoptedStyleSheets = [baseStylesheet, themeStylesheet, customStylesheet];

  function setTheme(theme: BrowserControlNotificationThemeOverrides): void {
    updateNotificationTheme(themeStylesheet, theme, options.branding?.accent);
  }
  function setColorMode(mode: BrowserControlNotificationColorMode): void {
    host.dataset.colorMode = mode;
  }
  setTheme(options.theme ?? {});
  setColorMode(options.colorMode ?? 'system');
  const content = document.createElement('div');
  root.append(content);
  options.container.append(host);
  let disposed = false;
  let renderedNotification: string | undefined;

  async function invokeAction(
    container: HTMLElement,
    action: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (disposed) return;
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = error instanceof Error ? error.message : 'The browser request could not be completed.';
      container.append(message);
    }
  }

  async function runAction(
    button: HTMLButtonElement,
    container: HTMLElement,
    action: () => void | Promise<void>,
  ): Promise<void> {
    button.disabled = true;
    try {
      await invokeAction(container, action);
    } finally {
      button.disabled = false;
    }
  }

  function createActionButton(
    container: HTMLElement,
    label: string,
    action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = (event) => {
      event.stopPropagation();
      void runAction(button, container, action);
    };
    container.append(button);
    return button;
  }

  function createCard(title: string, description?: string): HTMLElement {
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
  function createRequestDetails(request: BrokerRequest): HTMLElement {
    const details = document.createElement('dl');
    const values = [
      ['Client', options.clientLabel?.(request) ?? request.principalLabel],
      ['Grant', request.level],
      ['Navigation', request.navigation],
    ] as const;
    for (const [label, value] of values) {
      const column = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const definition = document.createElement('dd');
      const text = document.createElement('code');
      text.textContent = value;
      if (label === 'Grant') text.dataset.level = request.level;
      definition.append(text);
      column.append(term, definition);
      details.append(column);
    }
    return details;
  }

  function render(notification: BrowserControlNotification): void {
    if (disposed) return;
    /** Unrelated broker publications must not replace focused or pending controls. */
    const serializedNotification = JSON.stringify(notification);
    if (serializedNotification === renderedNotification) return;
    renderedNotification = serializedNotification;
    content.replaceChildren();
    for (const request of notification.requests) {
      const element = createCard(options.branding?.title ?? 'Browser control requested');
      element.className = 'request';
      element.onclick = () => {
        void invokeAction(element, async () => options.controller.review(request.id));
      };
      const dismiss = createActionButton(element, '×', () => options.controller.dismiss(request.id));
      dismiss.className = 'dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.title = 'Dismiss notification';
      element.append(createRequestDetails(request));
      const actions = document.createElement('footer');
      element.append(actions);
      createActionButton(actions, options.reviewLabel?.(request) ?? 'Review request', async () => options.controller.review(request.id));
      createActionButton(actions, 'Reject', async () => (options.onReject ?? (async r => options.controller.reject(r.id)))(request));
      content.append(element);
    }
    const grouped = Map.groupBy(notification.grants, grant => grant.requestId);
    for (const [requestId, grants] of grouped) {
      const grant = grants[0]!;
      const tabCount = `${grants.length} approved ${grants.length === 1 ? 'tab' : 'tabs'}`;
      const description = `${grant.principalLabel}: ${grant.level}, ${grant.navigation}. ${tabCount}.`;
      const element = createCard(options.branding?.title ?? 'Browser control', description);
      createActionButton(element, 'Stop control', async () => options.controller.revoke(requestId));
      content.append(element);
    }
  }
  const unsubscribe = options.controller.subscribe(render);
  render(options.controller.snapshot());
  return {
    setTheme,
    setColorMode,
    dispose() {
      disposed = true;
      unsubscribe();
      host.remove();
    },
  };
}

/** Defines configuration without starting the adapter or calling runtime dependencies. */
export function defineNotifications<const Definition extends BrowserControlNotificationOptions>(definition: Definition): Definition {
  return definition;
}

/** Defines configuration without starting the adapter or calling runtime dependencies. */
export function defineNotificationRenderer<const Definition extends BrowserControlNotificationRendererOptions>(definition: Definition): Definition {
  return definition;
}
