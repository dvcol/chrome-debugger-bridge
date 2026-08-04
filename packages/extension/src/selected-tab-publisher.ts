import type { CapabilityGrant, PublishedTarget } from '@dvcol/chrome-debugger-bridge/protocol';

export interface ChromeDebuggerPort {
  attach: (target: { readonly tabId: number }, requiredVersion: string) => Promise<void> | void;
  detach: (target: { readonly tabId: number }) => Promise<void> | void;
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
  readonly metadataPolicy?: (tab: Omit<SelectedTab, 'tabId'>) => Pick<PublishedTarget, 'title' | 'url'>;
  readonly publishTarget: (target: PublishedTarget) => Promise<void> | void;
  readonly revokeTarget: (target: Pick<PublishedTarget, 'generation' | 'id'>) => Promise<void> | void;
  readonly scopeId: string;
}

export interface SelectedTabPublisher {
  publish: (tab: SelectedTab) => Promise<PublishedTarget>;
  revoke: () => Promise<void>;
}

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

  async function revoke(): Promise<void> {
    if (publishedTarget === undefined || selectedTabId === undefined) {
      return;
    }
    const targetToRevoke = publishedTarget;
    const tabIdToDetach = selectedTabId;
    publishedTarget = undefined;
    selectedTabId = undefined;
    await options.revokeTarget(targetToRevoke);
    await options.chromeDebugger.detach({ tabId: tabIdToDetach });
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

      await revoke();
      await options.chromeDebugger.attach({ tabId: tab.tabId }, '1.3');
      const tabMetadata = {
        incognito: tab.incognito,
        ...(tab.title === undefined ? {} : { title: tab.title }),
        ...(tab.url === undefined ? {} : { url: tab.url }),
      };
      const metadata = options.metadataPolicy?.(tabMetadata) ?? {};
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
      return target;
    },
    revoke,
  };
}
