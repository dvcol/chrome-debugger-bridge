export interface ArtifactDescriptor {
  readonly digest?: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly length?: number;
  readonly mediaType: string;
}

export interface ArtifactAuthority {
  readonly ownerId: string;
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface MemoryArtifactStore {
  create: (input: ArtifactAuthority & { readonly bytes: Uint8Array; readonly expiresAt: string; readonly mediaType: string; readonly signal?: AbortSignal }) => Promise<ArtifactDescriptor>;
  createWriter: (input: ArtifactAuthority & { readonly expiresAt: string; readonly mediaType: string; readonly signal?: AbortSignal }) => ArtifactWriter;
  read: (id: string, authority: ArtifactAuthority) => Uint8Array;
  release: (id: string, authority: ArtifactAuthority) => void;
  revokeTarget: (targetId: string, targetGeneration: number) => void;
}

export interface ArtifactWriter {
  abort: () => void;
  close: () => Promise<ArtifactDescriptor>;
  write: (bytes: Uint8Array) => void;
}

/** Reads an artifact without exposing its backing-store location or credentials. */
export interface ArtifactReader {
  readonly descriptor: ArtifactDescriptor;
  read: (signal?: AbortSignal) => Promise<Uint8Array>;
}

/** Creates a reusable artifact reader around an authorized byte source. */
export function createArtifactReader(
  descriptor: ArtifactDescriptor,
  read: (signal?: AbortSignal) => Uint8Array | Promise<Uint8Array>,
): ArtifactReader {
  return {
    descriptor,
    async read(signal) {
      if (signal?.aborted) throw new Error('The artifact read was cancelled.');
      const bytes = await read(signal);
      if (signal?.aborted) throw new Error('The artifact read was cancelled.');
      if (descriptor.length !== undefined && bytes.byteLength !== descriptor.length) throw new Error('The artifact length does not match its descriptor.');
      if (descriptor.digest !== undefined && await digest(bytes) !== descriptor.digest) throw new Error('The artifact digest does not match its descriptor.');
      return bytes;
    },
  };
}

export type InlineOrArtifactResult<Value> = Value | { readonly artifact: ArtifactDescriptor };

interface StoredArtifact extends ArtifactAuthority {
  readonly bytes: Uint8Array;
  readonly descriptor: ArtifactDescriptor;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

/** Retains opaque, target-authorized artifacts only in bounded process memory. */
export function createMemoryArtifactStore(maximumBytes: number, now: () => number = Date.now): MemoryArtifactStore {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('The artifact byte limit is invalid.');
  const artifacts = new Map<string, StoredArtifact>();
  let usedBytes = 0;
  let reservedBytes = 0;

  function removeExpiredArtifacts(): void {
    for (const [id, artifact] of artifacts) {
      if (Date.parse(artifact.descriptor.expiresAt) <= now()) {
        artifacts.delete(id);
        usedBytes -= artifact.bytes.byteLength;
      }
    }
  }

  function access(id: string, authority: ArtifactAuthority): StoredArtifact {
    const artifact = artifacts.get(id);
    if (artifact === undefined || artifact.ownerId !== authority.ownerId || artifact.targetId !== authority.targetId || artifact.targetGeneration !== authority.targetGeneration) throw new Error('The artifact is not available.');
    if (Date.parse(artifact.descriptor.expiresAt) <= now()) {
      artifacts.delete(id);
      usedBytes -= artifact.bytes.byteLength;
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
    let closing = false;
    let reservationReleased = false;

    function releaseReservation(): void {
      if (reservationReleased) return;
      reservedBytes -= length;
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
        if (!closing) releaseReservation();
      },
      async close() {
        ensureWritable();
        closed = true;
        closing = true;
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          const id = crypto.randomUUID();
          const descriptor: ArtifactDescriptor = { digest: await digest(bytes), expiresAt: input.expiresAt, id, length: bytes.byteLength, mediaType: input.mediaType };
          if (aborted || input.signal?.aborted) throw new Error('The artifact write was cancelled.');
          artifacts.set(id, { ...input, bytes, descriptor });
          usedBytes += bytes.byteLength;
          return descriptor;
        } finally {
          releaseReservation();
        }
      },
      write(bytes) {
        ensureWritable();
        removeExpiredArtifacts();
        if (bytes.byteLength > maximumBytes - usedBytes - reservedBytes) throw new Error('The artifact exceeds the memory limit.');
        chunks.push(bytes.slice());
        length += bytes.byteLength;
        reservedBytes += bytes.byteLength;
      },
    };
  }

  return {
    async create(input) {
      const writer = createWriter(input);
      writer.write(input.bytes);
      return writer.close();
    },
    createWriter,
    read(id, authority) {
      return access(id, authority).bytes.slice();
    },
    release(id, authority) {
      const artifact = access(id, authority);
      artifacts.delete(id);
      usedBytes -= artifact.bytes.byteLength;
    },
    revokeTarget(targetId, targetGeneration) {
      for (const [id, artifact] of artifacts) {
        if (artifact.targetId === targetId && artifact.targetGeneration === targetGeneration) {
          artifacts.delete(id);
          usedBytes -= artifact.bytes.byteLength;
        }
      }
    },
  };
}

/** Keeps small JSON values inline and externalizes values above the negotiated limit. */
export async function externalizeJsonResult<Value>(
  value: Value,
  options: ArtifactAuthority & { readonly expiresAt: string; readonly forceArtifact?: boolean; readonly maximumInlineBytes: number; readonly signal?: AbortSignal; readonly store: MemoryArtifactStore },
): Promise<InlineOrArtifactResult<Value>> {
  if (!Number.isSafeInteger(options.maximumInlineBytes) || options.maximumInlineBytes < 0) throw new Error('The inline result byte limit is invalid.');
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('The command result is not JSON-safe.');
  const bytes = new TextEncoder().encode(json);
  if (!options.forceArtifact && bytes.byteLength <= options.maximumInlineBytes) return value;
  return {
    artifact: await options.store.create({
      bytes,
      expiresAt: options.expiresAt,
      mediaType: 'application/json',
      ownerId: options.ownerId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      targetGeneration: options.targetGeneration,
      targetId: options.targetId,
    }),
  };
}
