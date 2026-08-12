import type { IndexedDbPairingStore } from '@dvcol/cdb-extension';
import type {
  BrowserAgentConnection,
  PairedAgentCredentialStore,
} from '@dvcol/cdb-websocket/browser';

import { createIndexedDbPairingStore } from '@dvcol/cdb-extension';
import { connectAgentWebSocket } from '@dvcol/cdb-websocket/browser';

type Expect<Value extends true> = Value;
type IndexedDbStoreSatisfiesBrowserStore = Expect<IndexedDbPairingStore extends PairedAgentCredentialStore ? true : false>;

const pairingStore = createIndexedDbPairingStore({ databaseName: 'packed-consumer' });
const browserConnectionPromise: Promise<BrowserAgentConnection> = connectAgentWebSocket({
  credentialStore: pairingStore,
  endpoint: 'ws://127.0.0.1:9222/cdb/agent',
  origin: 'chrome-extension://packed-consumer',
});

void browserConnectionPromise;
void (0 as unknown as IndexedDbStoreSatisfiesBrowserStore);
