import type { CapabilityGrant, CdpCommand, JsonObject, Lease, PublishedTarget } from '@dvcol/cdb/protocol';

import type { PublicChildSession } from './child-session-router.js';
import type { TabScopeSelector } from './tab-scope.js';

import { isCdpNameAllowed, requiredLeaseMode } from '@dvcol/cdb/cdp-catalogue';

import { createChildSessionRouter } from './child-session-router.js';
import { matchesTabScope } from './tab-scope.js';

export interface ChromeDebuggerPort {
  attach: (target: { readonly sessionId?: string; readonly tabId: number }, requiredVersion: string) => Promise<void> | void;
  detach: (target: { readonly sessionId?: string; readonly tabId: number }) => Promise<void> | void;
  sendCommand: (target: { readonly sessionId?: string; readonly tabId: number }, method: string, parameters?: JsonObject) => Promise<JsonObject>;
}

export interface ChromeDebuggerEventSource {
  readonly sessionId?: string;
  readonly tabId?: number;
}

export interface SelectedTab {
  readonly active?: boolean;
  readonly groupId?: number;
  readonly incognito: boolean;
  readonly tabId: number;
  readonly title?: string;
  readonly url?: string;
  readonly windowId?: number;
}

export interface CommandAuthorizationContext {
  readonly capabilities: CapabilityGrant;
  readonly method: string;
  readonly parameters: JsonObject | undefined;
  readonly sessionId: string | undefined;
}

/** Applies extension-owned restrictions to native CDP command parameters after mandatory bridge checks. */
export type CommandAuthorizationPolicy = (context: CommandAuthorizationContext) => boolean | Promise<boolean>;

export interface SelectedTabPublisherOptions {
  readonly capabilities: CapabilityGrant;
  readonly chromeDebugger: ChromeDebuggerPort;
  /** Can make a published target's command authorization stricter, but never relax the bridge kernel. */
  readonly commandAuthorizationPolicy?: CommandAuthorizationPolicy;
  readonly isExposureAllowed?: (tab: Omit<SelectedTab, 'tabId'>) => boolean;
  readonly metadataPolicy?: (tab: Omit<SelectedTab, 'tabId'>) => Pick<PublishedTarget, 'title' | 'url'>;
  readonly publishTarget: (target: PublishedTarget) => Promise<void> | void;
  readonly publishEvent?: (target: Pick<PublishedTarget, 'generation' | 'id'>, method: string, parameters: JsonObject, sessionId?: string) => void;
  readonly registerTargetExecutor?: (target: PublishedTarget, executor: {
    execute: (command: CdpCommand, abortSignal: AbortSignal, lease: Lease) => Promise<JsonObject>;
    setSubscriptionDemand: (methodPrefix: string, active: boolean, sessionId?: string) => Promise<void>;
  }) => void;
  readonly revokeTarget: (target: Pick<PublishedTarget, 'generation' | 'id'>, reason: 'closed' | 'detached' | 'explicit' | 'policy-invalid') => Promise<void> | void;
  readonly scopeId: string;
  /** An extension-only selector; it is evaluated before every publication and refresh. */
  readonly tabScopeSelector?: TabScopeSelector;
  /** Restores one logical target during provider recovery while advancing its generation. */
  readonly targetIdentity?: Pick<PublishedTarget, 'generation' | 'id'>;
  readonly updateTarget: (target: PublishedTarget) => Promise<void> | void;
}

export interface SelectedTabPublisher {
  attachChildSession: (chromeSessionId: string) => PublicChildSession;
  debuggerEvent: (source: ChromeDebuggerEventSource, method: string, parameters: JsonObject) => void;
  executeCommand: (command: CdpCommand, abortSignal: AbortSignal, lease?: Lease) => Promise<JsonObject>;
  detachChildSession: (chromeSessionId: string) => PublicChildSession | undefined;
  publishEvent: (method: string, parameters: JsonObject) => void;
  publish: (tab: SelectedTab) => Promise<PublishedTarget>;
  refresh: (tab: SelectedTab) => Promise<void>;
  renewAuthority: () => Promise<PublishedTarget>;
  setSubscriptionDemand: (methodPrefix: string, active: boolean, sessionId?: string) => Promise<void>;
  revoke: (reason?: 'closed' | 'detached' | 'explicit' | 'policy-invalid') => Promise<void>;
  tabClosed: (tabId: number) => Promise<void>;
  debuggerDetached: (tabId: number) => Promise<void>;
}

const domainNamePattern = /^[A-Za-z]+$/u;
const eligibleChildTargetTypes = new Set(['iframe', 'service_worker', 'shared_worker', 'worker']);
const crossProfileCommandNames = new Set(['Network.clearBrowserCache', 'Network.clearBrowserCookies', 'Network.deleteCookies', 'Network.getAllCookies', 'Network.setCookie', 'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey', 'Storage.getCookies', 'Storage.setCookies']);

function isBaselineCommandAuthorized(context: CommandAuthorizationContext): boolean {
  if (crossProfileCommandNames.has(context.method)) return false;
  if (context.method !== 'Page.setDownloadBehavior') return true;
  const behavior = context.parameters?.behavior;
  return behavior === 'default' || behavior === 'deny';
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
  const childSessionRouter = createChildSessionRouter();
  const activeRootSubscriptionDomains = new Set<string>();
  const activeRootSubscriptionDemands = new Set<string>();
  const activeChildSubscriptionDemands = new Map<string, Set<string>>();
  let selectedTabId: number | undefined;
  let publishedTarget: PublishedTarget | undefined;

  function getRedactedMetadata(tab: Omit<SelectedTab, 'tabId'>): Pick<PublishedTarget, 'title' | 'url'> {
    return options.metadataPolicy?.(tab) ?? {};
  }

  function isPublishable(tab: SelectedTab): boolean {
    return !tab.incognito
      && isSupportedPage(tab.url)
      && (options.tabScopeSelector === undefined || (options.tabScopeSelector.kind === 'active-tab' && selectedTabId === tab.tabId) || matchesTabScope(options.tabScopeSelector, tab))
      && (options.isExposureAllowed?.(tab) ?? true);
  }

  async function configureFlatSessions(chromeSessionId?: string): Promise<void> {
    if (selectedTabId === undefined) throw new Error('The requested target is not available.');
    try {
      await options.chromeDebugger.sendCommand(
        { tabId: selectedTabId, ...(chromeSessionId === undefined ? {} : { sessionId: chromeSessionId }) },
        'Target.setAutoAttach',
        {
          autoAttach: true,
          filter: Array.from(eligibleChildTargetTypes, type => ({ exclude: false, type })),
          flatten: true,
          waitForDebuggerOnStart: true,
        },
      );
    } catch {
      throw new Error('The debugger session setup failed.');
    }
  }

  async function enableActiveRootDomains(chromeSessionId: string): Promise<void> {
    if (selectedTabId === undefined) throw new Error('The requested target is not available.');
    for (const domain of activeRootSubscriptionDomains) {
      await options.chromeDebugger.sendCommand({ sessionId: chromeSessionId, tabId: selectedTabId }, `${domain}.enable`);
    }
  }

  function isEligibleChildAttachment(parameters: JsonObject): parameters is JsonObject & { readonly sessionId: string; readonly targetInfo: JsonObject & { readonly type: string } } {
    const sessionId = parameters.sessionId;
    const targetInfo = parameters.targetInfo;
    return typeof sessionId === 'string'
      && targetInfo !== null
      && typeof targetInfo === 'object'
      && !Array.isArray(targetInfo)
      && typeof targetInfo.type === 'string'
      && eligibleChildTargetTypes.has(targetInfo.type);
  }

  function handleAttachedChild(parameters: JsonObject): PublicChildSession | undefined {
    if (!isEligibleChildAttachment(parameters)) return undefined;
    const childSession = childSessionRouter.attach(parameters.sessionId);
    void (async () => {
      await configureFlatSessions(parameters.sessionId);
      await enableActiveRootDomains(parameters.sessionId);
      await options.chromeDebugger.sendCommand({ sessionId: parameters.sessionId, tabId: selectedTabId! }, 'Runtime.runIfWaitingForDebugger');
    })().catch(async () => {
      const target = { sessionId: parameters.sessionId, tabId: selectedTabId! };
      try {
        await options.chromeDebugger.sendCommand(target, 'Runtime.runIfWaitingForDebugger');
      } catch {
        /** Cleanup must not replace the original child setup failure. */
      }
      try {
        await options.chromeDebugger.detach(target);
      } catch {
        /** A late Chrome detach is equivalent to completed cleanup. */
      }
      childSessionRouter.detach(parameters.sessionId);
    });
    return childSession;
  }

  function handleDetachedChild(parameters: JsonObject): void {
    if (typeof parameters.sessionId !== 'string') return;
    const detachedSession = childSessionRouter.detach(parameters.sessionId);
    if (detachedSession !== undefined) activeChildSubscriptionDemands.delete(detachedSession.id);
  }

  function invalidateChildrenOnRootNavigation(method: string, parameters: JsonObject): void {
    if (method !== 'Page.frameNavigated') return;
    const frame = parameters.frame;
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame) || frame.parentId !== undefined) return;
    childSessionRouter.revoke();
    activeChildSubscriptionDemands.clear();
  }

  async function revoke(reason: 'closed' | 'detached' | 'explicit' | 'policy-invalid' = 'explicit'): Promise<void> {
    if (publishedTarget === undefined || selectedTabId === undefined) {
      return;
    }
    const targetToRevoke = publishedTarget;
    const tabIdToDetach = selectedTabId;
    publishedTarget = undefined;
    selectedTabId = undefined;
    childSessionRouter.revoke();
    activeRootSubscriptionDomains.clear();
    activeRootSubscriptionDemands.clear();
    activeChildSubscriptionDemands.clear();
    await options.revokeTarget(targetToRevoke, reason);
    try {
      await options.chromeDebugger.detach({ tabId: tabIdToDetach });
    } catch {
      /** Chrome can report a detach event before this cleanup call reaches it. */
    }
  }

  async function executeCommand(command: CdpCommand, abortSignal: AbortSignal, lease?: Lease): Promise<JsonObject> {
    if (publishedTarget === undefined || selectedTabId === undefined) {
      throw new Error('The requested target is not available.');
    }
    if (abortSignal.aborted) {
      throw new Error('The requested command was cancelled.');
    }
    if (
      command.targetId !== publishedTarget.id
      || command.targetGeneration !== publishedTarget.generation
      || !isCdpNameAllowed(publishedTarget.capabilities, command.method, 'command')
      || lease === undefined
      || lease.id !== command.leaseId
      || lease.targetId !== publishedTarget.id
      || lease.targetGeneration !== publishedTarget.generation
      || !lease.methods.includes(command.method)
      || (lease.mode === 'shared-read' && requiredLeaseMode(publishedTarget.capabilities, [command.method]) === 'exclusive-control')
    ) {
      throw new Error('The requested command is not permitted.');
    }
    const chromeSessionId = command.sessionId === undefined ? undefined : childSessionRouter.resolve(command.sessionId);
    if (command.sessionId !== undefined && chromeSessionId === undefined) throw new Error('The requested command is not permitted.');
    const authorizationContext: CommandAuthorizationContext = {
      capabilities: publishedTarget.capabilities,
      method: command.method,
      parameters: command.parameters,
      sessionId: command.sessionId,
    };
    const isPolicyAuthorized = await options.commandAuthorizationPolicy?.(authorizationContext) ?? true;
    if (!isBaselineCommandAuthorized(authorizationContext) || !isPolicyAuthorized) {
      throw new Error('The requested command is not permitted.');
    }
    try {
      const value = await options.chromeDebugger.sendCommand({ tabId: selectedTabId, ...(chromeSessionId === undefined ? {} : { sessionId: chromeSessionId }) }, command.method, command.parameters);
      if (abortSignal.aborted) {
        throw new Error('The requested command was cancelled.');
      }
      return value;
    } catch (error) {
      throw new Error(error instanceof Error ? `The debugger command failed: ${error.message}` : 'The debugger command failed.');
    }
  }

  function publishEvent(method: string, parameters: JsonObject, sessionId?: string): void {
    if (publishedTarget === undefined || !isCdpNameAllowed(publishedTarget.capabilities, method, 'event')) return;
    options.publishEvent?.(publishedTarget, method, parameters, sessionId);
  }

  function isEventDemanded(method: string, sessionId?: string): boolean {
    if ([...activeRootSubscriptionDemands].some(demand => method.startsWith(demand))) return true;
    return sessionId !== undefined
      && [...(activeChildSubscriptionDemands.get(sessionId) ?? [])].some(demand => method.startsWith(demand));
  }

  async function setSubscriptionDemand(methodPrefix: string, active: boolean, sessionId?: string): Promise<void> {
    if (selectedTabId === undefined) throw new Error('The requested target is not available.');
    const domain = methodPrefix.split('.', 1)[0];
    if (domain === undefined || !domainNamePattern.test(domain)) throw new Error('The subscription method is invalid.');
    const chromeSessionId = sessionId === undefined ? undefined : childSessionRouter.resolve(sessionId);
    if (sessionId !== undefined && chromeSessionId === undefined) throw new Error('The requested session is not available.');
    const demands = sessionId === undefined
      ? activeRootSubscriptionDemands
      : activeChildSubscriptionDemands.get(sessionId) ?? new Set<string>();
    if (active === demands.has(methodPrefix)) return;
    const hadDomainDemand = [...demands].some(demand => demand.startsWith(`${domain}.`));
    if (active) demands.add(methodPrefix);
    else demands.delete(methodPrefix);
    const hasDomainDemand = [...demands].some(demand => demand.startsWith(`${domain}.`));
    if (sessionId !== undefined) {
      if (demands.size === 0) activeChildSubscriptionDemands.delete(sessionId);
      else activeChildSubscriptionDemands.set(sessionId, demands);
    }
    if (hadDomainDemand === hasDomainDemand) return;
    const command = `${domain}.${hasDomainDemand ? 'enable' : 'disable'}`;
    try {
      await options.chromeDebugger.sendCommand({ tabId: selectedTabId, ...(chromeSessionId === undefined ? {} : { sessionId: chromeSessionId }) }, command);
      if (sessionId === undefined) {
        if (hasDomainDemand) activeRootSubscriptionDomains.add(domain);
        else activeRootSubscriptionDomains.delete(domain);
      }
    } catch (error) {
      if (active) {
        demands.delete(methodPrefix);
        if (sessionId !== undefined && demands.size === 0) activeChildSubscriptionDemands.delete(sessionId);
      } else {
        demands.add(methodPrefix);
        if (sessionId !== undefined) activeChildSubscriptionDemands.set(sessionId, demands);
      }
      throw new Error(error instanceof Error ? `The debugger subscription setup failed: ${error.message}` : 'The debugger subscription setup failed.');
    }
  }

  async function renewAuthority(): Promise<PublishedTarget> {
    if (publishedTarget === undefined || selectedTabId === undefined) {
      throw new Error('The requested target is not available.');
    }
    const priorTarget = publishedTarget;
    const renewedTarget: PublishedTarget = {
      ...priorTarget,
      generation: priorTarget.generation + 1,
    };
    childSessionRouter.revoke();
    activeRootSubscriptionDomains.clear();
    activeRootSubscriptionDemands.clear();
    activeChildSubscriptionDemands.clear();
    publishedTarget = renewedTarget;
    try {
      await options.revokeTarget(priorTarget, 'explicit');
      await options.publishTarget(renewedTarget);
    } catch (error) {
      publishedTarget = priorTarget;
      throw error;
    }
    options.registerTargetExecutor?.(renewedTarget, { execute: executeCommand, setSubscriptionDemand });
    return renewedTarget;
  }

  return {
    attachChildSession(chromeSessionId) {
      if (publishedTarget === undefined) throw new Error('The requested target is not available.');
      return childSessionRouter.attach(chromeSessionId);
    },
    debuggerEvent(source, method, parameters) {
      if (source.tabId !== undefined && source.tabId !== selectedTabId) return;
      if (method === 'Target.attachedToTarget') {
        const childSession = handleAttachedChild(parameters);
        if (childSession !== undefined && isEligibleChildAttachment(parameters)) {
          publishEvent('Bridge.childSessionAttached', { type: parameters.targetInfo.type }, childSession.id);
        }
        return;
      }
      if (method === 'Target.detachedFromTarget') {
        handleDetachedChild(parameters);
        return;
      }
      if (source.sessionId === undefined && method === 'Page.frameNavigated') {
        invalidateChildrenOnRootNavigation(method, parameters);
        return;
      }
      const publicSession = source.sessionId === undefined ? undefined : childSessionRouter.resolve(source.sessionId);
      if (source.sessionId !== undefined && publicSession === undefined) return;
      if (isEventDemanded(method, publicSession)) publishEvent(method, parameters, publicSession);
    },
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
      if (!isPublishable(tab)) {
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
        generation: options.targetIdentity?.generation ?? 1,
        id: options.targetIdentity?.id ?? globalThis.crypto.randomUUID(),
        scopeId: options.scopeId,
        type: 'page',
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        ...(metadata.url === undefined ? {} : { url: metadata.url }),
      };

      selectedTabId = tab.tabId;
      publishedTarget = target;
      try {
        await configureFlatSessions();
        await options.publishTarget(target);
      } catch (error) {
        childSessionRouter.revoke();
        publishedTarget = undefined;
        selectedTabId = undefined;
        await options.chromeDebugger.detach({ tabId: tab.tabId });
        throw error;
      }
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
    detachChildSession(chromeSessionId) {
      return childSessionRouter.detach(chromeSessionId);
    },
    publishEvent,
    revoke,
    renewAuthority,
    setSubscriptionDemand,
  };
}
