import type { BrowserContext } from 'playwright';

import type { JsonObject } from '../../../packages/core/src/protocol.js';

/** Toolbar popups are Chrome targets that Playwright does not expose as context pages. */
export async function attachExtensionPopup(context: BrowserContext): Promise<{ close: () => Promise<void>; click: (name: string) => Promise<void>; selectScope: (scope: 'group' | 'tab' | 'window') => Promise<void>; text: () => Promise<string> }> {
  const browser = context.browser();
  if (browser === null) throw new Error('The fixture has no Chromium browser.');
  const session = await browser.newBrowserCDPSession();
  const targets = await session.send('Target.getTargets');
  const target = targets.targetInfos.find(candidate => candidate.url.endsWith('/popup.html'));
  if (target === undefined) throw new Error('Chrome did not create the toolbar popup target.');
  const { sessionId } = await session.send('Target.attachToTarget', { flatten: false, targetId: target.targetId });
  let nextRequestId = 1;
  const pending = new Map<number, { readonly reject: (error: Error) => void; readonly resolve: (value: JsonObject) => void }>();
  session.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message) as { readonly error?: { readonly message: string }; readonly id?: number; readonly result?: JsonObject };
    if (response.id === undefined) return;
    const request = pending.get(response.id);
    pending.delete(response.id);
    if (response.error !== undefined) request?.reject(new Error(response.error.message));
    else request?.resolve(response.result ?? {});
  });
  const send = async (method: string, parameters: JsonObject): Promise<JsonObject> => {
    const requestId = nextRequestId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`The popup ${method} command timed out.`));
      }, 5_000);
      pending.set(requestId, {
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
      });
    });
    await session.send('Target.sendMessageToTarget', { message: JSON.stringify({ id: requestId, method, params: parameters }), sessionId });
    return response;
  };
  const evaluate = async (expression: string): Promise<unknown> => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails !== undefined) throw new Error(JSON.stringify(response.exceptionDetails));
    return (response.result as { readonly value?: unknown } | undefined)?.value;
  };
  return {
    async close() {
      await session.send('Target.closeTarget', { targetId: target.targetId });
      await session.detach();
    },
    async click(name) {
      const bounds = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === ${JSON.stringify(name)}); if (!button) return null; const bounds = button.getBoundingClientRect(); return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; })()`) as { readonly x: number; readonly y: number } | null;
      if (bounds === null) throw new Error(`The popup has no ${name} button.`);
      await send('Input.dispatchMouseEvent', { ...bounds, button: 'left', clickCount: 1, type: 'mousePressed' });
      await send('Input.dispatchMouseEvent', { ...bounds, button: 'left', clickCount: 1, type: 'mouseReleased' });
    },
    async selectScope(scope) {
      await evaluate(`(() => { const select = document.querySelector('#scope'); const option = [...select.options].find(candidate => candidate.value === ${JSON.stringify(scope)}); if (!option || option.disabled) throw new Error('The requested popup scope is unavailable.'); select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    },
    async text() {
      return String(await evaluate('document.body.innerText'));
    },
  };
}
