import type { CapabilityGrant, JsonValue } from './protocol.js';

export interface AuthorityBinding {
  readonly bindingId: string;
  readonly capabilities: CapabilityGrant;
  readonly expiresAt?: string | null;
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface AuthorityRecord {
  readonly activeConnectionId?: string;
  readonly bindings: readonly AuthorityBinding[];
  readonly connectionGeneration: number;
  readonly logicalSessionId: string;
  readonly metadata?: JsonValue;
  readonly principalId: string;
  readonly resumeCredentialHash?: string;
  readonly resumeExpiresAt?: string | null;
}

export interface AuthorityStoreChange {
  readonly logicalSessionId: string;
}

export interface AuthorityStore {
  delete: (logicalSessionId: string) => Promise<void>;
  get: (logicalSessionId: string) => Promise<AuthorityRecord | undefined>;
  set: (record: AuthorityRecord) => Promise<void>;
  subscribe: (listener: (change: AuthorityStoreChange) => void) => () => void;
  update: (
    logicalSessionId: string,
    updater: (current: AuthorityRecord | undefined) => AuthorityRecord | undefined,
  ) => Promise<AuthorityRecord | undefined>;
}

function assertAuthorityRecord(record: AuthorityRecord): void {
  if (record.logicalSessionId.length === 0 || record.principalId.length === 0) {
    throw new TypeError('Authority records require non-empty logical session and principal identifiers.');
  }
  if (!Number.isSafeInteger(record.connectionGeneration) || record.connectionGeneration < 1) {
    throw new TypeError('Authority connection generations must be positive safe integers.');
  }
  for (const binding of record.bindings) {
    if (binding.bindingId.length === 0 || binding.targetId.length === 0) {
      throw new TypeError('Authority bindings require non-empty binding and target identifiers.');
    }
    if (!Number.isSafeInteger(binding.targetGeneration) || binding.targetGeneration < 1) {
      throw new TypeError('Authority binding target generations must be positive safe integers.');
    }
    if (binding.expiresAt !== undefined && binding.expiresAt !== null && !Number.isFinite(Date.parse(binding.expiresAt))) {
      throw new TypeError('Authority binding expiration must be an ISO timestamp, null, or omitted.');
    }
  }
}

/** Creates an asynchronous reactive authority store with no I/O. */
export function createMemoryAuthorityStore(
  initialRecords: readonly AuthorityRecord[] = [],
): AuthorityStore {
  const records = new Map<string, AuthorityRecord>();
  const listeners = new Set<(change: AuthorityStoreChange) => void>();
  for (const record of initialRecords) {
    assertAuthorityRecord(record);
    records.set(record.logicalSessionId, structuredClone(record));
  }

  function notify(logicalSessionId: string): void {
    for (const listener of listeners) listener({ logicalSessionId });
  }

  return {
    async delete(logicalSessionId) {
      if (!records.delete(logicalSessionId)) return;
      notify(logicalSessionId);
    },
    async get(logicalSessionId) {
      const record = records.get(logicalSessionId);
      return record === undefined ? undefined : structuredClone(record);
    },
    async set(record) {
      assertAuthorityRecord(record);
      records.set(record.logicalSessionId, structuredClone(record));
      notify(record.logicalSessionId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async update(logicalSessionId, updater) {
      const current = records.get(logicalSessionId);
      const updated = updater(current === undefined ? undefined : structuredClone(current));
      if (updated === undefined) {
        if (records.delete(logicalSessionId)) notify(logicalSessionId);
        return undefined;
      }
      if (updated.logicalSessionId !== logicalSessionId) {
        throw new TypeError('An authority update cannot change the logical session identifier.');
      }
      assertAuthorityRecord(updated);
      const stored = structuredClone(updated);
      records.set(logicalSessionId, stored);
      notify(logicalSessionId);
      return structuredClone(stored);
    },
  };
}
