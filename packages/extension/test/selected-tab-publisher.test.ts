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
      async sendCommand() {
        return {};
      },
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

it('validates the opaque target grant before forwarding a debugger command', async () => {
  expect.assertions(3);
  const sendCommand = vi.fn(async () => ({ result: 'safe' }));
  const publisher = createSelectedTabPublisher({
    capabilities: { methods: ['Runtime.evaluate'] },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });

  await expect(publisher.executeCommand({
    leaseId: '20000000-0000-4000-8000-000000000001',
    method: 'Page.navigate',
    operationId: '30000000-0000-4000-8000-000000000001',
    targetGeneration: target.generation,
    targetId: target.id,
  }, new AbortController().signal)).rejects.toThrow('not permitted');
  expect(sendCommand).not.toHaveBeenCalled();
  expect(JSON.stringify(sendCommand.mock.calls)).not.toContain('42');
});

it('denies incognito and unsupported pages before attaching', async () => {
  expect.assertions(4);
  const attach = vi.fn();
  const publisher = createSelectedTabPublisher({
    capabilities: { methods: [] },
    chromeDebugger: {
      attach,
      detach() {},
      async sendCommand() {
        return {};
      },
    },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
  });

  await expect(publisher.publish({ incognito: true, tabId: 42, url: 'https://example.com/' })).rejects.toThrow('Incognito');
  await expect(publisher.publish({ incognito: false, tabId: 42, url: 'chrome://settings/' })).rejects.toThrow('not supported');

  expect(attach).not.toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();
});
