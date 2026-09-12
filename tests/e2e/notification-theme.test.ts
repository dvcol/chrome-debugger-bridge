import { readFile } from 'node:fs/promises';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it('keeps the built renderer responsive across themes, narrow layouts and pending actions', async () => {
  expect.assertions(15);
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 440, height: 1100 }, colorScheme: 'light' });
    await page.setContent('<main style="width:390px;max-width:100%"></main>');
    const bundle = await readFile(new URL('../../packages/extension/dist/notifications.js', import.meta.url), 'utf8');
    await page.addScriptTag({ type: 'module', content: `${bundle}
      const controller = createBrowserControlNotificationController({ onReview: () => new Promise(resolve => { window.complete = resolve; }), onRevoke: async () => {} });
      window.renderer = renderBrowserControlNotifications({ controller, container: document.querySelector('main'), reviewLabel: () => 'Accept', onReject: async () => { window.rejected = true; } });
      controller.update({ grants: [], requests: ['observe', 'inspect', 'interact', 'debug', 'unsafe'].map((level, index) => ({ id: String(index), principalId: 'synthetic', principalLabel: index === 1 ? 'Long synthetic client label wrapping onto its own row' : '3d12', level, navigation: 'same-origin', state: 'pending', createdAt: 0, expiresAt: null })) });
    ` });
    const card = page.locator('article').first();
    await card.waitFor();
    expect(await card.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
    const geometry = async (index: number) => page.locator('article').nth(index).locator('dl > div').evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, width: element.getBoundingClientRect().width })));
    const short = await geometry(0);
    expect(short[0]!.top).toBe(short[1]!.top);
    const long = await geometry(1);
    expect(long[0]!.top).toBeGreaterThan(long[1]!.top);
    expect(long[1]!.top).toBe(long[2]!.top);
    expect(new Set(await page.locator('[data-level]').evaluateAll(elements => elements.map(element => getComputedStyle(element).color))).size).toBe(5);
    const accept = card.getByRole('button', { name: 'Accept', exact: true });
    await accept.focus();
    await page.evaluate('window.renderer.setTheme({ radius: "16px" })');
    expect(await accept.evaluate((element) => {
      const root = element.getRootNode();
      return root instanceof ShadowRoot && root.activeElement === element;
    })).toBe(true);
    expect(await card.evaluate(element => getComputedStyle(element).borderRadius)).toBe('16px');
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await card.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(37, 36, 44)');
    await page.evaluate('window.renderer.setColorMode("light")');
    expect(await card.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
    await page.evaluate('window.renderer.setColorMode("dark")');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await card.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(37, 36, 44)');
    await accept.click();
    expect(await accept.isDisabled()).toBe(true);
    await page.evaluate('window.renderer.setTheme({ dark: { primary: "#123456" } })');
    expect(await accept.isDisabled()).toBe(true);
    await page.evaluate('window.complete()');
    await expect.poll(async () => accept.isDisabled()).toBe(false);
    await page.setViewportSize({ width: 280, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
    expect(await page.locator('article').count()).toBe(4);
  } finally {
    await browser.close();
  }
}, 30_000);
