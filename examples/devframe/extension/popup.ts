import type { BrokerState } from '@dvcol/cdb-broker/contract';
import type { TabScopeSelector } from '@dvcol/cdb-extension';

const status = document.querySelector<HTMLElement>('#status')!;
const requests = document.querySelector<HTMLElement>('#requests')!;
let busy = false;
async function send<Value>(message: object): Promise<Value> {
  const result = await chrome.runtime.sendMessage<object, { readonly ok: boolean; readonly value: Value; readonly error?: string }>(message);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function perform(action: () => Promise<unknown>): Promise<void> {
  busy = true;
  try {
    await action();
    status.textContent = 'Done.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
  }
}
document.querySelector<HTMLButtonElement>('#connect')!.onclick = () => {
  void perform(async () => send({ kind: 'connect', baseURL: document.querySelector<HTMLInputElement>('#host')!.value, code: document.querySelector<HTMLInputElement>('#code')!.value }));
};
async function refresh(): Promise<void> {
  if (busy) return;
  const result = await send<{ state?: BrokerState; failure?: string }>({ kind: 'state' });
  if (result.failure !== undefined) status.textContent = result.failure;
  requests.replaceChildren();
  for (const request of result.state?.requests ?? []) {
    const section = document.createElement('section');
    const description = document.createElement('p');
    description.textContent = `${request.principalLabel} requests ${request.level} access (${request.navigation}).`;
    const approve = document.createElement('button');
    approve.textContent = `Allow ${request.level}`;
    approve.onclick = () => void perform(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('Select a browser tab first.');
      const scope = document.querySelector<HTMLSelectElement>('#scope')!.value;
      const selector: TabScopeSelector = scope === 'group' ? { kind: 'group', groupId: tab.groupId } : scope === 'window' ? { kind: 'window', windowId: tab.windowId } : { kind: 'explicit-tabs', tabIds: [tab.id] };
      await send({ kind: 'approve', requestId: request.id, selector });
    });
    section.append(description, approve);
    requests.append(section);
  }
  for (const scope of result.state?.scopes ?? []) {
    const revoke = document.createElement('button');
    revoke.textContent = `Stop ${scope.principalLabel}`;
    revoke.onclick = () => void perform(async () => send({ kind: 'revoke', requestId: scope.id }));
    requests.append(revoke);
  }
}
void refresh().catch((error) => {
  status.textContent = String(error);
});
const interval = setInterval(() => void refresh().catch((error) => {
  status.textContent = String(error);
}), 1_000);
window.addEventListener('pagehide', () => clearInterval(interval), { once: true });
