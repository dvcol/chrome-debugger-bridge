import type { SelectedTab, SelectedTabPublisher } from '../src/selected-tab-publisher.js';

import { expect, it, vi } from 'vitest';

import { createTabScopeLifecycle } from '../src/tab-scope-lifecycle.js';

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

function createPublisher(): SelectedTabPublisher {
  return {
    attachChildSession: vi.fn(),
    debuggerDetached: vi.fn(async () => {}),
    debuggerEvent: vi.fn(),
    detachChildSession: vi.fn(),
    executeCommand: vi.fn(),
    publish: vi.fn(async () => ({}) as never),
    publishEvent: vi.fn(),
    refresh: vi.fn(async () => {}),
    renewAuthority: vi.fn(),
    revoke: vi.fn(async () => {}),
    tabClosed: vi.fn(async () => {}),
  };
}

async function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

it('keeps the active tab selector as a snapshot through focus churn', async () => {
  expect.assertions(5);
  const onCreated = createChromeEvent<(tab: SelectedTab) => void>();
  const onRemoved = createChromeEvent<(tabId: number) => void>();
  const onUpdated = createChromeEvent<(tabId: number, changeInfo: unknown, tab: SelectedTab) => void>();
  const activePublisher = createPublisher();
  const newActivePublisher = createPublisher();
  const lifecycle = createTabScopeLifecycle({
    chrome: { tabs: { onCreated, onRemoved, onUpdated, async query() {
      return [{ active: true, incognito: false, tabId: 1, url: 'https://example.com/' }];
    } } },
    createPublisher(tab) {
      return tab.tabId === 1 ? activePublisher : newActivePublisher;
    },
    selector: { kind: 'active-tab' },
  });

  lifecycle.start();
  await flush();
  onUpdated.listeners[0]?.(1, { active: false }, { active: false, incognito: false, tabId: 1, url: 'https://example.com/' });
  onUpdated.listeners[0]?.(2, { active: true }, { active: true, incognito: false, tabId: 2, url: 'https://example.com/' });
  await flush();

  expect(activePublisher.publish).toHaveBeenCalledOnce();
  expect(activePublisher.refresh).toHaveBeenCalledOnce();
  expect(activePublisher.revoke).not.toHaveBeenCalled();
  expect(newActivePublisher.publish).not.toHaveBeenCalled();
  lifecycle.stop();
  expect(activePublisher.revoke).toHaveBeenCalledOnce();
});

it('reconciles current and future window members without broadening a tab publisher', async () => {
  expect.assertions(7);
  const onCreated = createChromeEvent<(tab: SelectedTab) => void>();
  const onRemoved = createChromeEvent<(tabId: number) => void>();
  const onUpdated = createChromeEvent<(tabId: number, changeInfo: unknown, tab: SelectedTab) => void>();
  const onWindowRemoved = createChromeEvent<(windowId: number) => void>();
  const initialPublisher = createPublisher();
  const scriptOpenedPublisher = createPublisher();
  const lifecycle = createTabScopeLifecycle({
    chrome: {
      tabs: { onCreated, onRemoved, onUpdated, async query() {
        return [{ incognito: false, tabId: 1, url: 'https://example.com/', windowId: 3 }];
      } },
      windows: { onRemoved: onWindowRemoved },
    },
    createPublisher(tab) {
      return tab.tabId === 1 ? initialPublisher : scriptOpenedPublisher;
    },
    selector: { kind: 'window', windowId: 3 },
  });

  lifecycle.start();
  await flush();
  onCreated.listeners[0]?.({ incognito: false, tabId: 2, url: 'https://example.com/', windowId: 3 });
  await flush();
  onUpdated.listeners[0]?.(1, { windowId: 4 }, { incognito: false, tabId: 1, url: 'https://example.com/', windowId: 4 });
  await flush();
  onWindowRemoved.listeners[0]?.(3);
  await flush();

  expect(initialPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({ tabId: 1 }));
  expect(scriptOpenedPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({ tabId: 2 }));
  expect(initialPublisher.revoke).toHaveBeenCalledWith('policy-invalid');
  expect(scriptOpenedPublisher.revoke).toHaveBeenCalledWith('closed');
  expect(onCreated.listeners).toHaveLength(1);
  lifecycle.stop();
  expect(onCreated.listeners).toHaveLength(0);
  expect(onWindowRemoved.listeners).toHaveLength(0);
});
