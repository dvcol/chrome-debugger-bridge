import { expect, it, vi } from 'vitest';

import { createSelectedTabLifecycle } from '../src/selected-tab-lifecycle.js';

function createChromeEvent<Listener>(): { readonly addListener: (listener: Listener) => void; readonly listeners: Listener[]; readonly removeListener: (listener: Listener) => void } {
  const listeners: Listener[] = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners,
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

it('forwards Chrome tab and debugger lifecycle events to the selected target publisher', async () => {
  expect.assertions(8);
  const onDetach = createChromeEvent<(source: { readonly tabId?: number }) => void>();
  const onRemoved = createChromeEvent<(tabId: number) => void>();
  const onUpdated = createChromeEvent<(tabId: number, changeInfo: unknown, tab: { readonly incognito: boolean; readonly tabId: number; readonly title?: string; readonly url?: string }) => void>();
  const publisher = {
    debuggerDetached: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    tabClosed: vi.fn(async () => {}),
  };
  const lifecycle = createSelectedTabLifecycle({
    chrome: { debugger: { onDetach }, tabs: { onRemoved, onUpdated } },
    publisher: publisher as never,
  });

  lifecycle.start();
  lifecycle.start();
  onUpdated.listeners[0]?.(42, { status: 'complete' }, { incognito: false, tabId: 0, title: 'Changed', url: 'https://example.com/' });
  onRemoved.listeners[0]?.(42);
  onDetach.listeners[0]?.({ tabId: 42 });
  onDetach.listeners[0]?.({});
  await Promise.resolve();
  lifecycle.stop();
  lifecycle.stop();

  expect(onUpdated.listeners).toEqual([]);
  expect(onRemoved.listeners).toEqual([]);
  expect(onDetach.listeners).toEqual([]);
  expect(publisher.refresh).toHaveBeenCalledWith({ incognito: false, tabId: 42, title: 'Changed', url: 'https://example.com/' });
  expect(publisher.tabClosed).toHaveBeenCalledWith(42);
  expect(publisher.debuggerDetached).toHaveBeenCalledWith(42);
  expect(publisher.debuggerDetached).toHaveBeenCalledOnce();
  expect(publisher.refresh).toHaveBeenCalledOnce();
});
