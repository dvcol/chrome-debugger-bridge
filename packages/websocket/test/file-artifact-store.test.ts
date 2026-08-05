import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createFileArtifactStore } from '../src/file-artifact-store.js';

const authority = { ownerId: 'client', targetGeneration: 1, targetId: '10000000-0000-4000-8000-000000000001' };
const futureExpiry = '2030-08-05T00:00:00.000Z';
const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-artifacts-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { force: true, recursive: true })));
});

it('persists opaque, authorized artifacts across a restart', async () => {
  expect.assertions(5);
  const directory = await createDirectory();
  const store = await createFileArtifactStore({ directory, maximumBytes: 8, maximumBytesPerOwner: 6 });
  const descriptor = await store.create({ ...authority, bytes: Uint8Array.from([1, 2]), expiresAt: futureExpiry, mediaType: 'application/octet-stream' });
  expect(descriptor).toMatchObject({ length: 2, mediaType: 'application/octet-stream' });
  expect(descriptor).not.toHaveProperty('path');
  const restartedStore = await createFileArtifactStore({ directory, maximumBytes: 8, maximumBytesPerOwner: 6 });
  expect(restartedStore.read(descriptor.id, authority)).toEqual(Uint8Array.from([1, 2]));
  expect(() => restartedStore.read(descriptor.id, { ...authority, ownerId: 'other' })).toThrow('not available');
  await expect(restartedStore.create({ ...authority, bytes: Uint8Array.from([1, 2, 3, 4, 5]), expiresAt: futureExpiry, mediaType: 'application/octet-stream' })).rejects.toThrow('filesystem limit');
});

it('enforces per-owner reservations and clears them after cancellation', async () => {
  expect.assertions(4);
  const directory = await createDirectory();
  const store = await createFileArtifactStore({ directory, maximumBytes: 6, maximumBytesPerOwner: 3 });
  const firstWriter = store.createWriter({ ...authority, expiresAt: futureExpiry, mediaType: 'text/plain' });
  firstWriter.write(Uint8Array.from([1, 2]));
  const otherWriter = store.createWriter({ ...authority, expiresAt: futureExpiry, mediaType: 'text/plain' });
  expect(() => otherWriter.write(Uint8Array.from([3, 4]))).toThrow('filesystem limit');
  firstWriter.abort();
  otherWriter.write(Uint8Array.from([3, 4, 5]));
  const descriptor = await otherWriter.close();
  expect(store.read(descriptor.id, authority)).toEqual(Uint8Array.from([3, 4, 5]));
  store.release(descriptor.id, authority);
  expect(() => store.read(descriptor.id, authority)).toThrow('not available');
  expect(await readdir(directory)).toEqual([]);
});

it('removes expired, partial, and symlinked artifacts when recovering', async () => {
  expect.assertions(5);
  const directory = await createDirectory();
  let time = Date.parse('2026-08-04T00:00:00.000Z');
  const store = await createFileArtifactStore({ directory, maximumBytes: 8, maximumBytesPerOwner: 8, now: () => time });
  const expired = await store.create({ ...authority, bytes: Uint8Array.from([1]), expiresAt: '2026-08-04T00:00:01.000Z', mediaType: 'text/plain' });
  await writeFile(join(directory, '.interrupted.bin.tmp'), Uint8Array.from([9]));
  await writeFile(join(directory, '20000000-0000-4000-8000-000000000002.bin'), Uint8Array.from([9]));
  await symlink(join(directory, `${expired.id}.bin`), join(directory, '30000000-0000-4000-8000-000000000003.bin'));
  const beforeExpiry = await createFileArtifactStore({ directory, maximumBytes: 8, maximumBytesPerOwner: 8, now: () => time });
  expect(beforeExpiry.read(expired.id, authority)).toEqual(Uint8Array.from([1]));
  expect(await readdir(directory)).not.toContain('.interrupted.bin.tmp');
  expect(await readdir(directory)).not.toContain('20000000-0000-4000-8000-000000000002.bin');
  time += 2_000;
  await beforeExpiry.cleanup();
  expect(() => beforeExpiry.read(expired.id, authority)).toThrow('not available');
  expect(await readdir(directory)).not.toContain(`${expired.id}.bin`);
});

it('never follows a replaced artifact data symlink', async () => {
  expect.assertions(2);
  const directory = await createDirectory();
  const store = await createFileArtifactStore({ directory, maximumBytes: 8, maximumBytesPerOwner: 8 });
  const descriptor = await store.create({ ...authority, bytes: Uint8Array.from([1]), expiresAt: futureExpiry, mediaType: 'text/plain' });
  const dataPath = join(directory, `${descriptor.id}.bin`);
  const outsidePath = join(directory, 'outside.bin');
  await writeFile(outsidePath, Uint8Array.from([9]));
  await rm(dataPath);
  await symlink(outsidePath, dataPath);
  expect(() => store.read(descriptor.id, authority)).toThrow('not available');
  expect(await readdir(directory)).toEqual(['outside.bin']);
});
