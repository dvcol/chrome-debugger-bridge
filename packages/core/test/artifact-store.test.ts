import { expect, it } from 'vitest';

import { createMemoryArtifactStore, externalizeJsonResult } from '../src/artifact-store.js';

const authority = { ownerId: 'client', targetGeneration: 1, targetId: '10000000-0000-4000-8000-000000000001' };
const futureExpiry = '2030-08-05T00:00:00.000Z';

it('stores bounded opaque artifacts and enforces owner and target authority', async () => {
  expect.assertions(7);
  const store = createMemoryArtifactStore(4);
  const descriptor = await store.create({ ...authority, bytes: new Uint8Array([1, 2]), expiresAt: futureExpiry, mediaType: 'application/octet-stream' });
  expect(descriptor).toMatchObject({ length: 2, mediaType: 'application/octet-stream' });
  expect(descriptor).not.toHaveProperty('path');
  expect(store.read(descriptor.id, authority)).toEqual(new Uint8Array([1, 2]));
  expect(store.read(descriptor.id, authority, { length: 1, offset: 1 })).toEqual(new Uint8Array([2]));
  expect(() => store.read(descriptor.id, authority, { length: 1, offset: 2 })).toThrow('range is invalid');
  expect(() => store.read(descriptor.id, { ...authority, ownerId: 'other' })).toThrow('not available');
  await expect(store.create({ ...authority, bytes: new Uint8Array([1, 2, 3]), expiresAt: futureExpiry, mediaType: 'application/octet-stream' })).rejects.toThrow('memory limit');
});

it('handles cancellation, expiry, release, and target revocation', async () => {
  expect.assertions(4);
  let time = Date.parse('2026-08-04T00:00:00.000Z');
  const store = createMemoryArtifactStore(8, () => time);
  const controller = new AbortController();
  controller.abort();
  await expect(store.create({ ...authority, bytes: new Uint8Array([1]), expiresAt: '2026-08-05T00:00:00.000Z', mediaType: 'text/plain', signal: controller.signal })).rejects.toThrow('cancelled');
  const expired = await store.create({ ...authority, bytes: new Uint8Array([1]), expiresAt: '2026-08-04T00:00:01.000Z', mediaType: 'text/plain' });
  time += 2_000;
  expect(() => store.read(expired.id, authority)).toThrow('expired');
  const released = await store.create({ ...authority, bytes: new Uint8Array([1]), expiresAt: futureExpiry, mediaType: 'text/plain' });
  store.release(released.id, authority);
  expect(() => store.read(released.id, authority)).toThrow('not available');
  const revoked = await store.create({ ...authority, bytes: new Uint8Array([1]), expiresAt: futureExpiry, mediaType: 'text/plain' });
  store.revokeTarget(authority.targetId, authority.targetGeneration);
  expect(() => store.read(revoked.id, authority)).toThrow('not available');
});

it('keeps negotiated small JSON results inline and externalizes larger or classified values', async () => {
  expect.assertions(5);
  const store = createMemoryArtifactStore(100);
  const options = { ...authority, expiresAt: futureExpiry, maximumInlineBytes: 8, store };
  await expect(externalizeJsonResult({ ok: 1 }, options)).resolves.toEqual({ ok: 1 });
  const result = await externalizeJsonResult({ message: 'large result' }, options);
  expect(result).toHaveProperty('artifact.mediaType', 'application/json');
  expect(result).not.toHaveProperty('artifact.url');
  await expect(externalizeJsonResult({ ok: 1 }, { ...options, forceArtifact: true })).resolves.toHaveProperty('artifact.length');
  await expect(externalizeJsonResult(undefined, options)).rejects.toThrow('JSON-safe');
});

it('writes bounded artifacts in chunks and cleans expired bytes before the next write', async () => {
  expect.assertions(5);
  let time = Date.parse('2026-08-04T00:00:00.000Z');
  const store = createMemoryArtifactStore(4, () => time);
  const writer = store.createWriter({ ...authority, expiresAt: '2026-08-04T00:00:01.000Z', mediaType: 'application/octet-stream' });
  writer.write(new Uint8Array([1]));
  writer.write(new Uint8Array([2]));
  const descriptor = await writer.close();
  expect(store.read(descriptor.id, authority)).toEqual(new Uint8Array([1, 2]));
  const overflowingWriter = store.createWriter({ ...authority, expiresAt: futureExpiry, mediaType: 'application/octet-stream' });
  expect(() => overflowingWriter.write(new Uint8Array([3, 4, 5]))).toThrow('memory limit');
  time += 2_000;
  const replacement = await store.create({ ...authority, bytes: new Uint8Array([3, 4, 5, 6]), expiresAt: futureExpiry, mediaType: 'application/octet-stream' });
  expect(replacement.length).toBe(4);
  expect(() => store.read(descriptor.id, authority)).toThrow('not available');
  const cancelledWriter = store.createWriter({ ...authority, expiresAt: futureExpiry, mediaType: 'application/octet-stream' });
  cancelledWriter.abort();
  expect(() => cancelledWriter.write(new Uint8Array([1]))).toThrow('cancelled');
});
