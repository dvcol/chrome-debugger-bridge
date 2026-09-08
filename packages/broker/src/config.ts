import type { AuthorityStore, AutomationProvider } from '@dvcol/cdb';

import type { BrokerIdentityStore, BrokerTimingPolicy, NavigationPolicy } from './contract.js';

import { validateTimeoutMilliseconds } from '@dvcol/cdb';

export interface NavigationContext {
  readonly approvedOrigin: string;
  readonly navigation: NavigationPolicy;
  readonly principalId: string;
  readonly targetId: string;
  readonly url: string | undefined;
}

export interface BrokerDefinition {
  readonly identityStore?: BrokerIdentityStore;
  readonly authorityStore?: AuthorityStore;
  readonly navigation?: {
    readonly default?: NavigationPolicy;
    readonly allowed?: readonly NavigationPolicy[];
    /** Adds host restrictions without widening the approved preset. */
    readonly authorize?: (context: NavigationContext) => boolean;
  };
  /** Invoked only when a provider authenticates; the native implementation is otherwise used. */
  readonly automationProvider?: () => AutomationProvider | Promise<AutomationProvider>;
  readonly timing?: Partial<BrokerTimingPolicy>;
  readonly maximumProviderMessageBytes?: number;
}

export const defaultBrokerTimingPolicy: Readonly<BrokerTimingPolicy> = Object.freeze({
  accessRequestTimeoutMilliseconds: 60_000,
  clientResumeWindowMilliseconds: 15 * 60_000,
  pairingLifetimeMilliseconds: 5 * 60_000,
  providerRecoveryMilliseconds: 60_000,
  requestRateLimitMilliseconds: 2_000,
});

/** Validates configuration without creating authority, connections, timers, or processes. */
export function defineBroker<const Definition extends BrokerDefinition>(definition: Definition): Definition {
  const allowed = definition.navigation?.allowed ?? ['same-origin', 'follow-tab'];
  const defaultPolicy = definition.navigation?.default ?? 'same-origin';
  if (!allowed.includes(defaultPolicy) || allowed.some(policy => policy !== 'same-origin' && policy !== 'follow-tab'))
    throw new TypeError('The default navigation policy must be one of the permitted standard policies.');
  for (const [name, value] of Object.entries(definition.timing ?? {})) validateTimeoutMilliseconds(value, name);
  if (definition.maximumProviderMessageBytes !== undefined && (!Number.isSafeInteger(definition.maximumProviderMessageBytes) || definition.maximumProviderMessageBytes < 1))
    throw new TypeError('maximumProviderMessageBytes must be a positive safe integer.');
  return definition;
}

export function browserOrigin(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function allowsNavigation(definition: BrokerDefinition, context: NavigationContext): boolean {
  const origin = browserOrigin(context.url);
  if (origin === undefined || (context.navigation === 'same-origin' && origin !== context.approvedOrigin)) return false;
  try {
    return definition.navigation?.authorize?.(context) ?? true;
  } catch {
    return false;
  }
}
