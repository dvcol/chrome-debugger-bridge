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
  read: (id: string, authority: ArtifactAuthority) => Uint8Array;
  release: (id: string, authority: ArtifactAuthority) => void;
  revokeTarget: (targetId: string, targetGeneration: number) => void;
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

  return {
    async create(input) {
      if (input.signal?.aborted) throw new Error('The artifact write was cancelled.');
      if (input.bytes.byteLength > maximumBytes - usedBytes) throw new Error('The artifact exceeds the memory limit.');
      if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= now()) throw new Error('The artifact expiry is invalid.');
      const id = crypto.randomUUID();
      const descriptor: ArtifactDescriptor = { digest: await digest(input.bytes), expiresAt: input.expiresAt, id, length: input.bytes.byteLength, mediaType: input.mediaType };
      if (input.signal?.aborted) throw new Error('The artifact write was cancelled.');
      artifacts.set(id, { ...input, bytes: input.bytes.slice(), descriptor });
      usedBytes += input.bytes.byteLength;
      return descriptor;
    },
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
  options: ArtifactAuthority & { readonly expiresAt: string; readonly maximumInlineBytes: number; readonly store: MemoryArtifactStore },
): Promise<InlineOrArtifactResult<Value>> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength <= options.maximumInlineBytes) return value;
  return {
    artifact: await options.store.create({
      bytes,
      expiresAt: options.expiresAt,
      mediaType: 'application/json',
      ownerId: options.ownerId,
      targetGeneration: options.targetGeneration,
      targetId: options.targetId,
    }),
  };
}
