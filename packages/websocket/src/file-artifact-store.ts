import type { ArtifactAuthority, ArtifactDescriptor, ArtifactWriter, MemoryArtifactStore } from '@dvcol/cdb';

import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface StoredArtifact extends ArtifactAuthority {
  readonly descriptor: ArtifactDescriptor;
}

interface PersistedArtifact extends StoredArtifact {
  readonly version: 1;
}

export interface FileArtifactStore extends MemoryArtifactStore {
  cleanup: () => Promise<void>;
}

export interface FileArtifactStoreOptions {
  /** Directory exclusively owned by this artifact store. */
  readonly directory: string;
  /** Total retained bytes, across all owners. */
  readonly maximumBytes: number;
  /** Retained bytes permitted for one owner. */
  readonly maximumBytesPerOwner: number;
  readonly now?: () => number;
}

function assertLimit(limit: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`The artifact ${label} limit is invalid.`);
}

function artifactPath(directory: string, id: string, extension: 'bin' | 'json'): string {
  return join(directory, `${id}.${extension}`);
}

const artifactIdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[4-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isArtifactIdentifier(value: string): boolean {
  return artifactIdentifierPattern.test(value);
}

function isStoredArtifact(value: unknown): value is PersistedArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const descriptor = record.descriptor;
  return record.version === 1
    && typeof record.ownerId === 'string'
    && typeof record.targetId === 'string'
    && Number.isSafeInteger(record.targetGeneration)
    && typeof descriptor === 'object'
    && descriptor !== null
    && typeof (descriptor as Record<string, unknown>).id === 'string'
    && typeof (descriptor as Record<string, unknown>).expiresAt === 'string'
    && typeof (descriptor as Record<string, unknown>).length === 'number'
    && typeof (descriptor as Record<string, unknown>).mediaType === 'string';
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

/** Opens a crash-safe, filesystem-backed artifact store for Node hosts. */
export async function createFileArtifactStore(options: FileArtifactStoreOptions): Promise<FileArtifactStore> {
  assertLimit(options.maximumBytes, 'byte');
  assertLimit(options.maximumBytesPerOwner, 'per-owner byte');
  const now = options.now ?? Date.now;
  const artifacts = new Map<string, StoredArtifact>();
  const ownerBytes = new Map<string, number>();
  let usedBytes = 0;
  let reservedBytes = 0;
  const reservedByOwner = new Map<string, number>();

  await mkdir(options.directory, { recursive: true });

  function recordUsage(artifact: StoredArtifact, multiplier: 1 | -1): void {
    const length = artifact.descriptor.length;
    if (length === undefined) throw new Error('The persisted artifact is missing its length.');
    usedBytes += multiplier * length;
    const nextOwnerBytes = (ownerBytes.get(artifact.ownerId) ?? 0) + multiplier * length;
    if (nextOwnerBytes === 0) ownerBytes.delete(artifact.ownerId);
    else ownerBytes.set(artifact.ownerId, nextOwnerBytes);
  }

  function unlinkArtifact(id: string): void {
    rmSync(artifactPath(options.directory, id, 'bin'), { force: true });
    rmSync(artifactPath(options.directory, id, 'json'), { force: true });
  }

  function remove(id: string): void {
    const artifact = artifacts.get(id);
    if (artifact === undefined) return;
    artifacts.delete(id);
    recordUsage(artifact, -1);
    unlinkArtifact(id);
  }

  function cleanupSync(): void {
    for (const [id, artifact] of artifacts) {
      if (Date.parse(artifact.descriptor.expiresAt) <= now()) remove(id);
    }
  }

  async function initialize(): Promise<void> {
    const entries = await readdir(options.directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || !entry.name.endsWith('.json')) {
        if (entry.name.startsWith('.')) await rm(join(options.directory, entry.name), { force: true, recursive: true });
        return;
      }
      const id = entry.name.slice(0, -'.json'.length);
      if (!isArtifactIdentifier(id)) return;
      const metadataPath = artifactPath(options.directory, id, 'json');
      const bytesPath = artifactPath(options.directory, id, 'bin');
      try {
        const [metadataSource, bytesInfo] = await Promise.all([readFile(metadataPath, 'utf8'), lstat(bytesPath)]);
        const parsed: unknown = JSON.parse(metadataSource);
        if (!isStoredArtifact(parsed) || parsed.descriptor.id !== id || !bytesInfo.isFile() || bytesInfo.isSymbolicLink() || bytesInfo.size !== parsed.descriptor.length || Date.parse(parsed.descriptor.expiresAt) <= now()) {
          await Promise.all([rm(metadataPath, { force: true }), rm(bytesPath, { force: true })]);
          return;
        }
        artifacts.set(id, parsed);
        recordUsage(parsed, 1);
      } catch {
        await Promise.all([rm(metadataPath, { force: true }), rm(bytesPath, { force: true })]);
      }
    }));
    await Promise.all(entries
      .filter(entry => entry.name.endsWith('.bin'))
      .map(async (entry) => {
        const id = entry.name.slice(0, -'.bin'.length);
        if (!isArtifactIdentifier(id) || !artifacts.has(id)) await rm(join(options.directory, entry.name), { force: true });
      }));
    cleanupSync();
  }

  function access(id: string, authority: ArtifactAuthority): StoredArtifact {
    const artifact = artifacts.get(id);
    if (artifact === undefined || artifact.ownerId !== authority.ownerId || artifact.targetId !== authority.targetId || artifact.targetGeneration !== authority.targetGeneration) throw new Error('The artifact is not available.');
    if (Date.parse(artifact.descriptor.expiresAt) <= now()) {
      remove(id);
      throw new Error('The artifact has expired.');
    }
    return artifact;
  }

  function createWriter(input: ArtifactAuthority & { readonly expiresAt: string; readonly mediaType: string; readonly signal?: AbortSignal }): ArtifactWriter {
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now()) throw new Error('The artifact expiry is invalid.');
    if (input.mediaType.length === 0) throw new Error('The artifact media type is invalid.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    let aborted = false;
    let closed = false;
    let reservationReleased = false;

    function releaseReservation(): void {
      if (reservationReleased) return;
      reservedBytes -= length;
      const nextOwnerBytes = (reservedByOwner.get(input.ownerId) ?? 0) - length;
      if (nextOwnerBytes === 0) reservedByOwner.delete(input.ownerId);
      else reservedByOwner.set(input.ownerId, nextOwnerBytes);
      reservationReleased = true;
    }

    function ensureWritable(): void {
      if (closed || aborted || input.signal?.aborted) throw new Error('The artifact write was cancelled.');
    }

    return {
      abort() {
        aborted = true;
        closed = true;
        chunks.length = 0;
        releaseReservation();
      },
      async close() {
        ensureWritable();
        closed = true;
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const id = randomUUID();
        const descriptor: ArtifactDescriptor = { digest: await digest(bytes), expiresAt: input.expiresAt, id, length: bytes.byteLength, mediaType: input.mediaType };
        const artifact: PersistedArtifact = { ...input, descriptor, version: 1 };
        const dataTemporaryPath = join(options.directory, `.${id}.bin.tmp`);
        const metadataTemporaryPath = join(options.directory, `.${id}.json.tmp`);
        try {
          if (aborted || input.signal?.aborted) throw new Error('The artifact write was cancelled.');
          await writeFile(dataTemporaryPath, bytes, { flag: 'wx' });
          await rename(dataTemporaryPath, artifactPath(options.directory, id, 'bin'));
          await writeFile(metadataTemporaryPath, JSON.stringify(artifact), { encoding: 'utf8', flag: 'wx' });
          await rename(metadataTemporaryPath, artifactPath(options.directory, id, 'json'));
          if (aborted || input.signal?.aborted) {
            unlinkArtifact(id);
            throw new Error('The artifact write was cancelled.');
          }
          artifacts.set(id, artifact);
          recordUsage(artifact, 1);
          return descriptor;
        } finally {
          await Promise.all([rm(dataTemporaryPath, { force: true }), rm(metadataTemporaryPath, { force: true })]);
          releaseReservation();
        }
      },
      write(bytes) {
        ensureWritable();
        cleanupSync();
        const ownerUsedBytes = ownerBytes.get(input.ownerId) ?? 0;
        const ownerReservedBytes = reservedByOwner.get(input.ownerId) ?? 0;
        if (bytes.byteLength > options.maximumBytes - usedBytes - reservedBytes || bytes.byteLength > options.maximumBytesPerOwner - ownerUsedBytes - ownerReservedBytes) throw new Error('The artifact exceeds the filesystem limit.');
        chunks.push(bytes.slice());
        length += bytes.byteLength;
        reservedBytes += bytes.byteLength;
        reservedByOwner.set(input.ownerId, ownerReservedBytes + bytes.byteLength);
      },
    };
  }

  await initialize();
  return {
    async cleanup() {
      cleanupSync();
    },
    async create(input) {
      const writer = createWriter(input);
      writer.write(input.bytes);
      return writer.close();
    },
    createWriter,
    read(id, authority) {
      const artifact = access(id, authority);
      const path = artifactPath(options.directory, id, 'bin');
      const fileInfo = lstatSync(path);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== artifact.descriptor.length) {
        remove(id);
        throw new Error('The artifact is not available.');
      }
      return new Uint8Array(readFileSync(path));
    },
    release(id, authority) {
      access(id, authority);
      remove(id);
    },
    revokeTarget(targetId, targetGeneration) {
      for (const [id, artifact] of artifacts) {
        if (artifact.targetId === targetId && artifact.targetGeneration === targetGeneration) remove(id);
      }
    },
  };
}
