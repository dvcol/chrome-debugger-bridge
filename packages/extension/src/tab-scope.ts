import type { SelectedTab } from './selected-tab-publisher.js';

/** Extension-local tab selection rules. They are deliberately never part of the broker protocol. */
export type TabScopeSelector = { readonly kind: 'active-tab' } | { readonly kind: 'explicit-tabs'; readonly tabIds: readonly number[] } | { readonly kind: 'group'; readonly groupId: number } | { readonly kind: 'url-pattern'; readonly pattern: string } | { readonly kind: 'window'; readonly windowId: number };

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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
