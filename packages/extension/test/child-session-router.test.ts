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

it('fences references across renewal without forgetting frames already attached by Chrome', () => {
  expect.assertions(6);
  const router = createChildSessionRouter();
  const original = router.attach('chrome-child', { frameId: 'frame-child', type: 'iframe' });
  router.renew();
  const current = router.publicSessionForChromeId('chrome-child')!;
  expect(router.resolve(original.id)).toBeUndefined();
  expect(current.id).not.toBe(original.id);
  expect(current.generation).toBeGreaterThan(original.generation);
  expect(current.frameId).toBe('frame-child');
  expect(router.resolve(current.id)).toBe('chrome-child');
  router.detach('chrome-child');
  expect(router.list()).toEqual([]);
});

it('removes nested sessions when Chrome detaches their ancestor', () => {
  expect.assertions(4);
  const router = createChildSessionRouter();
  const parent = router.attach('parent', 'iframe');
  const child = router.attach('child', 'iframe', 'parent');
  const grandchild = router.attach('grandchild', 'iframe', 'child');
  const sibling = router.attach('sibling', 'iframe');
  expect(router.detach('parent')).toEqual(parent);
  expect(router.resolve(child.id)).toBeUndefined();
  expect(router.resolve(grandchild.id)).toBeUndefined();
  expect(router.list()).toEqual([sibling]);
});
