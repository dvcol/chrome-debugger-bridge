import { createArtifactReader } from '@dvcol/chrome-debugger-bridge';
import { expect, it } from 'vitest';

import {
  createArtifactTransferReceiver,
  decodeArtifactChunk,
  encodeArtifactChunk,
  streamArtifact,
} from '../src/artifacts.js';

async function descriptor(bytes: Uint8Array): Promise<{ readonly digest: string; readonly expiresAt: string; readonly id: string; readonly length: number; readonly mediaType: string }> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return {
    digest: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join(''),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    id: 'artifact-1',
    length: bytes.byteLength,
    mediaType: 'application/octet-stream',
  };
}

it('streams a bounded artifact as ordered binary chunks and exposes a common reader', async () => {
  expect.assertions(4);
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const controls: unknown[] = [];
  const frames: Uint8Array[] = [];
  await streamArtifact({
    async sendBinary(frame) {
      frames.push(frame);
    },
    async sendControl(control) {
      controls.push(control);
    },
  }, createArtifactReader(await descriptor(bytes), () => bytes), 2);
  expect(controls).toHaveLength(2);
  expect(frames).toHaveLength(3);
  const receiver = createArtifactTransferReceiver(5);
  await receiver.acceptControl(controls[0] as never);
  for (const frame of frames) receiver.acceptBinary(frame);
  const reader = await receiver.acceptControl(controls[1] as never);
  expect(await reader?.read()).toEqual(bytes);
  expect(decodeArtifactChunk(frames[0]!).sequence).toBe(0);
});

it('rejects out-of-order, oversized, and digest-mismatched artifact transfer data', async () => {
  expect.assertions(3);
  const bytes = Uint8Array.from([1, 2]);
  const metadata = await descriptor(bytes);
  const receiver = createArtifactTransferReceiver(2);
  await receiver.acceptControl({ artifact: metadata, kind: 'begin' });
  expect(() => receiver.acceptBinary(encodeArtifactChunk(metadata.id, 1, bytes))).toThrow('out of order');
  const oversized = createArtifactTransferReceiver(1);
  await oversized.acceptControl({ artifact: { ...metadata, length: 1 }, kind: 'begin' });
  expect(() => oversized.acceptBinary(encodeArtifactChunk(metadata.id, 0, bytes))).toThrow('byte limit');
  const mismatch = createArtifactTransferReceiver(2);
  await mismatch.acceptControl({ artifact: { ...metadata, digest: '0'.repeat(64) }, kind: 'begin' });
  mismatch.acceptBinary(encodeArtifactChunk(metadata.id, 0, bytes));
  await expect(mismatch.acceptControl({ artifactId: metadata.id, kind: 'complete' })).rejects.toThrow('digest');
});

it('aborts a cancelled sender and removes partial receiver state', async () => {
  expect.assertions(3);
  const bytes = Uint8Array.from([1, 2]);
  const controller = new AbortController();
  controller.abort();
  const controls: { readonly kind: string }[] = [];
  await expect(streamArtifact({
    async sendBinary() {},
    async sendControl(control) {
      controls.push(control);
    },
  }, createArtifactReader(await descriptor(bytes), () => bytes), 1, controller.signal)).rejects.toThrow('cancelled');
  expect(controls.map(control => control.kind)).toEqual(['begin', 'abort']);
  const receiver = createArtifactTransferReceiver(2);
  await receiver.acceptControl({ artifact: await descriptor(bytes), kind: 'begin' });
  await receiver.acceptControl({ artifactId: 'artifact-1', kind: 'abort', reason: 'cancelled' });
  await expect(receiver.acceptControl({ artifactId: 'artifact-1', kind: 'complete' })).rejects.toThrow('not started');
});
