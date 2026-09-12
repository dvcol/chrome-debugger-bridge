import { createCdbClient } from '@dvcol/cdb-devframe/client';
import { createIndexedDbPairingStore } from '@dvcol/cdb-extension';
import { createChromeProvider, getChromeProviderIdentity } from '@dvcol/cdb-extension/chrome';
import { connectDevframe } from 'devframe/client';

let provider: ReturnType<typeof createChromeProvider<boolean>> | undefined;
let connection: Awaited<ReturnType<typeof connectDevframe>> | undefined;
let client: ReturnType<typeof createCdbClient> | undefined;
let approvedGroupId: number | undefined;

Object.assign(globalThis, {
  async startDevframeProvider(baseURL: string) {
    const registration = { id: 'public-chrome-provider', instanceId: await getChromeProviderIdentity('public-cdb-fixture'), name: 'Public Chrome fixture', version: '1.0.0', maximumLevel: 'debug' as const };
    provider = createChromeProvider({
      maximumLevel: registration.maximumLevel,
      async connect() {
        if (connection === undefined || connection.status !== 'connected') {
          connection = await connectDevframe({ baseURL, simpleAuth: false });
          await connection.ensureTrusted();
          client = createCdbClient(connection);
        }
        return client!.connectProvider({ registration, pairingKey: baseURL, pairingStore: createIndexedDbPairingStore(), confirmPairing: () => true });
      },
      authorizeApproval: (_request, _selector, trusted: boolean) => trusted,
      recoveryStorageKey: 'public-cdb-recovery',
    });
    provider.start();
  },
  async approveDevframeRequest(requestId: string, scope: 'tab' | 'group' = 'tab') {
    const tabs = await chrome.tabs.query({});
    const selected = tabs.find(tab => tab.url?.startsWith('http://cdb-root.test:'));
    if (selected?.id === undefined || provider === undefined) throw new Error('The public fixture tab is unavailable.');
    if (scope === 'group') {
      approvedGroupId = await chrome.tabs.group({ tabIds: [selected.id] });
      return provider.approve(requestId, { kind: 'group', groupId: approvedGroupId }, true);
    }
    return provider.approve(requestId, { kind: 'explicit-tabs', tabIds: [selected.id] }, true);
  },
  async changeFixtureMembership(url: string, joined: boolean) {
    const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
    if (tab?.id === undefined || approvedGroupId === undefined) throw new Error('The fixture group or tab is unavailable.');
    if (joined) await chrome.tabs.group({ tabIds: [tab.id], groupId: approvedGroupId });
    else await chrome.tabs.ungroup(tab.id);
  },
  async readDevframeState() {
    return client!.snapshot();
  },
  disconnectDevframeProvider() {
    client?.disconnected();
    connection?.close?.();
    connection = undefined;
  },
  async stopDevframeProvider() {
    await provider?.dispose();
  },
});
