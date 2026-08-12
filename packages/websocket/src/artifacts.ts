import type { ArtifactDescriptor, ArtifactReader } from '@dvcol/cdb';

import { createArtifactReader } from '@dvcol/cdb';

export type ArtifactTransferControl
  = | { readonly artifact: ArtifactDescriptor; readonly kind: 'begin' }
    | { readonly artifactId: string; readonly kind: 'complete' }
    | { readonly artifactId: string; readonly kind: 'abort'; readonly reason: string };

export interface ArtifactTransferSocket {
  sendBinary: (bytes: Uint8Array) => Promise<void>;
  sendControl: (control: ArtifactTransferControl) => Promise<void>;
}

interface PendingArtifact {
  readonly chunks: Uint8Array[];
  readonly descriptor: ArtifactDescriptor;
  nextSequence: number;
  receivedBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

function combine(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Encodes a binary WebSocket artifact chunk with its artifact identity and sequence. */
export function encodeArtifactChunk(artifactId: string, sequence: number, bytes: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('The artifact chunk sequence is invalid.');
  const header = encoder.encode(JSON.stringify({ artifactId, sequence }));
  if (header.byteLength > 65_535) throw new Error('The artifact chunk header is too large.');
  const frame = new Uint8Array(2 + header.byteLength + bytes.byteLength);
  new DataView(frame.buffer).setUint16(0, header.byteLength);
  frame.set(header, 2);
  frame.set(bytes, 2 + header.byteLength);
  return frame;
}

/** Decodes a binary WebSocket artifact chunk. */
export function decodeArtifactChunk(frame: Uint8Array): { readonly artifactId: string; readonly bytes: Uint8Array; readonly sequence: number } {
  if (frame.byteLength < 3) throw new Error('The artifact chunk is truncated.');
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
  if (headerLength === 0 || frame.byteLength < 2 + headerLength) throw new Error('The artifact chunk header is invalid.');
  const header = JSON.parse(decoder.decode(frame.subarray(2, 2 + headerLength))) as unknown;
  if (typeof header !== 'object' || header === null || Array.isArray(header)) throw new Error('The artifact chunk header is invalid.');
  const { artifactId, sequence } = header as { readonly artifactId?: unknown; readonly sequence?: unknown };
  if (typeof artifactId !== 'string' || artifactId.length === 0 || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('The artifact chunk header is invalid.');
  return { artifactId, bytes: frame.subarray(2 + headerLength), sequence };
}

/** Sends a bounded artifact as typed controls plus ordered binary WebSocket frames. */
export async function streamArtifact(socket: ArtifactTransferSocket, reader: ArtifactReader, chunkBytes = 64 * 1_024, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('The artifact chunk size is invalid.');
  const { descriptor } = reader;
  await socket.sendControl({ artifact: descriptor, kind: 'begin' });
  try {
    const bytes = await reader.read(signal);
    for (let offset = 0, sequence = 0; offset < bytes.byteLength; offset += chunkBytes, sequence += 1) {
      if (signal?.aborted) throw new Error('The artifact transfer was cancelled.');
      await socket.sendBinary(encodeArtifactChunk(descriptor.id, sequence, bytes.subarray(offset, offset + chunkBytes)));
    }
    await socket.sendControl({ artifactId: descriptor.id, kind: 'complete' });
  } catch (error) {
    await socket.sendControl({ artifactId: descriptor.id, kind: 'abort', reason: error instanceof Error ? error.message : 'The artifact transfer failed.' }).catch(() => {});
    throw error;
  }
}

/** Receives one or more ordered artifact streams and exposes completed streams as common readers. */
export function createArtifactTransferReceiver(maximumArtifactBytes: number): {
  acceptBinary: (frame: Uint8Array) => void;
  acceptControl: (control: ArtifactTransferControl) => Promise<ArtifactReader | undefined>;
} {
  if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes < 1) throw new Error('The artifact byte limit is invalid.');
  const pending = new Map<string, PendingArtifact>();
  return {
    acceptBinary(frame) {
      const chunk = decodeArtifactChunk(frame);
      const artifact = pending.get(chunk.artifactId);
      if (artifact === undefined || chunk.sequence !== artifact.nextSequence) throw new Error('The artifact chunk is out of order.');
      if (chunk.bytes.byteLength > maximumArtifactBytes - artifact.receivedBytes) {
        pending.delete(chunk.artifactId);
        throw new Error('The artifact exceeds the transfer byte limit.');
      }
      artifact.chunks.push(chunk.bytes.slice());
      artifact.nextSequence += 1;
      artifact.receivedBytes += chunk.bytes.byteLength;
    },
    async acceptControl(control) {
      if (control.kind === 'begin') {
        if (pending.has(control.artifact.id) || (control.artifact.length !== undefined && control.artifact.length > maximumArtifactBytes)) throw new Error('The artifact transfer cannot begin.');
        pending.set(control.artifact.id, { chunks: [], descriptor: control.artifact, nextSequence: 0, receivedBytes: 0 });
        return undefined;
      }
      if (control.kind === 'abort') {
        pending.delete(control.artifactId);
        return undefined;
      }
      const artifact = pending.get(control.artifactId);
      if (artifact === undefined) throw new Error('The artifact transfer was not started.');
      pending.delete(control.artifactId);
      const bytes = combine(artifact.chunks, artifact.receivedBytes);
      if (artifact.descriptor.length !== undefined && bytes.byteLength !== artifact.descriptor.length) throw new Error('The artifact transfer length does not match its descriptor.');
      if (artifact.descriptor.digest !== undefined && await digest(bytes) !== artifact.descriptor.digest) throw new Error('The artifact transfer digest does not match its descriptor.');
      return createArtifactReader(artifact.descriptor, () => bytes.slice());
    },
  };
}
