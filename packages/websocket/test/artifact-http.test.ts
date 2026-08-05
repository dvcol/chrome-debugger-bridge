import type { Server } from 'node:http';

import { createServer } from 'node:http';

import { afterEach, expect, it } from 'vitest';

import { defaultArtifactHttpPath, mountAuthenticatedArtifactHttpEndpoint } from '../src/artifact-http.js';
import { createStaticClientAuthenticationAdapter } from '../src/testing.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => new Promise<void>(resolve => server.close(() => resolve()))));
});

it('serves authorized range reads without credentials in the artifact URL', async () => {
  expect.assertions(7);
  const server = createServer();
  servers.push(server);
  mountAuthenticatedArtifactHttpEndpoint({
    authenticate: createStaticClientAuthenticationAdapter('Bearer artifact-token', { id: 'client-1', role: 'client' as const }),
    async originPolicy() {
      return true;
    },
    async readArtifact(artifactId, principal) {
      if (artifactId !== 'opaque artifact' || principal.id !== 'client-1') return undefined;
      return {
        bytes: Uint8Array.from([1, 2, 3]),
        descriptor: { expiresAt: new Date(Date.now() + 60_000).toISOString(), id: artifactId, length: 3, mediaType: 'application/octet-stream' },
      };
    },
    server,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  const endpoint = `http://127.0.0.1:${address.port}${defaultArtifactHttpPath}${encodeURIComponent('opaque artifact')}`;
  expect(new URL(endpoint).username).toBe('');
  expect(new URL(endpoint).search).toBe('');
  const rejected = await fetch(endpoint);
  expect(rejected.status).toBe(401);
  const response = await fetch(endpoint, { headers: { authorization: 'Bearer artifact-token', range: 'bytes=1-2' } });
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe('bytes 1-2/3');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([2, 3]));
  const missing = await fetch(`http://127.0.0.1:${address.port}${defaultArtifactHttpPath}missing`, { headers: { authorization: 'Bearer artifact-token' } });
  expect(missing.status).toBe(404);
});
