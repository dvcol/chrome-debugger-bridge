import type { BrokerCredential, BrokerIdentityStore } from './contract.js';

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface StoredIdentity {
  readonly version: 1;
  readonly brokerId: string;
  readonly credentials: readonly {
    readonly agentId: string;
    readonly principalId: string;
    readonly credentialId: string;
    readonly credential: string;
  }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIdentity(source: string): StoredIdentity {
  const parsed: unknown = JSON.parse(source);
  if (!record(parsed) || parsed.version !== 1 || typeof parsed.brokerId !== 'string' || !parsed.brokerId || !Array.isArray(parsed.credentials))
    throw new Error('The broker identity has an unsupported shape.');
  const credentialIds = new Set<string>();
  const credentials = parsed.credentials.map((candidate: unknown) => {
    if (!record(candidate) || typeof candidate.agentId !== 'string' || typeof candidate.principalId !== 'string'
      || typeof candidate.credentialId !== 'string' || typeof candidate.credential !== 'string')
      throw new Error('The broker identity contains an invalid credential.');
    const { agentId, principalId, credentialId, credential } = candidate;
    if (!agentId || !principalId || !credentialId || credentialIds.has(credentialId)
      || Buffer.from(credential, 'base64url').byteLength !== 32 || Buffer.from(credential, 'base64url').toString('base64url') !== credential)
      throw new Error('The broker identity contains a duplicate or invalid credential.');
    credentialIds.add(credentialId);
    return { agentId, principalId, credentialId, credential };
  });
  return { version: 1, brokerId: parsed.brokerId, credentials };
}

function createIdentityStore(identity: StoredIdentity, persist: (identity: StoredIdentity) => Promise<void>): BrokerIdentityStore {
  let current = identity;
  let pending = Promise.resolve();
  const load = (credentialId: string): BrokerCredential | undefined => {
    const credential = current.credentials.find(candidate => candidate.credentialId === credentialId);
    return credential === undefined
      ? undefined
      : {
          ...credential,
          brokerId: current.brokerId,
          credential: Uint8Array.from(Buffer.from(credential.credential, 'base64url')),
          status: 'active',
        };
  };
  const update = async (transform: (identity: StoredIdentity) => StoredIdentity): Promise<void> => {
    const operation = pending.then(async () => {
      const next = transform(current);
      await persist(next);
      current = next;
    });
    pending = operation.catch(() => {});
    return operation;
  };
  return {
    brokerId: identity.brokerId,
    async activate(credential) {
      if (credential.brokerId !== identity.brokerId || credential.credential.byteLength !== 32)
        throw new TypeError('The credential does not belong to this broker.');
      await update((previous) => {
        if (credential.status === 'pending' && previous.credentials.some(candidate => candidate.agentId === credential.agentId || candidate.credentialId === credential.credentialId))
          throw new Error('The provider was paired by another connection.');
        return {
          ...previous,
          credentials: [
            ...previous.credentials.filter(candidate => candidate.credentialId !== credential.credentialId),
            { agentId: credential.agentId, principalId: credential.principalId, credentialId: credential.credentialId, credential: Buffer.from(credential.credential).toString('base64url') },
          ],
        };
      });
      return load(credential.credentialId)!;
    },
    findByAgentId(agentId) {
      const credential = current.credentials.find(candidate => candidate.agentId === agentId);
      return credential === undefined ? undefined : load(credential.credentialId);
    },
    load,
    remove: async credentialId => update(previous => ({ ...previous, credentials: previous.credentials.filter(candidate => candidate.credentialId !== credentialId) })),
  };
}

export function createMemoryBrokerIdentityStore(brokerId = randomUUID()): BrokerIdentityStore {
  return createIdentityStore({ version: 1, brokerId, credentials: [] }, async () => {});
}

/** Keeps the version-one identity format; only identity and pairing records survive a restart. */
export async function createFileBrokerIdentityStore(directory: string): Promise<BrokerIdentityStore> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, 'identity.json');
  let identity: StoredIdentity;
  try {
    identity = parseIdentity(await readFile(path, 'utf8'));
  } catch (error) {
    if (!record(error) || error.code !== 'ENOENT')
      throw new Error(`Cannot read broker identity at ${path}; repair it or explicitly rotate the identity.`, { cause: error });
    identity = { version: 1, brokerId: randomUUID(), credentials: [] };
    try {
      await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (creationError) {
      if (!record(creationError) || creationError.code !== 'EEXIST') throw creationError;
      identity = parseIdentity(await readFile(path, 'utf8'));
    }
  }
  await chmod(path, 0o600);
  return createIdentityStore(identity, async (next) => {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!record(error) || error.code !== 'ENOENT') throw error;
      });
    }
  });
}
