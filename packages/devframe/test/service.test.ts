import type { PublishedTarget } from '@dvcol/cdb';
import type { ProviderConnection, StoredBrokerPairing } from '@dvcol/cdb-extension';
import type { DevframeRpcClient } from 'devframe/client';

import type { CdbDevframeService } from '../src/service.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryCredentialStore } from '@dvcol/cdb';
import { defineDevframe } from 'devframe';
import { createDevServer } from 'devframe/adapters/dev';
import { connectDevframe } from 'devframe/client';
import { DEVFRAME_WS_ROUTE } from 'devframe/constants';
import { afterEach, expect, it, vi } from 'vitest';

import { createCdbClient, createCdbClientSession } from '../src/client.js';
import { createCdbService } from '../src/service.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cdb-devframe-test-'));
  cleanups.push(async () => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('DEVFRAME_INSTANCES_DIR', directory);
  let service: CdbDevframeService | undefined;
  const server = await createDevServer(defineDevframe({
    id: 'cdb-public-test',
    name: 'CDB public transport test',
    version: '1.0.0',
    packageName: 'cdb-test',
    description: 'Public CDB shared-RPC regression.',
    homepage: 'https://example.test',
    services: [createCdbService({ broker: { timing: { requestRateLimitMilliseconds: 0 } } })],
    async setup(context) {
      service = context.services.get('@dvcol/cdb-devframe');
      context.rpc.register({ name: 'fixture:echo', type: 'query', handler: (value: string) => value });
      context.rpc.register({ name: 'fixture:browser', type: 'action', handler: async (input: Parameters<CdbDevframeService['invoke']>[1]) => {
        try {
          return { value: await service!.invoke(context.rpc.getCurrentRpcSession()!, input) };
        } catch (error) {
          return { error: { code: error instanceof Error && 'code' in error ? error.code : undefined } };
        }
      } });
    },
  }), {
    host: '127.0.0.1',
    port: 0,
    auth: false,
    mcp: false,
    openBrowser: false,
    onPeerConnect: (connection, session) => service!.onPeerConnect(connection, session),
    onPeerDisconnect: (connection) => {
      void service!.onPeerDisconnect(connection);
    },
  });
  cleanups.push(async () => {
    await server.close();
    await service?.dispose();
  });
  async function connect(): Promise<DevframeRpcClient> {
    vi.stubGlobal('location', new URL(`http://127.0.0.1:${server.port}/`));
    const client = await connectDevframe({ baseURL: `http://127.0.0.1:${server.port}/`, simpleAuth: false, connectionMeta: { backend: 'websocket', websocket: { path: DEVFRAME_WS_ROUTE } } });
    cleanups.push(() => client.close?.());
    await client.ensureTrusted();
    return client;
  }
  return { connect, service: service! };
}

async function publish(connection: ProviderConnection): Promise<PublishedTarget> {
  const target: PublishedTarget = { id: crypto.randomUUID(), generation: 1, type: 'page', scopeId: crypto.randomUUID(), capabilities: { level: 'debug' }, availability: 'available', url: 'https://example.test' };
  await connection.send({ kind: 'request', method: 'agent.hello', requestId: crypto.randomUUID(), protocolVersion: 1, parameters: {
    connectionGeneration: connection.generation,
    protocolVersions: { minimum: 1, maximum: 1 },
    features: [],
    implementation: { instanceId: connection.registration.instanceId, name: connection.registration.name, version: connection.registration.version, role: 'agent' },
    heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
    limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 67_108_864 },
  } });
  await connection.send({ kind: 'notification', method: 'targets.publish', protocolVersion: 1, parameters: { target } });
  await connection.reconcile([target]);
  return target;
}

it('rotates a principal resume credential across peers and starts fresh after its session ends', async () => {
  expect.assertions(9);
  const setup = await fixture();
  const store = createMemoryCredentialStore();
  const session = createCdbClientSession({ credentialKey: 'agent', credentialStore: store, metadata: { workspace: 'fixture' } });
  const first = createCdbClient(await setup.connect());
  await session.connect(first);
  const initial = await store.get('agent');
  const principal = setup.service.broker.snapshot().principals[0]!;
  expect(principal.metadata).toEqual({ workspace: 'fixture' });
  const next = createCdbClient(await setup.connect());
  await store.set('agent', { ...initial!, credential: 'invalid-resume-credential' });
  await expect(session.connect(next)).rejects.toMatchObject({ code: 'SESSION_CREDENTIAL_INVALID' });
  expect((await store.get('agent'))?.credential).toBe('invalid-resume-credential');
  await store.set('agent', initial!);
  await session.connect(next);
  const resumed = await store.get('agent');
  expect(resumed?.logicalSessionId).toBe(initial?.logicalSessionId);
  expect(resumed?.credential).not.toBe(initial?.credential);
  expect(setup.service.broker.snapshot().principals.map(value => value.id)).toEqual([principal.id]);
  await next.terminateSession();
  const replacement = createCdbClient(await setup.connect());
  await session.connect(replacement);
  expect((await store.get('agent'))?.logicalSessionId).not.toBe(initial?.logicalSessionId);
  await session.terminate(replacement);
  expect(await store.get('agent')).toBeUndefined();
  expect(setup.service.broker.snapshot().principals).toEqual([]);
}, 20_000);

it.each(['direct', 'host-catalogue'] as const)('cancels %s browser work over an existing RPC peer while ordinary traffic continues', async (route) => {
  expect.assertions(8);
  const setup = await fixture();
  const providerRpc = await setup.connect();
  const providerClient = createCdbClient(providerRpc);
  const pairings = new Map<string, StoredBrokerPairing>();
  const provider = await providerClient.connectProvider({
    registration: { id: 'fixture-provider', instanceId: crypto.randomUUID(), maximumLevel: 'debug', name: 'Public provider', version: '1.0.0' },
    pairingKey: 'fixture-broker',
    confirmPairing: () => true,
    pairingStore: { load: async key => pairings.get(key), save: async (pairing) => {
      pairings.set(pairing.endpoint, pairing);
    }, remove: async (credentialId) => {
      for (const [key, pairing] of pairings) if (pairing.credentialId === credentialId) pairings.delete(key);
    } },
  });
  const target = await publish(provider);
  const agentRpc = await setup.connect();
  const agent = createCdbClient(agentRpc);
  const access = agent.invoke('browser.request_access', { level: 'interact' });
  await expect.poll(() => setup.service.broker.snapshot().requests.length).toBe(1);
  const { claim } = await provider.claim(setup.service.broker.snapshot().requests[0]!.id);
  await provider.approve(claim, [target]);
  expect(await access).toMatchObject({ target: { targetRef: 't1' } });
  const controller = new AbortController();
  const commandSeen = Promise.withResolvers<void>();
  const cancellationSeen = Promise.withResolvers<void>();
  provider.onMessage((message) => {
    if (message.kind === 'request' && message.method === 'cdp.execute') commandSeen.resolve();
    if (message.kind === 'notification' && message.method === 'cdp.cancel') cancellationSeen.resolve();
  });
  const action = (route === 'direct'
    ? agent.invoke('browser.snapshot', { targetRef: 't1' }, controller.signal)
    : agent.withCancellation(controller.signal, async (operationId) => {
        const result = await agentRpc.scope('fixture').rpc.call('browser', { operationId, name: 'browser.snapshot', arguments: { targetRef: 't1' } }) as { error?: { code: string }; value?: unknown };
        if (result.error !== undefined) throw Object.assign(new Error('Host catalogue reported a browser failure.'), result.error);
        return result.value;
      }))
    .catch(error => error as Error);
  await Promise.race([commandSeen.promise, action.then((result) => {
    throw result;
  })]);
  controller.abort();
  await cancellationSeen.promise;
  expect(await action).toMatchObject({ code: 'MCP_ACTION_CANCELLED' });
  expect(await agentRpc.scope('fixture').rpc.call('echo', 'ordinary traffic')).toBe('ordinary traffic');
  expect(await providerRpc.scope('fixture').rpc.call('echo', 'provider traffic')).toBe('provider traffic');
  expect(setup.service.broker.snapshot().leases).toEqual([]);
  await agent.dispose();
  expect(await agentRpc.scope('fixture').rpc.call('echo', 'after disposal')).toBe('after disposal');
  provider.close();
  expect(await providerRpc.scope('fixture').rpc.call('echo', 'after channel closure')).toBe('after channel closure');
}, 20_000);
