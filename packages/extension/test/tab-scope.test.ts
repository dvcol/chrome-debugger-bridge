import { expect, it } from 'vitest';

import { matchesTabScope } from '../src/tab-scope.js';

const tab = { active: true, groupId: 8, incognito: false, tabId: 42, url: 'https://example.com/private', windowId: 3 };

it('matches extension-only explicit, group, window, active, and URL selector scopes', () => {
  expect.assertions(5);
  expect(matchesTabScope({ kind: 'explicit-tabs', tabIds: [1, 42] }, tab)).toBe(true);
  expect(matchesTabScope({ groupId: 8, kind: 'group' }, tab)).toBe(true);
  expect(matchesTabScope({ kind: 'window', windowId: 3 }, tab)).toBe(true);
  expect(matchesTabScope({ kind: 'active-tab' }, tab)).toBe(true);
  expect(matchesTabScope({ kind: 'url-pattern', pattern: 'https://example.com/*' }, tab)).toBe(true);
});

it('fails closed for invalid selectors and missing selector metadata', () => {
  expect.assertions(3);
  expect(matchesTabScope({ kind: 'explicit-tabs', tabIds: [-1] }, tab)).toBe(false);
  expect(matchesTabScope({ kind: 'url-pattern', pattern: '[' }, tab)).toBe(false);
  expect(matchesTabScope({ kind: 'window', windowId: 3 }, { incognito: false, tabId: 42, url: 'https://example.com/' })).toBe(false);
});
