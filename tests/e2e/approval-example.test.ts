import type { BrowserContext } from 'playwright';

import type { CdbToolSession } from '../../packages/mcp/src/index.js';
import type { NodeChromeDebuggerBridgeClient } from '../../packages/websocket/src/node.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { buildApprovalExtension } from '../../examples/extension/build.ts';
import { startGrantFlowHost } from '../../examples/standalone-host/grant-flow.ts';
import { createCdbToolSession } from '../../packages/mcp/src/index.js';
import { createNodeChromeDebuggerBridgeClient } from '../../packages/websocket/src/node.js';
import { attachExtensionPopup } from './fixtures/extension-popup.js';

interface ExtensionGlobal {
  readonly chrome: {
    readonly action: { openPopup: () => Promise<void> };
    readonly tabs: {
      group: (options: { readonly groupId?: number; readonly tabIds: readonly number[] }) => Promise<number>;
      query: (options: Record<string, unknown>) => Promise<readonly { readonly id: number; readonly url: string }[]>;
      ungroup: (tabIds: readonly number[]) => Promise<void>;
      update: (tabId: number, properties: { readonly active: boolean }) => Promise<unknown>;
    };
  };
}

async function withExampleTimeout<Result>(operation: Promise<Result>, description: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`The approval example timed out while ${description}.`)), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

it('rejects page approval and grants only the tab approved in the real extension popup', async () => {
  expect.assertions(11);
  const host = await startGrantFlowHost();
  const extensionDirectory = await mkdtemp(join(tmpdir(), 'cdb-approval-extension-'));
  const profileDirectory = await mkdtemp(join(tmpdir(), 'cdb-approval-profile-'));
  let context: BrowserContext | undefined;
  let client: NodeChromeDebuggerBridgeClient | undefined;
  try {
    await buildApprovalExtension({ configuration: host.configuration, outDir: extensionDirectory });
    context = await chromium.launchPersistentContext(profileDirectory, {
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`],
      channel: 'chromium',
      headless: true,
    });
    const unrelatedPage = await context.newPage();
    await unrelatedPage.goto(`${host.endpoint}/#unrelated`);
    const page = await context.newPage();
    await page.goto(host.endpoint);
    await page.bringToFront();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    client = await withExampleTimeout(createNodeChromeDebuggerBridgeClient({ artifactEndpoint: host.artifactEndpoint, authorization: host.clientAuthorization, endpoint: host.clientEndpoint }), 'connecting the approved example client');
    const activeClient = client;
    let requestId: string | undefined;
    await expect.poll(async () => {
      const response = await fetch(new URL('state', host.configuration.controlEndpoint), { headers: { authorization: host.configuration.controlAuthorization } });
      if (!response.ok) return false;
      const state = await response.json() as { readonly requests: readonly { readonly id: string }[] };
      requestId = state.requests[0]?.id;
      return requestId !== undefined;
    }).toBe(true);
    if (requestId === undefined) throw new Error('The public example did not create a pending request.');
    await withExampleTimeout(worker.evaluate(async () => (globalThis as unknown as ExtensionGlobal).chrome.action.openPopup()), 'opening the Chrome popup');
    const popup = await attachExtensionPopup(context);
    await expect.poll(async () => popup.text(), { timeout: 10_000 }).toContain('Allow INTERACT');
    const forgedApproval = await page.evaluate(async pendingRequestId => new Promise<unknown>((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error('The content script did not answer a page-origin approval message.')), 10_000);
      const listener = (event: MessageEvent<{ readonly kind?: string; readonly requestId?: string; readonly result?: unknown }>): void => {
        if (event.data?.kind !== 'example.approval.result' || event.data.requestId !== pendingRequestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', listener);
        resolveResult(event.data.result);
      };
      window.addEventListener('message', listener);
      window.postMessage({ kind: 'cdb.approval.approve', requestId: pendingRequestId, selector: { kind: 'explicit-tabs', tabIds: [1] } }, location.origin);
    }), requestId);
    expect(forgedApproval).toMatchObject({ code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false });
    expect(await activeClient.listTargets()).toEqual([]);
    await popup.click('Allow INTERACT');
    await expect.poll(async () => (await activeClient.listTargets()).map(target => target.url)).toEqual([`${host.endpoint}/`]);
    expect(await unrelatedPage.locator('output').textContent()).toBe('');
    const toolSession = createCdbToolSession({ client: activeClient });
    try {
      const target = (await activeClient.listTargets())[0];
      const targetRef = target === undefined ? undefined : toolSession.projectTarget(target)?.targetRef;
      const snapshot = toolSession.definitions.find(definition => definition.name === 'browser.snapshot');
      if (targetRef === undefined || snapshot === undefined) throw new Error('The approved example target has no snapshot tool.');
      const result = await snapshot.invoke({ targetRef });
      const text = result.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n');
      expect(result.isError, text).toBeUndefined();
      expect(text).toContain('Name');
      expect(text).toContain('Save');
      const screenshot = toolSession.definitions.find(definition => definition.name === 'browser.screenshot');
      if (screenshot === undefined) throw new Error('The default screenshot tool is unavailable.');
      const image = await screenshot.invoke({ targetRef });
      expect(image.content.some(content => content.type === 'image')).toBe(true);
    } finally {
      toolSession.dispose();
    }

    await popup.click('Revoke');
    await expect.poll(async () => activeClient.listTargets()).toEqual([]);
  } finally {
    client?.dispose();
    await client?.closed;
    if (context !== undefined) await withExampleTimeout(context.close(), 'closing the browser fixture');
    await withExampleTimeout(host.close(), 'closing the example host');
    await rm(extensionDirectory, { force: true, recursive: true });
    await rm(profileDirectory, { force: true, recursive: true });
  }
}, 90_000);

it('updates live group authority while preserving an overlapping independent tab grant', async () => {
  expect.assertions(12);
  const host = await startGrantFlowHost();
  const extensionDirectory = await mkdtemp(join(tmpdir(), 'cdb-group-extension-'));
  const profileDirectory = await mkdtemp(join(tmpdir(), 'cdb-group-profile-'));
  let context: BrowserContext | undefined;
  const clients: NodeChromeDebuggerBridgeClient[] = [];
  const toolSessions: CdbToolSession[] = [];
  try {
    await buildApprovalExtension({ configuration: host.configuration, outDir: extensionDirectory });
    context = await chromium.launchPersistentContext(profileDirectory, {
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`],
      channel: 'chromium',
      headless: true,
    });
    const initialPage = await context.newPage();
    const initialUrl = `${host.endpoint}/#initial-member`;
    const joiningUrl = `${host.endpoint}/#joining-member`;
    await initialPage.goto(initialUrl);
    const joiningPage = await context.newPage();
    await joiningPage.goto(joiningUrl);
    await initialPage.bringToFront();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const membership = await worker.evaluate(async ({ initialUrl, joiningUrl }) => {
      const { tabs } = (globalThis as unknown as ExtensionGlobal).chrome;
      const allTabs = await tabs.query({});
      const initialTabId = allTabs.find(tab => tab.url === initialUrl)?.id;
      const joiningTabId = allTabs.find(tab => tab.url === joiningUrl)?.id;
      if (initialTabId === undefined || joiningTabId === undefined) throw new Error('The public group fixture tabs are unavailable.');
      const groupId = await tabs.group({ tabIds: [initialTabId] });
      return { groupId, initialTabId, joiningTabId };
    }, { initialUrl, joiningUrl });
    const connectClient = async (): Promise<CdbToolSession> => {
      const client = await withExampleTimeout(createNodeChromeDebuggerBridgeClient({ artifactEndpoint: host.artifactEndpoint, authorization: host.clientAuthorization, endpoint: host.clientEndpoint }), 'connecting the approved example client');
      clients.push(client);
      const session = createCdbToolSession({ client });
      toolSessions.push(session);
      return session;
    };
    const visibleTargets = async (session: CdbToolSession): Promise<readonly { readonly targetRef: string; readonly url: string }[]> => {
      const list = session.definitions.find(definition => definition.name === 'browser.list_targets');
      if (list === undefined) throw new Error('The public target discovery tool is unavailable.');
      const result = await list.invoke({});
      const text = result.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n');
      if (result.isError) throw new Error(text);
      return JSON.parse(text) as readonly { readonly targetRef: string; readonly url: string }[];
    };
    const visibleUrls = async (session: CdbToolSession): Promise<readonly string[]> => (await visibleTargets(session)).map(target => target.url).sort();
    const groupSession = await connectClient();
    await withExampleTimeout(worker.evaluate(async () => (globalThis as unknown as ExtensionGlobal).chrome.action.openPopup()), 'opening the Chrome popup');
    const groupPopup = await attachExtensionPopup(context);
    await expect.poll(async () => groupPopup.text(), { timeout: 10_000 }).toContain('Allow INTERACT');
    await groupPopup.selectScope('group');
    await groupPopup.click('Allow INTERACT');
    await expect.poll(async () => visibleUrls(groupSession)).toEqual([initialUrl]);

    await withExampleTimeout(groupPopup.close(), 'closing the group approval popup');

    await withExampleTimeout(worker.evaluate(async membership => (globalThis as unknown as ExtensionGlobal).chrome.tabs.group({ groupId: membership.groupId, tabIds: [membership.joiningTabId] }), membership), 'changing Chrome tab membership');
    await expect.poll(async () => visibleUrls(groupSession)).toEqual([initialUrl, joiningUrl].sort());

    await withExampleTimeout(worker.evaluate(async tabId => (globalThis as unknown as ExtensionGlobal).chrome.tabs.update(tabId, { active: true }), membership.joiningTabId), 'activating the approved Chrome tab');
    const tabSession = await connectClient();
    await withExampleTimeout(worker.evaluate(async () => (globalThis as unknown as ExtensionGlobal).chrome.action.openPopup()), 'opening the Chrome popup');
    const tabPopup = await attachExtensionPopup(context);
    await expect.poll(async () => tabPopup.text(), { timeout: 10_000 }).toContain('Allow INTERACT');
    await tabPopup.selectScope('tab');
    await tabPopup.click('Allow INTERACT');
    await expect.poll(async () => visibleUrls(tabSession)).toEqual([joiningUrl]);

    await withExampleTimeout(tabPopup.close(), 'closing the tab approval popup');

    await withExampleTimeout(worker.evaluate(async tabId => (globalThis as unknown as ExtensionGlobal).chrome.tabs.ungroup([tabId]), membership.joiningTabId), 'changing Chrome tab membership');
    await expect.poll(async () => visibleUrls(groupSession)).toEqual([initialUrl]);
    await expect.poll(async () => visibleUrls(tabSession)).toEqual([joiningUrl]);
    const preservedTarget = (await visibleTargets(tabSession))[0];
    const snapshot = tabSession.definitions.find(definition => definition.name === 'browser.snapshot');
    if (preservedTarget === undefined || snapshot === undefined) throw new Error('The independent tab grant lost its snapshot tool.');
    const observation = await snapshot.invoke({ targetRef: preservedTarget.targetRef });
    const text = observation.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n');
    expect(observation.isError, text).toBeUndefined();
    expect(text).toContain('Name');
    expect(text).toContain('Save');

    await withExampleTimeout(worker.evaluate(async tabId => (globalThis as unknown as ExtensionGlobal).chrome.tabs.ungroup([tabId]), membership.initialTabId), 'changing Chrome tab membership');
    await expect.poll(async () => visibleUrls(groupSession)).toEqual([]);
    await expect.poll(async () => visibleUrls(tabSession)).toEqual([joiningUrl]);
  } finally {
    for (const session of toolSessions) session.dispose();
    for (const client of clients) client.dispose();
    await withExampleTimeout(Promise.all(clients.map(async client => client.closed)), 'closing the example clients');
    if (context !== undefined) await withExampleTimeout(context.close(), 'closing the browser fixture');
    await withExampleTimeout(host.close(), 'closing the example host');
    await rm(extensionDirectory, { force: true, recursive: true });
    await rm(profileDirectory, { force: true, recursive: true });
  }
}, 90_000);
