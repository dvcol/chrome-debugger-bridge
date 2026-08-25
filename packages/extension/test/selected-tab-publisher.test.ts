import type { CdpCommand, JsonObject, Lease } from '@dvcol/cdb/protocol';

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
  sendCommand.mockClear();

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

it('keeps raw download behavior parameter-sensitive in the extension security kernel', async () => {
  expect.assertions(5);
  const sendCommand = vi.fn(async () => ({ result: 'safe' }));
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
    updateTarget() {},
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  sendCommand.mockClear();
  const lease = { expiresAt: '2030-01-01T00:00:00.000Z', id: '20000000-0000-4000-8000-000000000001', issuedAt: '2026-08-12T00:00:00.000Z', methods: ['Page.setDownloadBehavior'], mode: 'exclusive-control' as const, targetGeneration: target.generation, targetId: target.id };

  await expect(publisher.executeCommand({ leaseId: lease.id, method: 'Page.setDownloadBehavior', operationId: '30000000-0000-4000-8000-000000000001', parameters: { behavior: 'allow', downloadPath: '/private/downloads' }, targetGeneration: target.generation, targetId: target.id }, new AbortController().signal, lease)).rejects.toThrow('not permitted');
  expect(sendCommand).not.toHaveBeenCalled();
  await expect(publisher.executeCommand({ leaseId: lease.id, method: 'Page.setDownloadBehavior', operationId: '30000000-0000-4000-8000-000000000002', parameters: { behavior: 'deny' }, targetGeneration: target.generation, targetId: target.id }, new AbortController().signal, lease)).resolves.toEqual({ result: 'safe' });
  expect(sendCommand).toHaveBeenCalledOnce();
  expect(sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Page.setDownloadBehavior', { behavior: 'deny' });
});

it('denies profile-wide cookie commands even with unsafe authority', async () => {
  expect.assertions(2);
  const sendCommand = vi.fn(async () => ({ result: 'safe' }));
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
    updateTarget() {},
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  await expect(publisher.executeCommand({ leaseId: '20000000-0000-4000-8000-000000000001', method: 'Network.getAllCookies', operationId: '30000000-0000-4000-8000-000000000003', targetGeneration: target.generation, targetId: target.id }, new AbortController().signal, { expiresAt: '2030-01-01T00:00:00.000Z', id: '20000000-0000-4000-8000-000000000001', issuedAt: '2026-08-12T00:00:00.000Z', methods: ['Network.getAllCookies'], mode: 'exclusive-control', targetGeneration: target.generation, targetId: target.id })).rejects.toThrow('not permitted');
  expect(sendCommand).not.toHaveBeenCalledWith({ tabId: 42 }, 'Network.getAllCookies', undefined);
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

it('forwards debugger events only while an exact broker demand is active', async () => {
  expect.assertions(4);
  const events: unknown[] = [];
  const sendCommand = vi.fn(async () => ({}));
  let setSubscriptionDemand: ((methodPrefix: string, active: boolean, sessionId?: string) => Promise<void>) | undefined;
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    publishEvent(_target, method, parameters) {
      events.push({ method, parameters });
    },
    publishTarget() {},
    registerTargetExecutor(_target, executor) {
      setSubscriptionDemand = executor.setSubscriptionDemand;
    },
    revokeTarget() {},
    scopeId,
    updateTarget() {},
  });
  await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  sendCommand.mockClear();
  publisher.debuggerEvent({ tabId: 42 }, 'Debugger.scriptParsed', { scriptId: '1' });
  await setSubscriptionDemand?.('Debugger.paused', true);
  publisher.debuggerEvent({ tabId: 42 }, 'Debugger.scriptParsed', { scriptId: '2' });
  publisher.debuggerEvent({ tabId: 42 }, 'Debugger.paused', { reason: 'other' });
  await setSubscriptionDemand?.('Debugger.paused', false);

  expect(events).toEqual([{ method: 'Debugger.paused', parameters: { reason: 'other' } }]);
  expect(sendCommand).toHaveBeenNthCalledWith(1, { tabId: 42 }, 'Debugger.enable');
  expect(sendCommand).toHaveBeenNthCalledWith(2, { tabId: 42 }, 'Debugger.disable');
  expect(sendCommand).toHaveBeenCalledTimes(2);
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

it('reevaluates extension-owned selector scopes on every tab refresh', async () => {
  expect.assertions(2);
  const revokeTarget = vi.fn();
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, async sendCommand() {
      return {};
    } },
    publishTarget() {},
    revokeTarget,
    scopeId,
    tabScopeSelector: { kind: 'window', windowId: 3 },
    updateTarget() {},
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/', windowId: 3 });
  await publisher.refresh({ incognito: false, tabId: 42, url: 'https://example.com/', windowId: 4 });

  expect(revokeTarget).toHaveBeenCalledWith(target, 'policy-invalid');
  expect(revokeTarget).toHaveBeenCalledOnce();
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

it('invalidates child-session routing when the published root is revoked', async () => {
  expect.assertions(3);
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, async sendCommand() {
      return {};
    } },
    publishTarget() {},
    revokeTarget() {},
    scopeId,
    updateTarget() {},
  });
  await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  const child = publisher.attachChildSession('private-child-session');
  await publisher.revoke();

  expect(child.id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(publisher.detachChildSession('private-child-session')).toBeUndefined();
  expect(() => publisher.attachChildSession('private-child-session')).toThrow('not available');
});

it('renews a published target with stable logical identity, a higher generation, and no child sessions', async () => {
  expect.assertions(7);
  const publishedTargets: unknown[] = [];
  const revokedTargets: unknown[] = [];
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, async sendCommand() {
      return {};
    } },
    publishTarget(target) {
      publishedTargets.push(target);
    },
    revokeTarget(target, reason) {
      revokedTargets.push({ reason, target });
    },
    scopeId,
    updateTarget() {},
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  const child = publisher.attachChildSession('private-child-session');
  const renewedTarget = await publisher.renewAuthority();

  expect(renewedTarget.id).toBe(target.id);
  expect(renewedTarget.generation).toBe(2);
  expect(revokedTargets).toEqual([{ reason: 'explicit', target }]);
  expect(publishedTargets).toEqual([target, renewedTarget]);
  await expect(publisher.executeCommand({ leaseId: '20000000-0000-4000-8000-000000000001', method: 'Runtime.evaluate', operationId: '30000000-0000-4000-8000-000000000001', targetGeneration: target.generation, targetId: target.id }, new AbortController().signal)).rejects.toThrow('not permitted');
  expect(publisher.detachChildSession('private-child-session')).toBeUndefined();
  expect(child.id).toMatch(/^[0-9a-f-]{36}$/u);
});

it('configures recursive flat sessions and exposes only eligible child-session identities', async () => {
  expect.assertions(8);
  const sendCommand = vi.fn(async () => ({}));
  const events: unknown[] = [];
  let execute: ((command: CdpCommand, abortSignal: AbortSignal, lease: Lease) => Promise<JsonObject>) | undefined;
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    publishEvent(target, method, parameters, sessionId) {
      events.push({ method, parameters, sessionId, target });
    },
    publishTarget() {},
    registerTargetExecutor(_target, executor) {
      execute = executor.execute;
    },
    revokeTarget() {},
    scopeId,
    updateTarget() {},
  });
  const target = await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  sendCommand.mockClear();
  publisher.debuggerEvent({ tabId: 42 }, 'Target.attachedToTarget', { sessionId: 'private-frame-session', targetInfo: { type: 'iframe' } });
  publisher.debuggerEvent({ tabId: 42 }, 'Target.attachedToTarget', { sessionId: 'private-page-session', targetInfo: { type: 'page' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  const child = publisher.attachChildSession('private-frame-session');
  const lease = { expiresAt: '2026-08-05T00:00:00.000Z', id: '20000000-0000-4000-8000-000000000001', issuedAt: '2026-08-04T00:00:00.000Z', methods: ['Runtime.evaluate'], mode: 'exclusive-control' as const, targetGeneration: target.generation, targetId: target.id };
  const childCommand = {
    leaseId: '20000000-0000-4000-8000-000000000001',
    method: 'Runtime.evaluate',
    operationId: '30000000-0000-4000-8000-000000000001',
    sessionId: child.id,
    targetGeneration: target.generation,
    targetId: target.id,
  } satisfies CdpCommand;
  await execute?.(childCommand, new AbortController().signal, lease);
  publisher.debuggerEvent({ tabId: 42 }, 'Page.frameNavigated', { frame: { id: 'private-root-frame' } });

  expect(sendCommand).toHaveBeenNthCalledWith(1, { sessionId: 'private-frame-session', tabId: 42 }, 'Target.setAutoAttach', { autoAttach: true, filter: [{ exclude: false, type: 'iframe' }, { exclude: false, type: 'service_worker' }, { exclude: false, type: 'shared_worker' }, { exclude: false, type: 'worker' }], flatten: true, waitForDebuggerOnStart: true });
  expect(sendCommand).toHaveBeenNthCalledWith(3, { sessionId: 'private-frame-session', tabId: 42 }, 'Runtime.evaluate', undefined);
  await expect(execute?.(childCommand, new AbortController().signal, lease)).rejects.toThrow('not permitted');
  expect(publisher.attachChildSession('private-frame-session').id).not.toBe(child.id);
  expect(() => publisher.attachChildSession('private-page-session')).not.toThrow();
  expect(JSON.stringify(sendCommand.mock.calls)).not.toContain('private-page-session');
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).toMatch(/"method":"Bridge\.childSessionAttached".*"type":"iframe"/u);
});

it('replays active root domain demand for an eligible child session', async () => {
  expect.assertions(4);
  const sendCommand = vi.fn(async () => ({}));
  let setSubscriptionDemand: ((methodPrefix: string, active: boolean, sessionId?: string) => Promise<void>) | undefined;
  const publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    publishTarget() {},
    registerTargetExecutor(_target, executor) {
      setSubscriptionDemand = executor.setSubscriptionDemand;
    },
    revokeTarget() {},
    scopeId,
    updateTarget() {},
  });
  await publisher.publish({ incognito: false, tabId: 42, url: 'https://example.com/' });
  sendCommand.mockClear();
  await setSubscriptionDemand?.('Runtime.consoleAPICalled', true);
  publisher.debuggerEvent({ tabId: 42 }, 'Target.attachedToTarget', { sessionId: 'private-worker-session', targetInfo: { type: 'worker' } });
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(sendCommand).toHaveBeenNthCalledWith(1, { tabId: 42 }, 'Runtime.enable');
  expect(sendCommand).toHaveBeenNthCalledWith(2, { sessionId: 'private-worker-session', tabId: 42 }, 'Target.setAutoAttach', { autoAttach: true, filter: [{ exclude: false, type: 'iframe' }, { exclude: false, type: 'service_worker' }, { exclude: false, type: 'shared_worker' }, { exclude: false, type: 'worker' }], flatten: true, waitForDebuggerOnStart: true });
  expect(sendCommand).toHaveBeenNthCalledWith(3, { sessionId: 'private-worker-session', tabId: 42 }, 'Runtime.enable');
  expect(sendCommand).toHaveBeenNthCalledWith(4, { sessionId: 'private-worker-session', tabId: 42 }, 'Runtime.runIfWaitingForDebugger');
});
