import type { CapabilityGrant, CdpCommand, JsonObject, PublishedTarget } from '@dvcol/chrome-debugger-bridge/protocol';

export interface ChromeDebuggerPort {
  attach: (target: { readonly tabId: number }, requiredVersion: string) => Promise<void> | void;
  detach: (target: { readonly tabId: number }) => Promise<void> | void;
  sendCommand: (target: { readonly tabId: number }, method: string, parameters?: JsonObject) => Promise<JsonObject>;
}

export interface SelectedTab {
  readonly incognito: boolean;
  readonly tabId: number;
  readonly title?: string;
  readonly url?: string;
}

export interface SelectedTabPublisherOptions {
  readonly capabilities: CapabilityGrant;
  readonly chromeDebugger: ChromeDebuggerPort;
  readonly isExposureAllowed?: (tab: Omit<SelectedTab, 'tabId'>) => boolean;
  readonly metadataPolicy?: (tab: Omit<SelectedTab, 'tabId'>) => Pick<PublishedTarget, 'title' | 'url'>;
  readonly publishTarget: (target: PublishedTarget) => Promise<void> | void;
  readonly publishEvent?: (target: Pick<PublishedTarget, 'generation' | 'id'>, method: string, parameters: JsonObject) => void;
  readonly registerTargetExecutor?: (target: PublishedTarget, executor: {
    execute: (command: CdpCommand, abortSignal: AbortSignal) => Promise<JsonObject>;
    setSubscriptionDemand: (methodPrefix: string, active: boolean) => Promise<void>;
  }) => void;
  readonly revokeTarget: (target: Pick<PublishedTarget, 'generation' | 'id'>, reason: 'closed' | 'detached' | 'explicit' | 'policy-invalid') => Promise<void> | void;
  readonly scopeId: string;
  readonly updateTarget: (target: PublishedTarget) => Promise<void> | void;
}

export interface SelectedTabPublisher {
  executeCommand: (command: CdpCommand, abortSignal: AbortSignal) => Promise<JsonObject>;
  publishEvent: (method: string, parameters: JsonObject) => void;
  publish: (tab: SelectedTab) => Promise<PublishedTarget>;
  refresh: (tab: SelectedTab) => Promise<void>;
  revoke: (reason?: 'closed' | 'detached' | 'explicit' | 'policy-invalid') => Promise<void>;
  tabClosed: (tabId: number) => Promise<void>;
  debuggerDetached: (tabId: number) => Promise<void>;
}

const domainNamePattern = /^[A-Za-z]+$/u;

function isSupportedPage(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Keeps Chrome's tab identifier in this closure and publishes only a lifecycle-bound opaque target. */
export function createSelectedTabPublisher(options: SelectedTabPublisherOptions): SelectedTabPublisher {
  let selectedTabId: number | undefined;
  let publishedTarget: PublishedTarget | undefined;

  function getRedactedMetadata(tab: Omit<SelectedTab, 'tabId'>): Pick<PublishedTarget, 'title' | 'url'> {
    return options.metadataPolicy?.(tab) ?? {};
  }

  function isPublishable(tab: SelectedTab): boolean {
    return !tab.incognito && isSupportedPage(tab.url) && (options.isExposureAllowed?.(tab) ?? true);
  }

  async function revoke(reason: 'closed' | 'detached' | 'explicit' | 'policy-invalid' = 'explicit'): Promise<void> {
    if (publishedTarget === undefined || selectedTabId === undefined) {
      return;
    }
    const targetToRevoke = publishedTarget;
    const tabIdToDetach = selectedTabId;
    publishedTarget = undefined;
    selectedTabId = undefined;
    await options.revokeTarget(targetToRevoke, reason);
    await options.chromeDebugger.detach({ tabId: tabIdToDetach });
  }

  async function executeCommand(command: CdpCommand, abortSignal: AbortSignal): Promise<JsonObject> {
    if (publishedTarget === undefined || selectedTabId === undefined) {
      throw new Error('The requested target is not available.');
    }
    if (abortSignal.aborted) {
      throw new Error('The requested command was cancelled.');
    }
    if (
      command.targetId !== publishedTarget.id
      || command.targetGeneration !== publishedTarget.generation
      || !publishedTarget.capabilities.methods.includes(command.method)
    ) {
      throw new Error('The requested command is not permitted.');
    }
    try {
      const value = await options.chromeDebugger.sendCommand({ tabId: selectedTabId }, command.method, command.parameters);
      if (abortSignal.aborted) {
        throw new Error('The requested command was cancelled.');
      }
      return value;
    } catch {
      throw new Error('The debugger command failed.');
    }
  }

  function publishEvent(method: string, parameters: JsonObject): void {
    if (publishedTarget === undefined) return;
    options.publishEvent?.(publishedTarget, method, parameters);
  }

  async function setSubscriptionDemand(methodPrefix: string, active: boolean): Promise<void> {
    if (selectedTabId === undefined) throw new Error('The requested target is not available.');
    const domain = methodPrefix.split('.', 1)[0];
    if (domain === undefined || !domainNamePattern.test(domain)) throw new Error('The subscription method is invalid.');
    const command = `${domain}.${active ? 'enable' : 'disable'}`;
    if (!options.capabilities.methods.includes(command)) return;
    try {
      await options.chromeDebugger.sendCommand({ tabId: selectedTabId }, command);
    } catch {
      throw new Error('The debugger subscription setup failed.');
    }
  }

  return {
    async publish(tab) {
      if (!Number.isSafeInteger(tab.tabId) || tab.tabId < 0) {
        throw new Error('The selected tab is invalid.');
      }
      if (tab.incognito) {
        throw new Error('Incognito tabs cannot be published.');
      }
      if (!isSupportedPage(tab.url)) {
        throw new Error('The selected page is not supported.');
      }
      if (!(options.isExposureAllowed?.(tab) ?? true)) {
        throw new Error('The selected page is not authorized for publication.');
      }

      await revoke();
      await options.chromeDebugger.attach({ tabId: tab.tabId }, '1.3');
      const tabMetadata = {
        incognito: tab.incognito,
        ...(tab.title === undefined ? {} : { title: tab.title }),
        ...(tab.url === undefined ? {} : { url: tab.url }),
      };
      const metadata = getRedactedMetadata(tabMetadata);
      const target: PublishedTarget = {
        availability: 'available',
        capabilities: options.capabilities,
        generation: 1,
        id: globalThis.crypto.randomUUID(),
        scopeId: options.scopeId,
        type: 'page',
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        ...(metadata.url === undefined ? {} : { url: metadata.url }),
      };

      try {
        await options.publishTarget(target);
      } catch (error) {
        await options.chromeDebugger.detach({ tabId: tab.tabId });
        throw error;
      }
      selectedTabId = tab.tabId;
      publishedTarget = target;
      options.registerTargetExecutor?.(target, { execute: executeCommand, setSubscriptionDemand });
      return target;
    },
    async refresh(tab) {
      if (selectedTabId === undefined || publishedTarget === undefined || tab.tabId !== selectedTabId) return;
      if (!isPublishable(tab)) {
        await revoke('policy-invalid');
        return;
      }
      const metadata = getRedactedMetadata({
        incognito: tab.incognito,
        ...(tab.title === undefined ? {} : { title: tab.title }),
        ...(tab.url === undefined ? {} : { url: tab.url }),
      });
      const updatedTarget: PublishedTarget = {
        availability: publishedTarget.availability,
        capabilities: publishedTarget.capabilities,
        generation: publishedTarget.generation,
        id: publishedTarget.id,
        scopeId: publishedTarget.scopeId,
        type: publishedTarget.type,
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        ...(metadata.url === undefined ? {} : { url: metadata.url }),
      };
      if (JSON.stringify(updatedTarget) === JSON.stringify(publishedTarget)) return;
      await options.updateTarget(updatedTarget);
      publishedTarget = updatedTarget;
    },
    async tabClosed(tabId) {
      if (tabId === selectedTabId) await revoke('closed');
    },
    async debuggerDetached(tabId) {
      if (tabId === selectedTabId) await revoke('detached');
    },
    executeCommand,
    publishEvent,
    revoke,
  };
}
