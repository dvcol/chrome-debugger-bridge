import type { BrokerState } from '@dvcol/cdb-broker/contract';
import type { TabScopeSelector } from '@dvcol/cdb-extension';

import { createCdbClient } from '@dvcol/cdb-devframe/client';
import { createIndexedDbPairingStore } from '@dvcol/cdb-extension';
import { createChromeProvider, getChromeProviderIdentity } from '@dvcol/cdb-extension/chrome';
import { connectDevframe } from 'devframe/client';
import { DEVFRAME_WS_ROUTE } from 'devframe/constants';

let provider: ReturnType<typeof createChromeProvider<chrome.runtime.MessageSender>> | undefined;
let closeConnection: (() => Promise<void>) | undefined;
let state: BrokerState | undefined;
let failure: string | undefined;
const popupUrl = chrome.runtime.getURL('popup.html');
function trusted(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined && sender.url === popupUrl;
}
async function connect(baseURL: string, code: string): Promise<void> {
  await provider?.dispose();
  await closeConnection?.();
  let connection: Awaited<ReturnType<typeof connectDevframe>> | undefined;
  let client: ReturnType<typeof createCdbClient> | undefined;
  let stopObserving: (() => void) | undefined;
  const disposeConnection = async (): Promise<void> => {
    stopObserving?.();
    client?.disconnected();
    try {
      await client?.dispose();
    } finally {
      connection?.close?.();
    }
    client = undefined;
    connection = undefined;
  };
  closeConnection = disposeConnection;
  async function currentClient(): Promise<ReturnType<typeof createCdbClient>> {
    if (client !== undefined && connection?.status === 'connected') return client;
    await disposeConnection();
    const candidate = await connectDevframe({ baseURL, simpleAuth: false, connectionMeta: { backend: 'websocket', websocket: { path: DEVFRAME_WS_ROUTE } } });
    try {
      if (code.length > 0) await candidate.requestTrustWithCode(code);
      await candidate.ensureTrusted();
      code = '';
      connection = candidate;
      client = createCdbClient(candidate);
      const current = client;
      stopObserving = candidate.events.on('connection:status', (status) => {
        if (status === 'disconnected') current.disconnected();
      });
      return current;
    } catch (error) {
      candidate.close?.();
      throw error;
    }
  }
  await currentClient();
  const registration = { id: 'example-chrome', instanceId: await getChromeProviderIdentity('cdb-example-installation'), maximumLevel: 'debug' as const, name: 'Example Chrome extension', version: chrome.runtime.getManifest().version };
  provider = createChromeProvider({
    connect: async () => (await currentClient()).connectProvider({ registration, pairingKey: baseURL, pairingStore: createIndexedDbPairingStore(), confirmPairing: () => true }),
    maximumLevel: registration.maximumLevel,
    authorizeApproval: (_request, _selector, sender) => trusted(sender),
    recoveryStorageKey: 'cdb-example-recovery',
    recoveryAlarmName: 'cdb-example-heartbeat',
    onState(value) {
      state = value;
      failure = undefined;
    },
    onError(error) {
      failure = error instanceof Error ? error.message : String(error);
    },
  });
  provider.start();
}
chrome.runtime.onMessage.addListener((message: { kind: string; baseURL?: string; code?: string; requestId?: string; selector?: TabScopeSelector }, sender, reply) => {
  if (!trusted(sender)) return false;
  void (async () => {
    if (message.kind === 'state') return { state, failure };
    if (message.kind === 'connect' && message.baseURL !== undefined) return connect(message.baseURL, message.code ?? '');
    if (message.kind === 'approve' && message.requestId !== undefined && message.selector !== undefined && provider !== undefined)
      return provider.approve(message.requestId, message.selector, sender);
    if (message.kind === 'revoke' && message.requestId !== undefined && provider !== undefined) return provider.revoke(message.requestId);
    throw new Error('Unsupported example request.');
  })().then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
