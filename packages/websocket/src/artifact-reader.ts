import type { ArtifactDescriptor, ArtifactReader } from '@dvcol/cdb';

import { createArtifactReader } from '@dvcol/cdb';

/** Creates a common artifact reader for an authenticated HTTP endpoint. */
export function createHttpArtifactReader(input: {
  readonly authorization: string;
  readonly descriptor: ArtifactDescriptor;
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
}): ArtifactReader {
  const endpoint = new URL(input.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('The artifact endpoint must not contain credentials, query parameters, or fragments.');
  return createArtifactReader(input.descriptor, async (signal) => {
    const response = await (input.fetch ?? globalThis.fetch)(new URL(encodeURIComponent(input.descriptor.id), endpoint.href), {
      headers: { authorization: input.authorization },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error(`Artifact read failed with HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  });
}
