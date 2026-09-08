import type { BrokerCredential } from '../src/contract.js';

import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { defineBroker } from '../src/config.js';
import { createFileBrokerIdentityStore, createMemoryBrokerIdentityStore } from '../src/identity-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: vi.fn(original.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { recursive: true, force: true })));
});

function credential(brokerId: string): BrokerCredential {
  return { brokerId, agentId: crypto.randomUUID(), principalId: crypto.randomUUID(), credentialId: crypto.randomUUID(), credential: crypto.getRandomValues(new Uint8Array(32)), status: 'pending' };
}

it('preserves a version-one identity and pairing across adoption and restart', async () => {
  expect.assertions(5);
  const directory = await mkdtemp(join(tmpdir(), 'cdb-identity-'));
  directories.push(directory);
  const stored = credential(crypto.randomUUID());
  const { brokerId, status: _status, credential: secret, ...identity } = stored;
  await writeFile(join(directory, 'identity.json'), JSON.stringify({ version: 1, brokerId, credentials: [{ ...identity, credential: Buffer.from(secret).toString('base64url') }] }));
  const store = await createFileBrokerIdentityStore(directory);
  expect(store.brokerId).toBe(brokerId);
  expect(store.load(stored.credentialId)).toEqual({ ...stored, status: 'active' });
  expect((await stat(join(directory, 'identity.json'))).mode & 0o777).toBe(0o600);
  await store.remove(stored.credentialId);
  expect((await createFileBrokerIdentityStore(directory)).findByAgentId(stored.agentId)).toBeUndefined();
  expect(JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))).toMatchObject({ brokerId, credentials: [] });
});

it('preserves multiple existing credentials for one provider when activating and restarting', async () => {
  expect.assertions(4);
  const directory = await mkdtemp(join(tmpdir(), 'cdb-identity-'));
  directories.push(directory);
  const first = credential(crypto.randomUUID());
  const second = { ...credential(first.brokerId), agentId: first.agentId, principalId: first.principalId };
  await writeFile(join(directory, 'identity.json'), JSON.stringify({
    version: 1,
    brokerId: first.brokerId,
    credentials: [first, second].map(({ brokerId: _brokerId, status: _status, credential: secret, ...identity }) => ({
      ...identity,
      credential: Buffer.from(secret).toString('base64url'),
    })),
  }));
  const store = await createFileBrokerIdentityStore(directory);
  expect(store.load(first.credentialId)).toEqual({ ...first, status: 'active' });
  expect(store.load(second.credentialId)).toEqual({ ...second, status: 'active' });
  await store.activate({ ...second, status: 'active' });
  const restarted = await createFileBrokerIdentityStore(directory);
  expect(restarted.load(first.credentialId)).toEqual({ ...first, status: 'active' });
  expect(restarted.load(second.credentialId)).toEqual({ ...second, status: 'active' });
});

it('keeps credentials uncommitted after a persistence failure and recovers for a later write', async () => {
  expect.assertions(4);
  const directory = await mkdtemp(join(tmpdir(), 'cdb-identity-'));
  directories.push(directory);
  const store = await createFileBrokerIdentityStore(directory);
  const record = credential(store.brokerId);
  vi.spyOn(filesystem, 'rename').mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(store.activate(record)).rejects.toThrow('Storage unavailable');
  expect(store.load(record.credentialId)).toBeUndefined();
  expect((await createFileBrokerIdentityStore(directory)).load(record.credentialId)).toBeUndefined();
  await store.activate(record);
  expect((await createFileBrokerIdentityStore(directory)).load(record.credentialId)).toEqual({ ...record, status: 'active' });
});

it('serializes concurrent pairing without replacing the first committed credential', async () => {
  expect.assertions(3);
  const store = createMemoryBrokerIdentityStore();
  const first = credential(store.brokerId);
  const second = { ...credential(store.brokerId), agentId: first.agentId };
  const results = await Promise.allSettled([store.activate(first), store.activate(second)]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(store.findByAgentId(first.agentId)?.credentialId).toBe(first.credentialId);
  expect(store.load(second.credentialId)).toBeUndefined();
});

it('defines navigation restrictions without constructing a runtime', () => {
  expect.assertions(4);
  const createAutomationProvider = vi.fn();
  const configuration = defineBroker({ navigation: { default: 'same-origin', allowed: ['same-origin'] }, automationProvider: createAutomationProvider });
  expect(configuration.navigation.default).toBe('same-origin');
  expect(createAutomationProvider).not.toHaveBeenCalled();
  expect(() => defineBroker({ navigation: { default: 'follow-tab', allowed: ['same-origin'] } })).toThrow(TypeError);
  expect(() => defineBroker({ timing: { providerRecoveryMilliseconds: -1 } })).toThrow(TypeError);
});
