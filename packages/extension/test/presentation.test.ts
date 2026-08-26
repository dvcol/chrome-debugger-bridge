// @vitest-environment jsdom

import { expect, it } from 'vitest';

import {
  createAgentControlPresenter,
  translateAgentControlInputCommand,
} from '../src/presentation.js';

it('translates only successful pointer-shaped CDP input data', () => {
  expect.assertions(3);
  expect(translateAgentControlInputCommand({
    method: 'Input.dispatchMouseEvent',
    parameters: { button: 'left', clickCount: 2, type: 'mouseReleased', x: 12, y: 24 },
    sessionId: '80000000-0000-4000-8000-000000000001',
  })).toEqual([
    { button: 'left', kind: 'pointer-release', sessionId: '80000000-0000-4000-8000-000000000001', x: 12, y: 24 },
    { button: 'left', clickCount: 2, kind: 'pointer-click', sessionId: '80000000-0000-4000-8000-000000000001', x: 12, y: 24 },
  ]);
  expect(translateAgentControlInputCommand({
    method: 'Input.dispatchMouseEvent',
    parameters: { type: 'mouseMoved', x: 4, y: 8 },
  })).toEqual([{ kind: 'pointer-move', x: 4, y: 8 }]);
  expect(translateAgentControlInputCommand({
    method: 'Input.insertText',
    parameters: { text: 'secret' },
  })).toEqual([]);
});

it('isolates pointer presentation and preserves every page favicon', async () => {
  expect.assertions(14);
  document.documentElement.innerHTML = '<head><link rel="icon" href="/first.ico"><link rel="shortcut icon" href="/second.ico"></head><body></body>';
  const pageFavicons = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
  const presenter = createAgentControlPresenter({ document });
  expect(createAgentControlPresenter({ document })).toBe(presenter);

  presenter.update({ active: true, controllerCount: 2 });
  const host = document.querySelector<HTMLElement>('[data-cdb-agent-control="pointer"]');
  const controlFavicon = document.querySelector<HTMLLinkElement>('[data-cdb-agent-control="favicon"]');
  expect(host).not.toBeNull();
  expect(host?.hidden).toBe(false);
  expect(host?.style.pointerEvents).toBe('');
  expect(controlFavicon?.href).toContain('data:image/svg+xml');
  expect(pageFavicons.every(favicon => favicon.isConnected)).toBe(true);
  expect(pageFavicons.map(favicon => favicon.getAttribute('href'))).toEqual(['/first.ico', '/second.ico']);

  presenter.present({ kind: 'pointer-move', x: 30, y: 40 });
  presenter.present({ button: 'left', kind: 'pointer-press', x: 30, y: 40 });
  const pointer = host?.shadowRoot?.querySelector<HTMLElement>('.pointer');
  expect(pointer?.style.transform).toBe('translate3d(30px, 40px, 0)');
  expect(pointer?.dataset.pressed).toBe('true');
  expect(host?.shadowRoot?.querySelector('style')?.textContent).toContain('prefers-reduced-motion');

  const newPageFavicon = document.createElement('link');
  newPageFavicon.rel = 'icon';
  newPageFavicon.href = '/third.ico';
  document.head.append(newPageFavicon);
  await new Promise(resolve => window.setTimeout(resolve, 0));
  expect(document.head.lastElementChild).toBe(controlFavicon);

  presenter.dispose();
  expect(document.querySelector('[data-cdb-agent-control="pointer"]')).toBeNull();
  expect(document.querySelector('[data-cdb-agent-control="favicon"]')).toBeNull();
  expect(pageFavicons.every(favicon => favicon.isConnected) && newPageFavicon.isConnected).toBe(true);
});
