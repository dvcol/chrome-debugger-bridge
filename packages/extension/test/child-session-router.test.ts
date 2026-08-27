import { expect, it } from 'vitest';

import { createChildSessionRouter } from '../src/child-session-router.js';

it('maps private Chrome sessions to opaque lifecycle-bound public identities', () => {
  expect.assertions(10);
  const router = createChildSessionRouter();
  const first = router.attach('chrome-session-a', {
    frameId: 'frame-a',
    type: 'iframe',
    url: 'https://frame.example.test/',
  });
  const second = router.attach('chrome-session-b', 'worker');

  expect(first.id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(first.generation).toBe(1);
  expect(first).toMatchObject({ frameId: 'frame-a', url: 'https://frame.example.test/' });
  expect(router.attach('chrome-session-a')).toEqual(first);
  expect(router.resolve(first.id)).toBe('chrome-session-a');
  expect(router.publicSessionForChromeId('chrome-session-a')).toEqual(first);
  expect(router.list()).toEqual([first, second]);
  expect(router.detach('chrome-session-a')).toEqual(first);
  expect(router.revoke()).toEqual([second]);
  expect(router.list()).toEqual([]);
});
