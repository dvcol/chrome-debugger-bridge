import type { ArtifactAccessRequest, ArtifactDescriptor, BrokerToClientMessage, ClientToBrokerMessage, GrantedTargetReference, GrantRequestClaim } from '@dvcol/cdb';
import type { AuthenticatedAgentConnection, AuthenticatedConnection, AuthenticatedPrincipal, ClientAuthenticationAdapter } from '@dvcol/cdb-websocket/node';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';

import {
  artifactDescriptorSchema,
  connectAgentTargetBroker,
  connectStoreBackedClientTargetBroker,
  createGrantRequestCoordinator,
  createLogicalSessionManager,
  createMemoryAuthorityStore,
  createTargetBroker,
} from '@dvcol/cdb';
import { mountAuthenticatedArtifactHttpEndpoint, mountAuthenticatedWebSocketBridge } from '@dvcol/cdb-websocket/node';
import { createMemoryAgentAuthenticationAdapter } from '@dvcol/cdb-websocket/testing';

export interface GrantFlowHostConfiguration {
  readonly agentEndpoint: string;
  readonly brokerId: string;
  readonly controlAuthorization: string;
  readonly controlEndpoint: string;
  readonly pairingCode: string;
  readonly providerInstanceId: string;
}

export interface GrantFlowHost {
  readonly artifactEndpoint: string;
  readonly broker: ReturnType<typeof createTargetBroker>;
  readonly clientAuthorization: string;
  readonly clientEndpoint: string;
  readonly configuration: GrantFlowHostConfiguration;
  readonly coordinator: ReturnType<typeof createGrantRequestCoordinator>;
  readonly endpoint: string;
  close: () => Promise<void>;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a control object.');
  return value as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Expected a control identifier.');
  return value;
}

function requireGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Expected a positive generation.');
  return value;
}

function parseClaim(value: unknown): GrantRequestClaim {
  const claim = requireRecord(value);
  const provider = requireRecord(claim.provider);
  return {
    id: requireString(claim.id),
    requestId: requireString(claim.requestId),
    provider: { principalId: requireString(provider.principalId), connectionGeneration: requireGeneration(provider.connectionGeneration) },
  };
}

function parseTargets(value: unknown): GrantedTargetReference[] {
  if (!Array.isArray(value)) throw new Error('Expected exact control targets.');
  return value.map((candidate: unknown) => {
    const target = requireRecord(candidate);
    return { targetId: requireString(target.targetId), targetGeneration: requireGeneration(target.targetGeneration) };
  });
}

/** An example host control endpoint uses its own bootstrap credential, separate from agent tools and pairing. */
export async function startGrantFlowHost({ port = 0 }: { port?: number } = {}): Promise<GrantFlowHost> {
  const brokerId = randomUUID();
  const providerInstanceId = randomUUID();
  const clientPrincipalId = randomUUID();
  const pairingCode = String(randomInt(1_000_000)).padStart(6, '0');
  const controlAuthorization = `Bearer ${randomBytes(32).toString('base64url')}`;
  const clientAuthorization = `Bearer ${randomBytes(32).toString('base64url')}`;
  const broker = createTargetBroker({ maximumInlineResultBytes: 512_000 });
  const authorityStore = createMemoryAuthorityStore();
  const sessions = createLogicalSessionManager({ authorityStore });
  const requestIds = new Set<string>();
  const cleanupTasks = new Set<Promise<void>>();
  const artifactGrants = new Map<string, { access: ArtifactAccessRequest; descriptor: ArtifactDescriptor; principalId: string }>();
  const clientAuthentication: ClientAuthenticationAdapter<AuthenticatedPrincipal> = {
    async authenticate({ authorization }) {
      return authorization === clientAuthorization ? { id: clientPrincipalId, role: 'client' } : undefined;
    },
  };
  let authenticatedProvider: AuthenticatedAgentConnection<AuthenticatedPrincipal> | undefined;
  const coordinator = createGrantRequestCoordinator({
    authorityStore,
    targetDirectory: {
      getProviderConnectionGeneration(principalId) {
        return authenticatedProvider?.principal.id === principalId ? authenticatedProvider.connectionGeneration : undefined;
      },
      getTarget(targetId) {
        const target = broker.listTargets().find(candidate => candidate.id === targetId);
        const providerPrincipalId = broker.getTargetAgentPrincipalId(targetId);
        return target === undefined || providerPrincipalId === undefined ? undefined : { providerPrincipalId, target };
      },
    },
    timing: { requestTimeoutMilliseconds: 5 * 60_000 },
  });
  async function handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url?.startsWith('/cdb/artifacts/')) return;
    if (request.url === '/' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>CDB approval example</title><h1>CDB approval example</h1><label>Name <input aria-label="Name"></label><button onclick="document.querySelector(\'output\').textContent=\'Saved\'">Save</button><output aria-live="polite"></output><p>Start the Node client, then review its request from the extension toolbar.</p>');
      return;
    }
    if (request.headers.authorization !== controlAuthorization || authenticatedProvider === undefined) {
      response.writeHead(401).end();
      return;
    }
    const provider = {
      connectionGeneration: authenticatedProvider.connectionGeneration,
      principalId: authenticatedProvider.principal.id,
    };
    let result: unknown;
    if (request.method === 'GET' && request.url === '/control/state') {
      result = { requests: [...requestIds].flatMap(requestId => coordinator.getRequest(requestId) ?? []) };
    } else if (request.method === 'POST' && request.url?.startsWith('/control/')) {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 65_536) throw new Error('The control request exceeds its size limit.');
      }
      const input = requireRecord(JSON.parse(body) as unknown);
      switch (request.url) {
        case '/control/claim':
          result = coordinator.claim(requireString(input.requestId), provider);
          break;
        case '/control/complete': {
          const claim = parseClaim(input.claim);
          if (claim.provider.principalId !== provider.principalId || claim.provider.connectionGeneration !== provider.connectionGeneration)
            throw new Error('The claim belongs to another provider connection.');
          result = await coordinator.complete(claim, parseTargets(input.targets));
          break;
        }
        case '/control/reconcile':
          result = await coordinator.reconcile(requireString(input.requestId), provider, parseTargets(input.targets));
          break;
        case '/control/release':
          coordinator.release(parseClaim(input.claim));
          result = { ok: true };
          break;
        case '/control/cancel':
          await coordinator.cancel(requireString(input.requestId));
          result = { ok: true };
          break;
        default:
          response.writeHead(404).end();
          return;
      }
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  }
  const server = createServer((request, response) => {
    void handleControl(request, response).catch((error: unknown) => {
      const details = error instanceof Error ? error : new Error(String(error));
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'code' in details ? details.code : 'CONTROL_FAILED', message: details.message }));
    });
  });
  const bridge = mountAuthenticatedWebSocketBridge({
    agentAuthentication: createMemoryAgentAuthenticationAdapter({
      brokerId,
      pairingCode,
      pairingCodeExpiresAt: Date.now() + 5 * 60_000,
      principal: { id: providerInstanceId, role: 'agent' },
    }),
    brokerId,
    clientAuthentication,
    limits: { maximumMessageBytes: 8 * 1_024 * 1_024 },
    onAgentConnection(connection) {
      authenticatedProvider = connection;
      const disconnect = connectAgentTargetBroker(connection.connection, broker, {
        authority: { connectionGeneration: connection.connectionGeneration, principalId: connection.principal.id },
        connectionGeneration: connection.connectionGeneration,
        connectionLimits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 512_000, maximumMessageBytes: 8_388_608 },
        implementation: { instanceId: brokerId, name: 'cdb-approval-example', role: 'broker', version: '0.0.0' },
      });
      void connection.connection.closed.then(() => {
        disconnect();
        if (authenticatedProvider === connection) authenticatedProvider = undefined;
      });
    },
    onClientConnection({ connection, connectionId, principal }) {
      const setup = (async () => {
        const session = await sessions.create({ connectionId, principalId: principal.id });
        const artifactRequests = new Map<string, Omit<ArtifactAccessRequest, 'artifactId'>>();
        const mediatedConnection: AuthenticatedConnection<ClientToBrokerMessage, BrokerToClientMessage> = {
          ...connection,
          onMessage(listener) {
            return connection.onMessage((message) => {
              if (message.kind === 'request' && message.method === 'cdp.send') {
                const { leaseId, targetGeneration, targetId } = message.parameters;
                artifactRequests.set(message.requestId, { leaseId, targetGeneration, targetId });
              }
              listener(message);
            });
          },
          async send(message) {
            const access = message.kind === 'response' || message.kind === 'error' ? artifactRequests.get(message.requestId) : undefined;
            const artifact = message.kind === 'response' && message.method === 'cdp.send' ? message.result.value.artifact : undefined;
            const validation = artifact === undefined ? undefined : await artifactDescriptorSchema['~standard'].validate(artifact);
            if (validation?.issues !== undefined) throw new Error('The broker returned an invalid artifact descriptor.');
            const descriptor = validation?.value;
            if (access !== undefined && descriptor !== undefined) {
              const { digest, length, ...identity } = descriptor;
              artifactGrants.set(descriptor.id, { access: { ...access, artifactId: descriptor.id }, descriptor: { ...identity, ...(digest === undefined ? {} : { digest }), ...(length === undefined ? {} : { length }) }, principalId: principal.id });
            }
            if (message.kind === 'response' || message.kind === 'error') artifactRequests.delete(message.requestId);
            await connection.send(message);
          },
        };
        const disconnect = await connectStoreBackedClientTargetBroker(mediatedConnection, broker, {
          authorityStore,
          connectionId,
          logicalSessionId: session.logicalSessionId,
        });
        const request = await coordinator.request({
          capabilities: { level: 'interact' },
          logicalSessionId: session.logicalSessionId,
          principalId: principal.id,
        });
        requestIds.add(request.id);
        await connection.closed;
        disconnect();
        await coordinator.cancel(request.id);
        await sessions.terminate(session.logicalSessionId);
      })();
      cleanupTasks.add(setup);
      void setup.catch((error) => {
        console.error(styleText('red', '❌ [grant-example]'), 'Client session failed.', error);
        connection.close();
      }).finally(() => cleanupTasks.delete(setup));
    },
    originPolicy: ({ origin, role }) => role === 'agent' ? origin?.startsWith('chrome-extension://') === true : origin === undefined,
    server,
  });
  coordinator.subscribe(({ requestId, request, error }) => {
    if (request === undefined) requestIds.delete(requestId);
    if (error !== undefined) {
      console.error(styleText('red', '❌ [grant-example]'), error.message);
      void bridge.close().catch(shutdownError => console.error(styleText('red', '❌ [grant-example]'), 'Transport shutdown failed.', shutdownError));
    }
  });

  const artifacts = mountAuthenticatedArtifactHttpEndpoint({
    authenticate: clientAuthentication,
    originPolicy: ({ origin }) => origin === undefined,
    async releaseArtifact(artifactId, principal) {
      const grant = artifactGrants.get(artifactId);
      if (grant?.principalId !== principal.id) return false;
      broker.releaseArtifact(grant.access, { connectionId: `artifact:${principal.id}`, principalId: principal.id });
      artifactGrants.delete(artifactId);
      return true;
    },
    async readArtifact(artifactId, principal) {
      const grant = artifactGrants.get(artifactId);
      if (grant?.principalId !== principal.id) return undefined;
      try {
        return { bytes: broker.readArtifact(grant.access, { connectionId: `artifact:${principal.id}`, principalId: principal.id }), descriptor: grant.descriptor };
      } catch {
        artifactGrants.delete(artifactId);
        return undefined;
      }
    },
    server,
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback TCP address.');
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    artifactEndpoint: `${endpoint}/cdb/artifacts/`,
    broker,
    clientAuthorization,
    clientEndpoint: `${endpoint.replace('http:', 'ws:')}/cdb/client`,
    configuration: {
      agentEndpoint: `${endpoint.replace('http:', 'ws:')}/cdb/agent`,
      brokerId,
      controlAuthorization,
      controlEndpoint: `${endpoint}/control/`,
      pairingCode,
      providerInstanceId,
    } satisfies GrantFlowHostConfiguration,
    coordinator,
    endpoint,
    async close() {
      artifacts.close();
      artifactGrants.clear();
      await bridge.close();
      await Promise.allSettled([...cleanupTasks]);
      await coordinator.dispose();
      sessions.dispose();
      broker.dispose();
      await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    },
  };
}

async function main(): Promise<void> {
  const { buildApprovalExtension } = await import('../extension/build.ts');
  const host = await startGrantFlowHost();
  const extensionDirectory = await buildApprovalExtension({ configuration: host.configuration });
  console.info(styleText('cyan', '🚀 [grant-example]'), 'Load the unpacked extension from', extensionDirectory);
  console.info(styleText('cyan', '🚀 [grant-example]'), 'Open the example page at', host.endpoint);
  console.info(styleText('cyan', '🚀 [grant-example]'), 'Node client endpoint:', host.clientEndpoint);
  console.info(styleText('cyan', '🚀 [grant-example]'), 'Set CDB_EXAMPLE_CLIENT_AUTHORIZATION in the client terminal to:', host.clientAuthorization);
  process.once('SIGINT', () => void host.close().finally(() => process.exit(0)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(styleText('red', '❌ [grant-example]'), error);
    process.exitCode = 1;
  });
}
