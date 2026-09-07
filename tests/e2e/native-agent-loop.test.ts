import type { NativeMcpHarness } from './fixtures/native-mcp-harness.js';

import { afterEach, expect, it } from 'vitest';

import { createNativeMcpHarness, toolText } from './fixtures/native-mcp-harness.js';

let harness: NativeMcpHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

it('clicks an ancestor control containing 200 DOM levels when its descendant receives the hit test', async () => {
  expect.assertions(2);
  harness = await createNativeMcpHarness();
  await harness.page.evaluate(() => {
    const control = document.createElement('button');
    control.setAttribute('aria-label', 'Deep ancestor control');
    control.style.cssText = 'position:fixed;top:20px;left:20px;width:200px;height:60px;z-index:9999';
    let parent: HTMLElement = control;
    for (let depth = 0; depth < 200; depth += 1) {
      const child = document.createElement('span');
      child.style.cssText = 'display:block;width:100%;height:100%';
      parent.append(child);
      parent = child;
    }
    parent.textContent = 'Activate';
    control.addEventListener('click', () => {
      document.querySelector('[role="status"]')!.textContent = 'Ancestor activated';
    });
    document.body.append(control);
  });
  const click = await harness.mcpClient.callTool({ arguments: {
    locator: { name: { match: 'exact', value: 'Deep ancestor control' }, role: 'button' },
    targetRef: harness.targetRef,
    timeoutMilliseconds: 2_000,
  }, name: 'browser.click' });
  expect(click.isError, toolText(click)).toBeUndefined();
  expect(await harness.page.getByRole('status').textContent()).toBe('Ancestor activated');
}, 90_000);

it.each([
  { frames: 'cross-origin', shadow: 'closed' },
  { frames: 'same-origin', shadow: 'closed' },
  { frames: 'cross-origin', shadow: 'mixed' },
] as const)('observes and acts through deeply nested $shadow shadow roots inside $frames frames', async ({ frames, shadow }) => {
  expect.assertions(6);
  harness = await createNativeMcpHarness({ frames, shadow });
  const snapshot = await harness.mcpClient.callTool({ arguments: { targetRef: harness.targetRef }, name: 'browser.snapshot' });
  const snapshotText = toolText(snapshot);
  expect(snapshot.isError).toBeUndefined();
  expect(snapshotText).toContain('Deep value');
  expect(snapshotText).toContain('Save deep value');
  const inputReference = /textbox "Deep value"[^\n]*\[ref=(e\d+)\]/u.exec(snapshotText)?.[1];
  const buttonReference = /button "Save deep value"[^\n]*\[ref=(e\d+)\]/u.exec(snapshotText)?.[1];
  if (inputReference === undefined || buttonReference === undefined) throw new Error('The nested controls have no snapshot references.');
  const fill = await harness.mcpClient.callTool({ arguments: { ref: inputReference, targetRef: harness.targetRef, text: 'native closed shadow' }, name: 'browser.fill' });
  const click = await harness.mcpClient.callTool({ arguments: { ref: buttonReference, targetRef: harness.targetRef }, name: 'browser.click' });
  expect(fill.isError, toolText(fill)).toBeUndefined();
  expect(click.isError, toolText(click)).toBeUndefined();
  expect(await harness.page.getByRole('status').textContent()).toBe('Saved: native closed shadow');
}, 90_000);

it.each(['verified', ''])('batches an accessible-name fill with $0 below closed shadow roots in the root document', async (text) => {
  expect.assertions(2);
  harness = await createNativeMcpHarness();
  await harness.page.evaluate(() => {
    let parent: HTMLElement | ShadowRoot = document.body;
    for (let depth = 0; depth < 20; depth += 1) {
      const host = document.createElement('div');
      parent.append(host);
      parent = host.attachShadow({ mode: 'closed' });
    }
    const input = document.createElement('input');
    input.value = 'Initial value';
    input.setAttribute('aria-label', 'Public search');
    input.style.cssText = 'position:fixed;top:10px;left:10px;z-index:9999';
    input.addEventListener('input', () => document.body.setAttribute('data-search-value', input.value));
    parent.append(input);
  });
  const result = await harness.mcpClient.callTool({ name: 'browser.batch', arguments: {
    targetRef: harness.targetRef,
    actions: [{ action: 'fill', locator: { role: 'textbox', name: { match: 'exact', value: 'Public search' } }, text }],
    timeoutMilliseconds: 3_000,
  } });
  expect(result.isError, toolText(result)).toBeUndefined();
  expect(await harness.page.locator('body').getAttribute('data-search-value')).toBe(text);
}, 90_000);

it.each(['css', 'accessible-name'] as const)('batches native $0 fill and click with one final bounded observation', async (strategy) => {
  expect.assertions(4);
  harness = await createNativeMcpHarness();
  const frameChain = [1, 2, 3].map(index => ({ css: `iframe[title="Frame ${index}"]` }));
  const result = await harness.mcpClient.callTool({ arguments: {
    actions: [
      { action: 'fill', locator: strategy === 'css' ? { css: 'input#deep-value', frameChain } : { role: 'textbox', name: { match: 'exact', value: 'Deep value' } }, text: 'batched public workflow' },
      { action: 'click', locator: strategy === 'css' ? { css: 'button#deep-save', frameChain } : { role: 'button', name: { match: 'exact', value: 'Save deep value' } } },
    ],
    observe: true,
    targetRef: harness.targetRef,
    timeoutMilliseconds: 5_000,
  }, name: 'browser.batch' });
  expect(result.isError, toolText(result)).toBeUndefined();
  const output = JSON.parse(toolText(result)) as { readonly completed: readonly { readonly action: string; readonly index: number }[]; readonly observation: string };
  expect(output.completed).toEqual([{ action: 'fill', index: 0 }, { action: 'click', index: 1 }]);
  expect(output.observation.length).toBeLessThanOrEqual(6_000);
  expect(await harness.page.getByRole('status').textContent()).toBe('Saved: batched public workflow');
}, 90_000);

it('stops an active native batch when its target is revoked', async () => {
  expect.assertions(3);
  harness = await createNativeMcpHarness();
  const batch = harness.mcpClient.callTool({ arguments: {
    actions: [
      { action: 'click', locator: { css: 'button#prepare-replacement' } },
      { action: 'click', locator: { role: 'button', name: { match: 'exact', value: 'Never present' } } },
      { action: 'click', locator: { css: 'button#toggle-overlay' } },
    ],
    targetRef: harness.targetRef,
    timeoutMilliseconds: 5_000,
  }, name: 'browser.batch' });
  await harness.page.getByRole('button', { name: 'Save replacement', exact: true }).waitFor({ state: 'attached' });
  await harness.revoke();
  const result = await batch;
  const output = JSON.parse(toolText(result)) as { readonly details: { readonly completed: readonly { readonly index: number }[] } };
  expect(result.isError).toBe(true);
  expect(output.details.completed.every(step => step.index < 1)).toBe(true);
  expect(await harness.page.locator('#parent-overlay').count()).toBe(0);
}, 90_000);

it('stops a native batch when a click replaces the root document', async () => {
  expect.assertions(3);
  harness = await createNativeMcpHarness();
  const result = await harness.mcpClient.callTool({ arguments: {
    actions: [
      { action: 'click', locator: { css: 'button#navigate-fixture' } },
      { action: 'click', locator: { css: 'button#prepare-replacement' } },
    ],
    targetRef: harness.targetRef,
    timeoutMilliseconds: 5_000,
  }, name: 'browser.batch' });
  await harness.page.waitForURL(url => url.searchParams.get('revision') === '1');
  const output = JSON.parse(toolText(result)) as { readonly details: { readonly completed: readonly { readonly index: number }[] } };
  expect(result.isError).toBe(true);
  expect(output.details.completed.every(step => step.index < 1)).toBe(true);
  expect(await harness.page.getByRole('button', { name: 'Save replacement', exact: true }).count()).toBe(0);
}, 90_000);

it('bounds a 100,000-node, 1,000-layer stress snapshot or returns an explicit size error', async () => {
  expect.assertions(5);
  harness = await createNativeMcpHarness({ profile: 'stress' });
  const startedAt = performance.now();
  const result = await harness.mcpClient.callTool({ arguments: { targetRef: harness.targetRef }, name: 'browser.snapshot' });
  const duration = performance.now() - startedAt;
  const text = toolText(result);
  expect(duration).toBeLessThan(10_000);
  expect(text.length).toBeLessThanOrEqual(6_000);
  expect(result.isError ? (JSON.parse(text) as { readonly code: string }).code === 'MCP_SEARCH_INCOMPLETE' : text.includes('Save deep value') || text.includes('truncated'), text).toBe(true);
  expect((await harness.client.listTargets()).map(target => target.id)).toContain(harness.target.id);
  const authority = { targetId: harness.target.id, targetGeneration: harness.target.generation };
  const lease = await harness.client.acquireLease({ ...authority, mode: 'shared-read', requestedMethods: ['Page.getLayoutMetrics'], durationMilliseconds: 1000 });
  const stillUsable = await harness.client.executeCommand({ ...authority, leaseId: lease.id, method: 'Page.getLayoutMetrics', operationId: crypto.randomUUID(), parameters: {} });
  await harness.client.releaseLease({ ...authority, leaseId: lease.id });
  expect(stillUsable.value).toHaveProperty('cssLayoutViewport');
}, 90_000);

it.each([
  { frames: 'cross-origin', action: 'click' },
  { frames: 'same-origin', action: 'click' },
  { frames: 'cross-origin', action: 'fill' },
  { frames: 'same-origin', action: 'fill' },
] as const)('refuses a child-frame $action obscured by a $frames parent-frame overlay', async ({ frames, action }) => {
  expect.assertions(3);
  harness = await createNativeMcpHarness({ frames });
  const snapshot = await harness.mcpClient.callTool({ arguments: { targetRef: harness.targetRef }, name: 'browser.snapshot' });
  const elementReference = (action === 'click' ? /button "Save deep value"[^\n]*\[ref=(e\d+)\]/u : /textbox "Deep value"[^\n]*\[ref=(e\d+)\]/u).exec(toolText(snapshot))?.[1];
  if (elementReference === undefined) throw new Error('The nested control has no snapshot reference.');
  const cover = await harness.mcpClient.callTool({ arguments: { locator: { css: 'button#toggle-overlay' }, targetRef: harness.targetRef }, name: 'browser.click' });
  if (cover.isError) throw new Error(toolText(cover));
  const actionResult = await harness.mcpClient.callTool({ arguments: { ref: elementReference, targetRef: harness.targetRef, timeoutMilliseconds: 300, ...(action === 'fill' ? { text: 'Must remain blocked' } : {}) }, name: `browser.${action}` });
  expect(actionResult.isError, toolText(actionResult)).toBe(true);
  expect(toolText(actionResult)).toContain('MCP_ELEMENT_COVERED');
  expect(await harness.page.getByRole('status').textContent()).toBe('Ready');
}, 90_000);

it('re-resolves a locator when scrolling replaces its element before input', async () => {
  expect.assertions(2);
  harness = await createNativeMcpHarness();
  const prepare = await harness.mcpClient.callTool({ arguments: { locator: { css: 'button#prepare-replacement' }, targetRef: harness.targetRef }, name: 'browser.click' });
  if (prepare.isError) throw new Error(toolText(prepare));
  const click = await harness.mcpClient.callTool({ arguments: {
    locator: { name: { match: 'exact', value: 'Save replacement' }, role: 'button' },
    targetRef: harness.targetRef,
    timeoutMilliseconds: 2_000,
  }, name: 'browser.click' });
  expect(click.isError, toolText(click)).toBeUndefined();
  expect(await harness.page.getByRole('status').textContent()).toBe('Replacement saved');
}, 90_000);

it('activates a deeply nested button with the native Enter key', async () => {
  expect.assertions(3);
  harness = await createNativeMcpHarness();
  const snapshot = await harness.mcpClient.callTool({ arguments: { targetRef: harness.targetRef }, name: 'browser.snapshot' });
  const inputReference = /textbox "Deep value"[^\n]*\[ref=(e\d+)\]/u.exec(toolText(snapshot))?.[1];
  const buttonReference = /button "Save deep value"[^\n]*\[ref=(e\d+)\]/u.exec(toolText(snapshot))?.[1];
  if (inputReference === undefined || buttonReference === undefined) throw new Error('The snapshot omitted the deep controls.');
  const fill = await harness.mcpClient.callTool({ arguments: { ref: inputReference, targetRef: harness.targetRef, text: 'native Enter' }, name: 'browser.fill' });
  const press = await harness.mcpClient.callTool({ arguments: { key: 'Enter', ref: buttonReference, targetRef: harness.targetRef }, name: 'browser.press' });
  expect(fill.isError, toolText(fill)).toBeUndefined();
  expect(press.isError, toolText(press)).toBeUndefined();
  expect(await harness.page.getByRole('status').textContent()).toBe('Saved: native Enter');
}, 90_000);

it('composes a descendant locator and expands a scoped snapshot through deep closed roots', async () => {
  expect.assertions(5);
  harness = await createNativeMcpHarness();
  const groupLocator = {
    frameChain: [1, 2, 3].map(index => ({ css: `iframe[title="Frame ${index}"]` })),
    name: { match: 'exact', value: 'Layer 0' },
    role: 'group',
  };
  const snapshot = await harness.mcpClient.callTool({ arguments: { root: { locator: groupLocator }, targetRef: harness.targetRef }, name: 'browser.snapshot' });
  expect(snapshot.isError, toolText(snapshot)).toBeUndefined();
  expect(toolText(snapshot)).toContain('Deep value');
  expect(toolText(snapshot)).toContain('Save deep value');
  const click = await harness.mcpClient.callTool({ arguments: {
    locator: { ...groupLocator, descendants: [{ name: { match: 'exact', value: 'Save deep value' }, role: 'button' }] },
    targetRef: harness.targetRef,
  }, name: 'browser.click' });
  expect(click.isError, toolText(click)).toBeUndefined();
  expect(await harness.page.getByRole('status').textContent()).toBe('Saved: ');
}, 90_000);
