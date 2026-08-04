import type { IndexedDbPairingStore } from '@dvcol/chrome-debugger-bridge-extension';
import type {
  BrowserAgentConnection,
  PairedAgentCredentialStore,
} from '@dvcol/chrome-debugger-bridge-websocket/browser';

import { createIndexedDbPairingStore } from '@dvcol/chrome-debugger-bridge-extension';
import { connectAgentWebSocket } from '@dvcol/chrome-debugger-bridge-websocket/browser';

type Expect<Value extends true> = Value;
type IndexedDbStoreSatisfiesBrowserStore = Expect<IndexedDbPairingStore extends PairedAgentCredentialStore ? true : false>;

const pairingStore = createIndexedDbPairingStore({ databaseName: 'packed-consumer' });
const browserConnectionPromise: Promise<BrowserAgentConnection> = connectAgentWebSocket({
  credentialStore: pairingStore,
  endpoint: 'ws://127.0.0.1:9222/__chrome_debugger_bridge/agent',
  origin: 'chrome-extension://packed-consumer',
});

void browserConnectionPromise;
void (0 as unknown as IndexedDbStoreSatisfiesBrowserStore);
