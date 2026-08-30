import type { AuthorityRecord, AuthorityStore } from '../src/authority.js';

import { describe, expect, it } from 'vitest';

import { createMemoryAuthorityStore } from '../src/authority.js';

const record: AuthorityRecord = {
  bindings: [{ bindingId: 'binding-1', capabilities: { level: 'inspect' }, targetGeneration: 2, targetId: 'target-1' }],
  connectionGeneration: 1,
  logicalSessionId: 'session-1',
  principalId: 'principal-1',
};

function createFakePersistentAuthorityStore(): AuthorityStore {
  const records = new Map<string, string>();
  const listeners = new Set<Parameters<AuthorityStore['subscribe']>[0]>();
  const notify = (logicalSessionId: string): void => {
    for (const listener of listeners) listener({ logicalSessionId });
  };
  return {
    async delete(logicalSessionId) {
      if (records.delete(logicalSessionId)) notify(logicalSessionId);
    },
    async get(logicalSessionId) {
      const serialized = records.get(logicalSessionId);
      return serialized === undefined ? undefined : JSON.parse(serialized) as AuthorityRecord;
    },
    async set(value) {
      records.set(value.logicalSessionId, JSON.stringify(value));
      notify(value.logicalSessionId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async update(logicalSessionId, updater) {
      const serialized = records.get(logicalSessionId);
      const current = serialized === undefined ? undefined : JSON.parse(serialized) as AuthorityRecord;
      const updated = updater(current);
      if (updated === undefined) {
        if (records.delete(logicalSessionId)) notify(logicalSessionId);
        return undefined;
      }
      records.set(logicalSessionId, JSON.stringify(updated));
      notify(logicalSessionId);
      return JSON.parse(JSON.stringify(updated)) as AuthorityRecord;
    },
  };
}

async function exerciseStore(store: AuthorityStore): Promise<void> {
  const changes: string[] = [];
  const unsubscribe = store.subscribe(change => changes.push(change.logicalSessionId));
  await store.set(record);
  const stored = await store.get(record.logicalSessionId);
  await store.update(record.logicalSessionId, current => current === undefined
    ? undefined
    : { ...current, connectionGeneration: current.connectionGeneration + 1 });
  await store.delete(record.logicalSessionId);
  unsubscribe();

  expect(stored).toStrictEqual(record);
  expect(changes).toStrictEqual(['session-1', 'session-1', 'session-1']);
  await expect(store.get(record.logicalSessionId)).resolves.toBeUndefined();
}

describe('createMemoryAuthorityStore', () => {
  it('implements the asynchronous reactive store contract', async () => {
    expect.assertions(3);
    await exerciseStore(createMemoryAuthorityStore());
  });

  it('isolates stored values from caller mutation', async () => {
    expect.assertions(1);
    const store = createMemoryAuthorityStore([record]);
    const first = await store.get(record.logicalSessionId);
    if (first !== undefined) (first as { bindings: AuthorityRecord['bindings'] }).bindings = [];

    expect(await store.get(record.logicalSessionId)).toStrictEqual(record);
  });

  it('shares the contract with a serialized persistent implementation', async () => {
    expect.assertions(3);
    await exerciseStore(createFakePersistentAuthorityStore());
  });

  it('rejects an update that changes the key', async () => {
    expect.assertions(1);
    const store = createMemoryAuthorityStore([record]);

    await expect(store.update(record.logicalSessionId, current => ({ ...current!, logicalSessionId: 'other' })))
      .rejects
      .toThrow('cannot change the logical session identifier');
  });
});
