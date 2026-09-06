import type { SelectedTab, SelectedTabPublisher } from './selected-tab-publisher.js';
import type { TabScopeManager } from './tab-scope-manager.js';
import type { TabScopeSelector } from './tab-scope.js';

import { createTabScopeManager } from './tab-scope-manager.js';

interface ChromeEvent<Listener> {
  addListener: (listener: Listener) => void;
  removeListener: (listener: Listener) => void;
}

export interface ChromeTabScopeLifecyclePort {
  readonly tabs: {
    readonly onCreated: ChromeEvent<(tab: SelectedTab) => void>;
    readonly onRemoved: ChromeEvent<(tabId: number) => void>;
    readonly onUpdated: ChromeEvent<(tabId: number, changeInfo: unknown, tab: SelectedTab) => void>;
    query: (queryInfo: object) => Promise<SelectedTab[]>;
  };
  readonly tabGroups?: {
    readonly onRemoved?: ChromeEvent<(group: { readonly id: number }) => void>;
    readonly onUpdated: ChromeEvent<(group: { readonly id: number }) => void>;
  };
  readonly windows?: { readonly onRemoved: ChromeEvent<(windowId: number) => void> };
}

export interface TabScopeLifecycle {
  start: () => void;
  stop: () => void;
}

export interface TabScopeLifecycleOptions {
  readonly chrome: ChromeTabScopeLifecyclePort;
  /** Creates a separately tab-gated publisher, so each public target keeps its own opaque identity. */
  readonly createPublisher: (tab: SelectedTab) => SelectedTabPublisher;
  readonly onError?: (error: unknown) => void;
  readonly selector: TabScopeSelector;
}

/** Publishes one selector through the same race-safe lifecycle used by shared scope managers. */
export function createTabScopeLifecycle(options: TabScopeLifecycleOptions): TabScopeLifecycle {
  let manager: TabScopeManager | undefined;
  let cleanup = Promise.resolve();
  let started = false;
  let generation = 0;

  function report(task: Promise<unknown>): void {
    void task.catch(error => options.onError?.(error));
  }

  return {
    start() {
      if (started) return;
      started = true;
      const currentGeneration = ++generation;
      report(cleanup.catch(() => {}).then(async () => {
        if (!started || generation !== currentGeneration) return;
        manager = createTabScopeManager(options);
        await manager.addScope('selected-scope', options.selector);
      }));
    },
    stop() {
      if (!started) return;
      started = false;
      generation += 1;
      const currentManager = manager;
      manager = undefined;
      if (currentManager !== undefined) {
        cleanup = currentManager.dispose();
        report(cleanup);
      }
    },
  };
}
