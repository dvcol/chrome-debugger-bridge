import type { GrantRequest } from '@dvcol/cdb';
import type { ApprovalChannelResult, TabScopeSelector } from '@dvcol/cdb-extension';

import type { ExampleState } from './service-worker.ts';

const { chrome } = globalThis;

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing popup element: ${selector}`);
  return element;
}

const status = requiredElement<HTMLElement>('#status');
const scope = requiredElement<HTMLSelectElement>('#scope');
const requests = requiredElement<HTMLElement>('#requests');
const selectedTabLabel = requiredElement<HTMLElement>('#selected-tab');
const groupOption = requiredElement<HTMLOptionElement>('#scope [value="group"]');
let renderedState: string | undefined;
let busy = false;

async function refresh(): Promise<void> {
  if (busy) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  selectedTabLabel.textContent = tab?.title ?? 'No active tab';
  groupOption.disabled = tab?.groupId === undefined || tab.groupId < 0;
  const state = await chrome.runtime.sendMessage<unknown, ExampleState | { readonly error?: string }>({ kind: 'example.state' });
  if (!('requests' in state)) {
    status.textContent = state.error ?? 'The example host is unavailable. Start it and reload the extension.';
    return;
  }
  const nextState = JSON.stringify([state.requests, tab?.id, tab?.groupId, tab?.windowId]);
  if (renderedState === nextState) return;
  renderedState = nextState;
  status.textContent = state.requests.length === 0 ? 'No access requests. Start the Node client to request access.' : '';
  requests.replaceChildren();
  for (const request of state.requests) {
    const section = document.createElement('section');
    const title = document.createElement('strong');
    title.textContent = `Agent ${request.principalId.slice(-6)} · ${(request.capabilities.level ?? 'observe').toUpperCase()}`;
    const description = document.createElement('p');
    description.textContent = request.state === 'granted' ? 'Access is active.' : 'Approve the requested level for the selected tab scope.';
    section.append(title, description);
    if (request.state === 'pending') {
      const approve = document.createElement('button');
      approve.textContent = `Allow ${(request.capabilities.level ?? 'observe').toUpperCase()}`;
      approve.dataset.requestId = request.id;
      approve.disabled = tab?.id === undefined;
      approve.addEventListener('click', () => void decide(request, true, tab));
      section.append(approve);
    }
    const deny = document.createElement('button');
    deny.textContent = request.state === 'granted' ? 'Revoke' : 'Deny';
    deny.addEventListener('click', () => void decide(request, false, tab));
    section.append(deny);
    requests.append(section);
  }
}

async function decide(request: GrantRequest, approve: boolean, tab: chrome.tabs.Tab | undefined): Promise<void> {
  busy = true;
  status.textContent = approve ? 'Granting access…' : 'Removing access…';
  try {
    let selector: TabScopeSelector | undefined;
    if (approve) {
      if (tab?.id === undefined) throw new Error('The selected tab is unavailable.');
      if (scope.value === 'group') {
        if (tab.groupId < 0) throw new Error('The selected tab no longer belongs to a group.');
        selector = { groupId: tab.groupId, kind: 'group' };
      } else if (scope.value === 'window') selector = { kind: 'window', windowId: tab.windowId };
      else selector = { kind: 'explicit-tabs', tabIds: [tab.id] };
    }
    const result = await chrome.runtime.sendMessage<unknown, ApprovalChannelResult | { readonly error: string; readonly ok: false }>({
      kind: approve ? 'cdb.approval.approve' : 'cdb.approval.deny',
      requestId: request.id,
      ...(approve ? { selector } : {}),
    });
    if (result.ok !== true) throw new Error(('error' in result ? result.error : result.code) ?? 'The decision failed.');
    status.textContent = approve ? 'Access granted.' : 'Access removed.';
    renderedState = undefined;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    await refresh();
  }
}

void refresh();
setInterval(() => void refresh(), 1_000);
