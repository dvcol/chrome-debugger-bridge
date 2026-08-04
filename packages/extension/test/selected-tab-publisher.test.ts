import { expect, it, vi } from 'vitest';

import { createSelectedTabPublisher } from '../src/selected-tab-publisher.js';

const scopeId = '40000000-0000-4000-8000-000000000001';

it('attaches one selected tab and publishes a redacted opaque target', async () => {
  expect.assertions(7);
  const attachedTabs: number[] = [];
  const publishedTargets: unknown[] = [];
  const publisher = createSelectedTabPublisher({
    capabilities: { methods: ['Runtime.evaluate'] },
    chromeDebugger: {
      attach(target) {
        attachedTabs.push(target.tabId);
      },
      detach() {},
    },
    metadataPolicy: () => ({ title: 'Safe title' }),
    publishTarget(target) {
      publishedTargets.push(target);
    },
    revokeTarget() {},
    scopeId,
  });

  const target = await publisher.publish({
    incognito: false,
    tabId: 42,
    title: 'Sensitive title',
    url: 'https://example.com/private',
  });

  expect(attachedTabs).toEqual([42]);
  expect(target.id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(target.generation).toBe(1);
  expect(target.title).toBe('Safe title');
  expect(target.url).toBeUndefined();
  expect(JSON.stringify(publishedTargets)).not.toContain('42');
  expect(Object.keys(target)).not.toContain('tabId');
});

it('denies incognito and unsupported pages before attaching', async () => {
  expect.assertions(4);
  const attach = vi.fn();
  const publisher = createSelectedTabPublisher({
    capabilities: { methods: [] },
    chromeDebugger: { attach, detach() {} },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
  });

  await expect(publisher.publish({ incognito: true, tabId: 42, url: 'https://example.com/' })).rejects.toThrow('Incognito');
  await expect(publisher.publish({ incognito: false, tabId: 42, url: 'chrome://settings/' })).rejects.toThrow('not supported');

  expect(attach).not.toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();
});
