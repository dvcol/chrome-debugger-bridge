import type { JsonObject } from '@dvcol/cdb/protocol';

export type AgentControlPresentationEvent
  = (
    | { readonly kind: 'pointer-click'; readonly button: string; readonly clickCount: number; readonly x: number; readonly y: number }
    | { readonly kind: 'pointer-move'; readonly x: number; readonly y: number }
    | { readonly kind: 'pointer-press'; readonly button: string; readonly x: number; readonly y: number }
    | { readonly kind: 'pointer-release'; readonly button: string; readonly x: number; readonly y: number }
  ) & { readonly sessionId?: string };

export interface AgentControlPresentationState {
  readonly active: boolean;
  readonly controllerCount?: number;
}

export interface AgentControlPresenter {
  dispose: () => void;
  present: (event: AgentControlPresentationEvent) => void;
  update: (state: AgentControlPresentationState) => void;
}

export interface CreateAgentControlPresenterOptions {
  readonly document: Document;
}

export interface AgentControlInputCommand {
  readonly method: string;
  readonly parameters?: JsonObject | undefined;
  readonly sessionId?: string | undefined;
}

const presentersByDocument = new WeakMap<Document, AgentControlPresenter>();
const relationWhitespacePattern = /\s+/u;

function finiteCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Converts successful CDP pointer commands into data safe to send to an in-page presenter. */
export function translateAgentControlInputCommand(
  command: AgentControlInputCommand,
): readonly AgentControlPresentationEvent[] {
  if (command.method !== 'Input.dispatchMouseEvent') return [];
  const x = finiteCoordinate(command.parameters?.x);
  const y = finiteCoordinate(command.parameters?.y);
  const type = command.parameters?.type;
  if (x === undefined || y === undefined || typeof type !== 'string') return [];
  const button = typeof command.parameters?.button === 'string'
    ? command.parameters.button
    : 'none';
  const session = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
  if (type === 'mouseMoved' || type === 'mouseWheel')
    return [{ kind: 'pointer-move', ...session, x, y }];
  if (type === 'mousePressed')
    return [{ button, kind: 'pointer-press', ...session, x, y }];
  if (type !== 'mouseReleased') return [];
  const clickCount = finiteCoordinate(command.parameters?.clickCount) ?? 0;
  return [
    { button, kind: 'pointer-release', ...session, x, y },
    ...(clickCount > 0
      ? [{ button, clickCount, kind: 'pointer-click' as const, ...session, x, y }]
      : []),
  ];
}

function controlFavicon(controllerCount: number): string {
  const count = controllerCount > 1
    ? `<text x="24" y="25" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="white">${controllerCount > 9 ? '9+' : controllerCount}</text>`
    : '<circle cx="24" cy="24" r="7" fill="white"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#7c3aed" stroke="white" stroke-width="3"/>${count}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Creates one isolated, opt-in control indicator for an extension content script. */
export function createAgentControlPresenter(
  options: CreateAgentControlPresenterOptions,
): AgentControlPresenter {
  const { document } = options;
  const existingPresenter = presentersByDocument.get(document);
  if (existingPresenter !== undefined) return existingPresenter;
  const host = document.createElement('div');
  host.dataset.cdbAgentControl = 'pointer';
  host.setAttribute('aria-hidden', 'true');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; pointer-events: none !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }
    :host([hidden]) { display: none !important; }
    .pointer { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 2px solid white; border-radius: 50%; background: #7c3aed; box-shadow: 0 1px 5px rgb(0 0 0 / 45%); transform: translate3d(-100px, -100px, 0); transition: transform 120ms cubic-bezier(.2,.8,.2,1), scale 80ms ease; }
    .pointer[data-pressed="true"] { scale: .72; }
    .pulse { position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border: 3px solid #7c3aed; border-radius: 50%; opacity: 0; }
    .pulse[data-active="true"] { animation: cdb-agent-control-pulse 360ms ease-out; }
    @keyframes cdb-agent-control-pulse { from { opacity: .9; scale: .35; } to { opacity: 0; scale: 1.4; } }
    @media (prefers-reduced-motion: reduce) { .pointer { transition: none; } .pulse[data-active="true"] { animation: none; } }
  `;
  const pointer = document.createElement('div');
  pointer.className = 'pointer';
  pointer.dataset.pressed = 'false';
  const pulse = document.createElement('div');
  pulse.className = 'pulse';
  shadowRoot.append(style, pulse, pointer);
  document.documentElement.append(host);

  let active = false;
  let controllerCount = 1;
  let disposed = false;
  let favicon: HTMLLinkElement | undefined;
  const pageFaviconStates = new Map<HTMLLinkElement, {
    desiredRel: string;
    neutralRel: string;
  }>();

  const neutralRel = (rel: string): string => rel
    .split(relationWhitespacePattern)
    .filter(token => token.length > 0 && token.toLowerCase() !== 'icon')
    .join(' ');
  const neutralizePageFavicon = (candidate: HTMLLinkElement): void => {
    if (candidate === favicon || candidate.dataset.cdbAgentControl === 'favicon') return;
    const currentRel = candidate.getAttribute('rel') ?? '';
    const priorState = pageFaviconStates.get(candidate);
    if (priorState !== undefined && currentRel === priorState.neutralRel) return;
    if (!candidate.relList.contains('icon')) {
      if (priorState !== undefined) priorState.desiredRel = currentRel;
      return;
    }
    const state = priorState ?? { desiredRel: currentRel, neutralRel: '' };
    state.desiredRel = currentRel;
    state.neutralRel = neutralRel(currentRel);
    pageFaviconStates.set(candidate, state);
    candidate.setAttribute('rel', state.neutralRel);
  };
  const neutralizePageFavicons = (root: ParentNode): void => {
    if (root instanceof document.defaultView!.HTMLLinkElement)
      neutralizePageFavicon(root);
    for (const candidate of root.querySelectorAll<HTMLLinkElement>('link'))
      neutralizePageFavicon(candidate);
  };
  const restorePageFavicons = (): void => {
    for (const [candidate, state] of pageFaviconStates) {
      if (candidate.isConnected) candidate.setAttribute('rel', state.desiredRel);
    }
    pageFaviconStates.clear();
  };

  const removeFavicon = (): void => {
    favicon?.remove();
    favicon = undefined;
  };
  const ensureFavicon = (): void => {
    if (!active || disposed || document.head === null) return;
    neutralizePageFavicons(document.head);
    if (favicon === undefined) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      favicon.dataset.cdbAgentControl = 'favicon';
    }
    favicon.href = controlFavicon(controllerCount);
    if (document.head.lastElementChild !== favicon) document.head.append(favicon);
  };
  const MutationObserverConstructor = document.defaultView?.MutationObserver;
  const faviconObserver = MutationObserverConstructor === undefined
    ? undefined
    : new MutationObserverConstructor((records) => {
        if (!active || disposed) return;
        for (const record of records) {
          if (record.type === 'attributes' && record.target instanceof document.defaultView!.HTMLLinkElement)
            neutralizePageFavicon(record.target);
          for (const addedNode of record.addedNodes) {
            if (addedNode instanceof document.defaultView!.Element)
              neutralizePageFavicons(addedNode);
          }
        }
        ensureFavicon();
      });
  if (document.head !== null)
    faviconObserver?.observe(document.head, {
      attributeFilter: ['rel'],
      attributes: true,
      childList: true,
      subtree: true,
    });

  function position(x: number, y: number): void {
    const transform = `translate3d(${x}px, ${y}px, 0)`;
    pointer.style.transform = transform;
    pulse.style.transform = transform;
  }

  const presenter: AgentControlPresenter = {
    dispose() {
      if (disposed) return;
      disposed = true;
      faviconObserver?.disconnect();
      removeFavicon();
      restorePageFavicons();
      host.remove();
      if (presentersByDocument.get(document) === presenter)
        presentersByDocument.delete(document);
    },
    present(event) {
      if (disposed || !active) return;
      position(event.x, event.y);
      if (event.kind === 'pointer-press') pointer.dataset.pressed = 'true';
      if (event.kind === 'pointer-release') pointer.dataset.pressed = 'false';
      if (event.kind === 'pointer-click') {
        pulse.dataset.active = 'false';
        void pulse.getBoundingClientRect();
        pulse.dataset.active = 'true';
      }
    },
    update(state) {
      if (disposed) return;
      active = state.active;
      controllerCount = Math.max(1, Math.trunc(state.controllerCount ?? 1));
      host.hidden = !active;
      if (active) ensureFavicon();
      else {
        removeFavicon();
        restorePageFavicons();
      }
    },
  };
  presentersByDocument.set(document, presenter);
  return presenter;
}
