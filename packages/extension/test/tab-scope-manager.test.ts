import type { PublishedTarget } from '@dvcol/cdb/protocol';

import type { SelectedTab } from '../src/selected-tab-publisher.js';

import { expect, it } from 'vitest';

import { createSelectedTabPublisher } from '../src/selected-tab-publisher.js';
import { createTabScopeManager } from '../src/tab-scope-manager.js';

function createEvent<Listener extends (...parameters: never[]) => void>() {
  const listeners = new Set<Listener>();
  return {
    addListener(listener: Listener) {
      listeners.add(listener);
    },
    emit(...parameters: Parameters<Listener>) {
      for (const listener of listeners) listener(...parameters);
    },
    removeListener(listener: Listener) {
      listeners.delete(listener);
    },
    size: () => listeners.size,
  };
}

function createFixture(initialTabs: SelectedTab[], attachBoundary: () => Promise<void> = async () => {}, queryBoundary: () => Promise<void> = async () => {}, membershipBoundary: (scopeId: string, targets: readonly PublishedTarget[]) => Promise<void> = async () => {}) {
  const tabs = new Map(initialTabs.map(tab => [tab.tabId, tab]));
  const attachedTabs = new Set<number>();
  const publications = new Map<string, PublishedTarget>();
  const revocationReasons: string[] = [];
  const onCreated = createEvent<(tab: SelectedTab) => void>();
  const onUpdated = createEvent<(tabId: number, changeInfo: unknown, tab: SelectedTab) => void>();
  const onRemoved = createEvent<(tabId: number) => void>();
  const onGroupRemoved = createEvent<(group: { readonly id: number }) => void>();
  const onGroupUpdated = createEvent<(group: { readonly id: number }) => void>();
  const onWindowRemoved = createEvent<(windowId: number) => void>();
  const memberships = new Map<string, readonly PublishedTarget[]>();
  const errors: unknown[] = [];
  const manager = createTabScopeManager({
    chrome: {
      tabGroups: { onRemoved: onGroupRemoved, onUpdated: onGroupUpdated },
      tabs: { onCreated, onRemoved, onUpdated, async query() {
        const result = [...tabs.values()];
        await queryBoundary();
        return result;
      } },
      windows: { onRemoved: onWindowRemoved },
    },
    createPublisher(tab) {
      return createSelectedTabPublisher({
        capabilities: { level: 'interact' },
        chromeDebugger: {
          async attach({ tabId }) {
            await attachBoundary();
            if (attachedTabs.has(tabId)) throw new Error('The debugger is already attached.');
            attachedTabs.add(tabId);
          },
          detach({ tabId }) {
            attachedTabs.delete(tabId);
          },
          async sendCommand() {
            return {};
          },
        },
        publishTarget(target) {
          publications.set(target.id, target);
        },
        revokeTarget(target, reason) {
          revocationReasons.push(reason);
          publications.delete(target.id);
          manager.updateTarget(tab.tabId, undefined);
        },
        scopeId: '40000000-0000-4000-8000-000000000001',
        updateTarget(target) {
          publications.set(target.id, target);
          manager.updateTarget(tab.tabId, target);
        },
      });
    },
    onError(error) {
      errors.push(error);
    },
    async onTargetsChanged(scopeId, targets) {
      await membershipBoundary(scopeId, targets);
      memberships.set(scopeId, targets);
    },
  });
  return { attachedTabs, errors, manager, memberships, onCreated, onGroupRemoved, onGroupUpdated, onRemoved, onUpdated, onWindowRemoved, publications, revocationReasons, tabs };
}

it('keeps one publication while an independently approved overlapping scope survives', async () => {
  expect.assertions(8);
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }]);
  const firstTargets = await fixture.manager.addScope('group-grant', { groupId: 3, kind: 'group' });
  const secondTargets = await fixture.manager.addScope('tab-grant', { kind: 'explicit-tabs', tabIds: [1] });
  expect(firstTargets).toHaveLength(1);
  expect(secondTargets[0]?.id).toBe(firstTargets[0]?.id);
  expect(fixture.attachedTabs).toEqual(new Set([1]));

  await fixture.manager.removeScope('group-grant');
  expect(fixture.manager.getTargets('tab-grant')).toEqual(secondTargets);
  expect(fixture.memberships.get('group-grant')).toEqual([]);
  expect(fixture.publications.size).toBe(1);

  await fixture.manager.dispose();
  expect(fixture.attachedTabs.size).toBe(0);
  expect(fixture.revocationReasons).toEqual(['explicit']);
});

it('does not restore a removed tab from an earlier tab query', async () => {
  expect.assertions(3);
  const queryStarted = Promise.withResolvers<void>();
  const queryFinished = Promise.withResolvers<void>();
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }], undefined, async () => {
    queryStarted.resolve();
    await queryFinished.promise;
  });
  const adding = fixture.manager.addScope('group-grant', { groupId: 3, kind: 'group' });
  await queryStarted.promise;
  fixture.onRemoved.emit(1);
  queryFinished.resolve();
  expect(await adding).toEqual([]);
  expect(fixture.attachedTabs.size).toBe(0);
  await fixture.manager.dispose();
  expect(fixture.publications.size).toBe(0);
});

it('cleans up a tab removed while debugger attachment is still pending', async () => {
  expect.assertions(4);
  const enteredAttachment = Promise.withResolvers<void>();
  const finishAttachment = Promise.withResolvers<void>();
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }], async () => {
    enteredAttachment.resolve();
    await finishAttachment.promise;
  });
  const adding = fixture.manager.addScope('group-grant', { groupId: 3, kind: 'group' });
  await enteredAttachment.promise;
  fixture.onRemoved.emit(1);
  finishAttachment.resolve();
  expect(await adding).toEqual([]);
  expect(fixture.attachedTabs.size).toBe(0);
  expect(fixture.publications.size).toBe(0);
  await fixture.manager.dispose();
  expect(fixture.onRemoved.size()).toBe(0);
});

it('ends a removed group scope without revoking its independently approved tab', async () => {
  expect.assertions(6);
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }]);
  await fixture.manager.addScope('group-grant', { groupId: 3, kind: 'group' });
  const tabTargets = await fixture.manager.addScope('tab-grant', { kind: 'explicit-tabs', tabIds: [1] });
  fixture.onGroupRemoved.emit({ id: 3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.manager.getTargets('group-grant')).toEqual([]);
  expect(fixture.manager.getTargets('tab-grant')).toEqual(tabTargets);
  expect(fixture.attachedTabs).toEqual(new Set([1]));

  fixture.onCreated.emit({ groupId: 3, incognito: false, tabId: 2, url: 'https://example.com/new' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.attachedTabs).toEqual(new Set([1]));
  await fixture.manager.dispose();
  expect(fixture.onGroupRemoved.size()).toBe(0);
  expect(fixture.onCreated.size()).toBe(0);
});

it('reconciles group changes and future members while preserving explicit tab membership', async () => {
  expect.assertions(5);
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }]);
  await fixture.manager.addScope('group-grant', { groupId: 3, kind: 'group' });
  await fixture.manager.addScope('tab-grant', { kind: 'explicit-tabs', tabIds: [1] });
  fixture.tabs.set(1, { groupId: 4, incognito: false, tabId: 1, url: 'https://example.com/' });
  fixture.onGroupUpdated.emit({ id: 3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.manager.getTargets('group-grant')).toEqual([]);
  expect(fixture.manager.getTargets('tab-grant')).toHaveLength(1);

  fixture.onCreated.emit({ groupId: 3, incognito: false, tabId: 2, url: 'https://example.com/new' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.manager.getTargets('group-grant')).toHaveLength(1);
  expect(fixture.attachedTabs).toEqual(new Set([1, 2]));
  await fixture.manager.dispose();
  expect(fixture.onGroupUpdated.size()).toBe(0);
});

it('fences a closed tab identity before a newly created group member reuses its tab ID', async () => {
  expect.assertions(4);
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }]);
  const original = await fixture.manager.addScope('group-grant', { groupId: 3, kind: 'group' });
  await fixture.manager.addScope('tab-grant', { kind: 'explicit-tabs', tabIds: [1] });
  fixture.onRemoved.emit(1);
  fixture.onCreated.emit({ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/replacement' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.manager.getTargets('group-grant')[0]?.id).not.toBe(original[0]?.id);
  expect(fixture.manager.getTargets('tab-grant')).toEqual([]);
  expect(fixture.publications.size).toBe(1);
  await fixture.manager.dispose();
  expect(fixture.attachedTabs.size).toBe(0);
});

it('removes all closed-window targets and does not renew the removed window scope', async () => {
  expect.assertions(4);
  const fixture = createFixture([{ incognito: false, tabId: 1, url: 'https://example.com/', windowId: 7 }]);
  await fixture.manager.addScope('window-grant', { kind: 'window', windowId: 7 });
  await fixture.manager.addScope('tab-grant', { kind: 'explicit-tabs', tabIds: [1] });
  fixture.onWindowRemoved.emit(7);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.manager.getTargets('window-grant')).toEqual([]);
  expect(fixture.manager.getTargets('tab-grant')).toEqual([]);
  fixture.onCreated.emit({ incognito: false, tabId: 2, url: 'https://example.com/new', windowId: 7 });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.attachedTabs.size).toBe(0);
  await fixture.manager.dispose();
  expect(fixture.onWindowRemoved.size()).toBe(0);
});

it('removes authority projections when the publisher revokes an unsupported navigation', async () => {
  expect.assertions(3);
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }]);
  await fixture.manager.addScope('group-grant', { groupId: 3, kind: 'group' });
  fixture.onUpdated.emit(1, { url: 'chrome://settings' }, { groupId: 3, incognito: false, tabId: 1, url: 'chrome://settings' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.manager.getTargets('group-grant')).toEqual([]);
  expect(fixture.attachedTabs.size).toBe(0);
  await fixture.manager.dispose();
  expect(fixture.publications.size).toBe(0);
});

it('does not deliver a removed scope after another scope callback completes', async () => {
  expect.assertions(3);
  const callbackStarted = Promise.withResolvers<void>();
  const callbackFinished = Promise.withResolvers<void>();
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }], undefined, undefined, async (scopeId, targets) => {
    if (scopeId === 'first' && targets.length > 0) {
      callbackStarted.resolve();
      await callbackFinished.promise;
    }
  });
  const firstScope = fixture.manager.addScope('first', { groupId: 3, kind: 'group' });
  const secondScope = fixture.manager.addScope('second', { groupId: 3, kind: 'group' });
  await callbackStarted.promise;
  const removing = fixture.manager.removeScope('second');
  callbackFinished.resolve();
  await Promise.all([firstScope, secondScope, removing]);
  expect(fixture.memberships.get('second')).toEqual([]);
  expect(fixture.manager.getTargets('first')).toHaveLength(1);
  await fixture.manager.dispose();
  expect(fixture.attachedTabs.size).toBe(0);
});

it('detaches a closed tab and removes every scope even if one authority callback fails', async () => {
  expect.assertions(4);
  let rejectRemoval = false;
  const fixture = createFixture([{ groupId: 3, incognito: false, tabId: 1, url: 'https://example.com/' }], undefined, undefined, async (scopeId, targets) => {
    if (rejectRemoval && scopeId === 'first' && targets.length === 0) throw new Error('Authority store unavailable.');
  });
  await fixture.manager.addScope('first', { groupId: 3, kind: 'group' });
  await fixture.manager.addScope('second', { kind: 'explicit-tabs', tabIds: [1] });
  rejectRemoval = true;
  fixture.onRemoved.emit(1);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.attachedTabs.size).toBe(0);
  expect(fixture.manager.getTargets('first')).toEqual([]);
  expect(fixture.manager.getTargets('second')).toEqual([]);
  expect(fixture.errors).toHaveLength(1);
  rejectRemoval = false;
  await fixture.manager.dispose();
});
