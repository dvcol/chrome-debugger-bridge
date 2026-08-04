export interface StoredBrokerPairing {
  readonly agentId: string;
  readonly brokerId: string;
  readonly credentialId: string;
  readonly endpoint: string;
  readonly key: CryptoKey;
}

export interface IndexedDbPairingStore {
  load: (endpoint: string) => Promise<StoredBrokerPairing | undefined>;
  remove: (credentialId: string) => Promise<void>;
  save: (pairing: StoredBrokerPairing) => Promise<void>;
}

export interface CreateIndexedDbPairingStoreOptions {
  readonly databaseName?: string;
}

const pairingObjectStoreName = 'pairings';

async function openPairingDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(pairingObjectStoreName)) {
        const objectStore = database.createObjectStore(pairingObjectStoreName, { keyPath: 'endpoint' });
        objectStore.createIndex('credentialId', 'credentialId', { unique: true });
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('Unable to open pairing database')), {
      once: true,
    });
  });
}

async function requestResult<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('Pairing database request failed')), {
      once: true,
    });
  });
}

async function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Pairing transaction aborted')), {
      once: true,
    });
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('Pairing transaction failed')), {
      once: true,
    });
  });
}

function isValidPairing(value: unknown): value is StoredBrokerPairing {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const pairing = value as Partial<StoredBrokerPairing>;
  const algorithmName = typeof pairing.key?.algorithm?.name === 'string' ? pairing.key.algorithm.name : undefined;
  return typeof pairing.agentId === 'string'
    && typeof pairing.brokerId === 'string'
    && typeof pairing.credentialId === 'string'
    && typeof pairing.endpoint === 'string'
    && pairing.key?.extractable === false
    && algorithmName === 'HKDF'
    && pairing.key.usages.length === 1
    && pairing.key.usages[0] === 'deriveKey';
}

export function createIndexedDbPairingStore(
  options: CreateIndexedDbPairingStoreOptions = {},
): IndexedDbPairingStore {
  const databaseName = options.databaseName ?? 'chrome-debugger-bridge';

  return {
    async load(endpoint) {
      const database = await openPairingDatabase(databaseName);
      try {
        const transaction = database.transaction(pairingObjectStoreName, 'readonly');
        const value = await requestResult(transaction.objectStore(pairingObjectStoreName).get(endpoint) as IDBRequest<unknown>);
        await transactionComplete(transaction);
        return isValidPairing(value) ? value : undefined;
      } finally {
        database.close();
      }
    },
    async remove(credentialId) {
      const database = await openPairingDatabase(databaseName);
      try {
        const transaction = database.transaction(pairingObjectStoreName, 'readwrite');
        const objectStore = transaction.objectStore(pairingObjectStoreName);
        const endpoint = await requestResult(objectStore.index('credentialId').getKey(credentialId));
        if (endpoint !== undefined) {
          objectStore.delete(endpoint);
        }
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    },
    async save(pairing) {
      if (!isValidPairing(pairing)) {
        throw new Error('Pairing must contain a non-extractable HKDF key');
      }
      const database = await openPairingDatabase(databaseName);
      try {
        const transaction = database.transaction(pairingObjectStoreName, 'readwrite');
        transaction.objectStore(pairingObjectStoreName).put(pairing);
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    },
  };
}
