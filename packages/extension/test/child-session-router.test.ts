import { expect, it } from 'vitest';

import { createChildSessionRouter } from '../src/child-session-router.js';

it('maps private Chrome sessions to opaque lifecycle-bound public identities', () => {
  expect.assertions(6);
  const router = createChildSessionRouter();
  const first = router.attach('chrome-session-a');
  const second = router.attach('chrome-session-b');

  expect(first.id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(first.generation).toBe(1);
  expect(router.attach('chrome-session-a')).toEqual(first);
  expect(router.resolve(first.id)).toBe('chrome-session-a');
  expect(router.detach('chrome-session-a')).toEqual(first);
  expect(router.revoke()).toEqual([second]);
});
