import type { SelectedTab } from './selected-tab-publisher.js';

/** Extension-local tab selection rules. They are deliberately never part of the broker protocol. */
export type TabScopeSelector = { readonly kind: 'active-tab' } | { readonly kind: 'explicit-tabs'; readonly tabIds: readonly number[] } | { readonly kind: 'group'; readonly groupId: number } | { readonly kind: 'url-pattern'; readonly pattern: string } | { readonly kind: 'window'; readonly windowId: number };

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Copies a validated provider-local selector received from a host UI. */
export function parseTabScopeSelector(value: unknown): TabScopeSelector | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const selector = value as Record<string, unknown>;
  const keys = Object.keys(selector);
  const only = (...allowed: string[]): boolean => keys.every(key => allowed.includes(key));
  if (selector.kind === 'active-tab' && only('kind')) return { kind: 'active-tab' };
  if (selector.kind === 'explicit-tabs' && only('kind', 'tabIds') && Array.isArray(selector.tabIds)
    && selector.tabIds.length > 0 && selector.tabIds.every(tabId => typeof tabId === 'number' && isNonNegativeInteger(tabId))) {
    return { kind: 'explicit-tabs', tabIds: [...new Set(selector.tabIds as number[])] };
  }
  if (selector.kind === 'group' && only('kind', 'groupId') && typeof selector.groupId === 'number' && isNonNegativeInteger(selector.groupId))
    return { groupId: selector.groupId, kind: 'group' };
  if (selector.kind === 'window' && only('kind', 'windowId') && typeof selector.windowId === 'number' && isNonNegativeInteger(selector.windowId))
    return { kind: 'window', windowId: selector.windowId };
  if (selector.kind === 'url-pattern' && only('kind', 'pattern') && typeof selector.pattern === 'string') {
    try {
      void new URLPattern(selector.pattern);
      return { kind: 'url-pattern', pattern: selector.pattern };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Tests whether a Chrome tab belongs to an extension-owned selector scope. */
export function matchesTabScope(selector: TabScopeSelector, tab: SelectedTab): boolean {
  switch (selector.kind) {
    case 'active-tab':
      return tab.active === true;
    case 'explicit-tabs':
      return selector.tabIds.every(isNonNegativeInteger) && selector.tabIds.includes(tab.tabId);
    case 'group':
      return isNonNegativeInteger(selector.groupId) && tab.groupId === selector.groupId;
    case 'url-pattern':
      try {
        return new URLPattern(selector.pattern).test(tab.url);
      } catch {
        return false;
      }
    case 'window':
      return isNonNegativeInteger(selector.windowId) && tab.windowId === selector.windowId;
  }
}
