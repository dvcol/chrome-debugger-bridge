import type { ArtifactDescriptor } from '@dvcol/chrome-debugger-bridge';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthenticatedPrincipal, ClientAuthenticationAdapter, TransportClaims } from './node.js';

import { createHash } from 'node:crypto';

export const defaultArtifactHttpPath = '/__chrome_debugger_bridge/artifacts/';
const rangePattern = /^bytes=(\d*)-(\d*)$/u;

export interface MountedAuthenticatedArtifactHttpEndpoint {
  close: () => void;
}

function getClaims(request: IncomingMessage, endpointPath: string): TransportClaims {
  const origin = request.headers.origin;
  const host = request.headers.host;
  return {
    endpointPath,
    host: typeof host === 'string' ? host : undefined,
    origin: typeof origin === 'string' ? origin : undefined,
    remoteAddress: request.socket.remoteAddress,
    role: 'client',
    secure: 'encrypted' in request.socket && request.socket.encrypted === true,
  };
}

function send(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, { 'cache-control': 'no-store', 'content-length': '0' });
  response.end();
}

function setCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  if (origin === undefined) return;
  response.setHeader('access-control-allow-headers', 'authorization, range');
  response.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'origin');
}

function parseRange(value: string | undefined, length: number): { readonly end: number; readonly start: number } | undefined {
  if (value === undefined) return undefined;
  const match = rangePattern.exec(value);
  if (match === null) return undefined;
  const start = match[1] === '' ? 0 : Number(match[1]);
  const end = match[2] === '' ? length - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= length) return undefined;
  return { end, start };
}

/** Mounts authenticated, range-capable artifact reads. Authorization stays in headers, never in artifact URLs. */
export function mountAuthenticatedArtifactHttpEndpoint<Principal extends AuthenticatedPrincipal>(input: {
  readonly authenticate: ClientAuthenticationAdapter<Principal>;
  readonly originPolicy: (claims: TransportClaims, signal: AbortSignal) => boolean | Promise<boolean>;
  readonly path?: string;
  readonly readArtifact: (artifactId: string, principal: Principal, signal: AbortSignal) => Promise<{ readonly bytes: Uint8Array; readonly descriptor: ArtifactDescriptor } | undefined>;
  readonly server: import('node:http').Server;
}): MountedAuthenticatedArtifactHttpEndpoint {
  const path = input.path ?? defaultArtifactHttpPath;
  if (!path.startsWith('/') || !path.endsWith('/')) throw new Error('The artifact HTTP path must start and end with a slash.');
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (!url.pathname.startsWith(path)) return;
      if (url.search || url.hash) return send(response, 400);
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') return send(response, 405);
      const encodedArtifactId = url.pathname.slice(path.length);
      if (encodedArtifactId.length === 0 || encodedArtifactId.includes('/')) return send(response, 404);
      let artifactId: string;
      try {
        artifactId = decodeURIComponent(encodedArtifactId);
      } catch {
        return send(response, 404);
      }
      const abortController = new AbortController();
      request.once('aborted', () => abortController.abort());
      const claims = getClaims(request, path);
      if (!await input.originPolicy(claims, abortController.signal)) return send(response, 403);
      setCorsHeaders(response, claims.origin);
      if (request.method === 'OPTIONS') return send(response, 204);
      const authorization = request.headers.authorization;
      const principal = await input.authenticate.authenticate({
        abortSignal: abortController.signal,
        authorization: typeof authorization === 'string' ? authorization : undefined,
        endpointPath: path,
        origin: claims.origin,
        remoteAddress: claims.remoteAddress,
      });
      if (principal === undefined || principal.role !== 'client') return send(response, 401);
      const artifact = await input.readArtifact(artifactId, principal, abortController.signal);
      if (artifact === undefined) return send(response, 404);
      if (artifact.descriptor.digest !== undefined && createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.descriptor.digest) return send(response, 500);
      const range = parseRange(typeof request.headers.range === 'string' ? request.headers.range : undefined, artifact.bytes.byteLength);
      if (request.headers.range !== undefined && range === undefined) {
        response.writeHead(416, { 'content-range': `bytes */${artifact.bytes.byteLength}` });
        return response.end();
      }
      const bytes = range === undefined ? artifact.bytes : artifact.bytes.subarray(range.start, range.end + 1);
      response.writeHead(range === undefined ? 200 : 206, {
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'content-length': String(bytes.byteLength),
        'content-type': artifact.descriptor.mediaType,
        ...(range === undefined ? {} : { 'content-range': `bytes ${range.start}-${range.end}/${artifact.bytes.byteLength}` }),
      });
      if (request.method === 'HEAD') return response.end();
      response.end(bytes);
    })().catch(() => {
      if (!response.headersSent) send(response, 500);
      else response.destroy();
    });
  };
  input.server.on('request', listener);
  return { close: () => input.server.off('request', listener) };
}
