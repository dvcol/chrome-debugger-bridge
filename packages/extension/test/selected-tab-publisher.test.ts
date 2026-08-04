import { expect, it, vi } from 'vitest';

import { createSelectedTabPublisher } from '../src/selected-tab-publisher.js';

const scopeId = '40000000-0000-4000-8000-000000000001';

it('attaches one selected tab and publishes a redacted opaque target', async () => {
  expect.assertions(7);
  const attachedTabs: number[] = [];
  const publishedTargets: unknown[] = [];
  const publisher = createSelectedTabPublisher({
    capabilities: { allow: ['Runtime.evaluate'] },
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
    updateTarget() {},
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
  expect(JSON.stringify(publishedTargets)).not.toContain('tabId');
  expect(Object.keys(target)).not.toContain('tabId');
});

it('validates the opaque target grant before forwarding a debugger command', async () => {
  expect.assertions(3);
  const sendCommand = vi.fn(async () => ({ result: 'safe' }));
  const publisher = createSelectedTabPublisher({
    capabilities: { allow: ['Runtime.evaluate'] },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
    updateTarget() {},
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

it('forwards only an opaque published target with a CDP event', async () => {
  expect.assertions(3);
  const events: unknown[] = [];
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, async sendCommand() {
      return {};
    } },
    publishEvent(target, method, parameters) {
      events.push({ method, parameters, target });
    },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
    updateTarget() {},
  });
  await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  publisher.publishEvent('Runtime.consoleAPICalled', { type: 'log' });

  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain('tabId');
  expect(events[0]).toMatchObject({ method: 'Runtime.consoleAPICalled', parameters: { type: 'log' } });
});

it('denies incognito and unsupported pages before attaching', async () => {
  expect.assertions(4);
  const attach = vi.fn();
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
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
    updateTarget() {},
  });

  await expect(publisher.publish({ incognito: true, tabId: 42, url: 'https://example.com/' })).rejects.toThrow('Incognito');
  await expect(publisher.publish({ incognito: false, tabId: 42, url: 'chrome://settings/' })).rejects.toThrow('not supported');

  expect(attach).not.toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();
});

it('publishes metadata changes and revokes the target when navigation invalidates policy', async () => {
  expect.assertions(5);
  const updateTarget = vi.fn();
  const revokeTarget = vi.fn();
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, async sendCommand() {
      return {};
    } },
    isExposureAllowed: tab => tab.url !== 'https://example.com/blocked',
    metadataPolicy: tab => ({ title: tab.title }),
    publishTarget() {},
    revokeTarget,
    scopeId,
    updateTarget,
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, title: 'Before', url: 'https://example.com/' });
  await publisher.refresh({ incognito: false, tabId: 42, title: 'After', url: 'https://example.com/' });
  await publisher.refresh({ incognito: false, tabId: 42, title: 'Blocked', url: 'https://example.com/blocked' });

  expect(updateTarget).toHaveBeenCalledWith({ ...target, title: 'After' });
  expect(revokeTarget).toHaveBeenCalledWith({ ...target, title: 'After' }, 'policy-invalid');
  expect(updateTarget).toHaveBeenCalledOnce();
  expect(revokeTarget).toHaveBeenCalledOnce();
  expect(target.generation).toBe(1);
});

it('revokes only the selected target on tab closure or debugger detachment', async () => {
  expect.assertions(4);
  const revokeTarget = vi.fn();
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, async sendCommand() {
      return {};
    } },
    publishTarget() {},
    revokeTarget,
    scopeId,
    updateTarget() {},
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  await publisher.tabClosed(7);
  await publisher.debuggerDetached(42);
  await publisher.tabClosed(42);

  expect(revokeTarget).toHaveBeenCalledWith(target, 'detached');
  expect(revokeTarget).toHaveBeenCalledOnce();
  expect(revokeTarget).not.toHaveBeenCalledWith(target, 'closed');
  expect(target.generation).toBe(1);
});

it('keeps revocation complete when Chrome detached the debugger first', async () => {
  expect.assertions(2);
  const revokeTarget = vi.fn();
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {
      throw new Error('Debugger is not attached.');
    }, async sendCommand() {
      return {};
    } },
    publishTarget() {},
    revokeTarget,
    scopeId,
    updateTarget() {},
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  await expect(publisher.debuggerDetached(42)).resolves.toBeUndefined();
  expect(revokeTarget).toHaveBeenCalledWith(target, 'detached');
});
