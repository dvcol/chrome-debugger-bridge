import type { JsonObject } from '@dvcol/cdb/protocol';

import type { ChromeDebuggerEventSource, SelectedTab, SelectedTabPublisher } from './selected-tab-publisher.js';

interface ChromeEvent<Listener> {
  addListener: (listener: Listener) => void;
  removeListener: (listener: Listener) => void;
}

export interface ChromeSelectedTabLifecyclePort {
  readonly debugger: {
    readonly onDetach: ChromeEvent<(source: { readonly tabId?: number }) => void>;
    readonly onEvent: ChromeEvent<(source: ChromeDebuggerEventSource, method: string, parameters: JsonObject) => void>;
  };
  readonly tabs: {
    readonly onRemoved: ChromeEvent<(tabId: number) => void>;
    readonly onUpdated: ChromeEvent<(tabId: number, changeInfo: unknown, tab: SelectedTab) => void>;
  };
}

export interface SelectedTabLifecycle {
  start: () => void;
  stop: () => void;
}

export interface SelectedTabLifecycleOptions {
  readonly chrome: ChromeSelectedTabLifecyclePort;
  readonly onError?: (error: unknown) => void;
  readonly publisher: SelectedTabPublisher;
}

/** Binds Chrome lifecycle events to the selected target without exposing tab identifiers to broker code. */
export function createSelectedTabLifecycle(options: SelectedTabLifecycleOptions): SelectedTabLifecycle {
  let started = false;

  function reportFailure(task: Promise<void>): void {
    void task.catch(error => options.onError?.(error));
  }

  function onUpdated(tabId: number, _changeInfo: unknown, tab: SelectedTab): void {
    reportFailure(options.publisher.refresh({ ...tab, tabId }));
  }

  function onRemoved(tabId: number): void {
    reportFailure(options.publisher.tabClosed(tabId));
  }

  function onDetach(source: { readonly tabId?: number }): void {
    if (source.tabId !== undefined) reportFailure(options.publisher.debuggerDetached(source.tabId));
  }

  function onEvent(source: ChromeDebuggerEventSource, method: string, parameters: JsonObject): void {
    options.publisher.debuggerEvent(source, method, parameters);
  }

  return {
    start() {
      if (started) return;
      started = true;
      options.chrome.tabs.onUpdated.addListener(onUpdated);
      options.chrome.tabs.onRemoved.addListener(onRemoved);
      options.chrome.debugger.onDetach.addListener(onDetach);
      options.chrome.debugger.onEvent.addListener(onEvent);
    },
    stop() {
      if (!started) return;
      started = false;
      options.chrome.tabs.onUpdated.removeListener(onUpdated);
      options.chrome.tabs.onRemoved.removeListener(onRemoved);
      options.chrome.debugger.onDetach.removeListener(onDetach);
      options.chrome.debugger.onEvent.removeListener(onEvent);
    },
  };
}
