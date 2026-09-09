import type { AgentToBrokerMessage, BrokerToAgentMessage, PublishedTarget } from '@dvcol/cdb';

import type { BrokerRuntime } from '../src/runtime.js';

import { createAgentAuthenticationProof, decodeBase64UrlBytes, generateRandomBase64Url, importAgentCredential } from '@dvcol/cdb/authentication';
import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryBrokerIdentityStore } from '../src/identity-store.js';
import { createBroker } from '../src/runtime.js';

const brokers: BrokerRuntime[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map(async broker => broker.dispose()));
});

async function fixture(accessRequestTimeoutMilliseconds = 60_000) {
  const identityStore = createMemoryBrokerIdentityStore();
  const broker = await createBroker({ identityStore, timing: { requestRateLimitMilliseconds: 0, accessRequestTimeoutMilliseconds } });
  brokers.push(broker);
  const peer = { id: 'provider-peer' };
  const registration = { id: 'test-provider', instanceId: crypto.randomUUID(), name: 'Public test provider', version: '1.0.0', maximumLevel: 'debug' as const };
  broker.registerProvider(peer, registration);
  const invitation = broker.createPairingOffer(peer);
  const credential = generateRandomBase64Url(32);
  const transcript = broker.beginProviderAuthentication(peer, { credentialId: 'credential', clientNonce: generateRandomBase64Url(32), pairing: { code: invitation.code, credential } });
  const key = await importAgentCredential(decodeBase64UrlBytes(credential));
  const proof = await createAgentAuthenticationProof(key, transcript);
  const listeners = new Set<(message: AgentToBrokerMessage) => void>();
  const received: BrokerToAgentMessage[] = [];
  const closed = Promise.withResolvers<void>();
  const authenticated = await broker.authenticateProvider(peer, proof, {
    closed: closed.promise,
    close: () => closed.resolve(),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(message) {
      received.push(message);
    },
  });
  const send = (message: AgentToBrokerMessage): void => {
    for (const listener of listeners) listener(message);
  };
  send({ kind: 'request', method: 'agent.hello', protocolVersion: 1, requestId: crypto.randomUUID(), parameters: {
    connectionGeneration: authenticated.claims.connectionGeneration,
    implementation: { instanceId: registration.instanceId, name: registration.name, role: 'agent', version: registration.version },
    protocolVersions: { minimum: 1, maximum: 1 },
    features: [],
    heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
    limits: { maximumArtifactBytes: 16_777_216, maximumInlineResultBytes: 65_536, maximumMessageBytes: 67_108_864 },
  } });
  const target: PublishedTarget = { id: crypto.randomUUID(), generation: 1, scopeId: crypto.randomUUID(), availability: 'available', capabilities: { level: 'debug' }, type: 'page', url: 'https://example.test/start', title: 'Public fixture' };
  send({ kind: 'notification', method: 'targets.publish', protocolVersion: 1, parameters: { target } });
  await broker.reconcileProvider(peer, [target]);
  return { broker, identityStore, peer, received, registration, send, target };
}

async function approve(setup: Awaited<ReturnType<typeof fixture>>, principalId: string, navigation: 'same-origin' | 'follow-tab' = 'same-origin') {
  const waiting = setup.broker.invoke({ id: principalId }, 'browser.request_access', { level: 'interact', navigation });
  const outcome = waiting.then(value => ({ value }), (error: unknown) => ({ error }));
  await expect.poll(() => setup.broker.snapshot().requests.length).toBe(1);
  const request = setup.broker.snapshot().requests[0]!;
  const { claim } = setup.broker.claimRequest(setup.peer, request.id);
  await setup.broker.completeClaim(setup.peer, claim, [setup.target]);
  return { claim, outcome: await outcome, request };
}

describe('composed browser broker', () => {
  it('reports approval expiry separately from rejection and clears the request', async () => {
    expect.assertions(3);
    const setup = await fixture(500);
    const outcome = setup.broker.invoke({ id: 'expired-agent' }, 'browser.request_access', { level: 'interact' })
      .catch((error: unknown) => error);
    await expect.poll(() => setup.broker.snapshot().requests.length).toBe(1);
    expect(await outcome).toMatchObject({ code: 'ACCESS_REQUEST_TIMEOUT', retryable: false });
    expect(setup.broker.snapshot().requests).toEqual([]);
  });

  it('reports explicit rejection without granting access or calling it a timeout', async () => {
    expect.assertions(4);
    const setup = await fixture();
    const outcome = setup.broker.invoke({ id: 'rejected-agent' }, 'browser.request_access', { level: 'interact' })
      .catch((error: unknown) => error);
    await expect.poll(() => setup.broker.snapshot().requests.length).toBe(1);
    const request = setup.broker.snapshot().requests[0]!;
    await setup.broker.revokeScope(request.id);
    expect(await outcome).toMatchObject({ code: 'ACCESS_REQUEST_REJECTED', retryable: false });
    expect(setup.broker.snapshot().requests).toEqual([]);
    expect(await setup.broker.invoke({ id: 'rejected-agent' }, 'browser.list_targets', {})).toEqual([]);
  });

  it('forgets every retained credential for a provider installation', async () => {
    expect.assertions(4);
    const setup = await fixture();
    const credential = setup.identityStore.load('credential')!;
    await setup.identityStore.activate({ ...credential, credentialId: 'another-existing-credential' });
    expect(await setup.broker.disconnectProvider(setup.registration.id, true)).toBe(true);
    expect(setup.identityStore.load('credential')).toBeUndefined();
    expect(setup.identityStore.load('another-existing-credential')).toBeUndefined();
    expect(setup.broker.createPairingOffer(setup.peer).brokerId).toBe(setup.broker.brokerId);
  });

  it('serializes concurrent membership publications for one approved scope', async () => {
    expect.assertions(4);
    const setup = await fixture();
    const approved = await approve(setup, 'member-agent');
    await expect(Promise.all([
      setup.broker.reconcileScope(setup.peer, approved.request.id, [setup.target]),
      setup.broker.reconcileScope(setup.peer, approved.request.id, [setup.target]),
    ])).resolves.toEqual([undefined, undefined]);
    expect(setup.broker.snapshot().grants).toHaveLength(1);
    expect(await setup.broker.invoke({ id: 'member-agent' }, 'browser.list_targets', {})).toMatchObject([{ targetRef: 't1' }]);
  });

  it('isolates principals and rejects replayed approval claims', async () => {
    expect.assertions(6);
    const setup = await fixture();
    const approved = await approve(setup, 'first-agent');
    expect(approved.outcome).toMatchObject({ value: { target: { targetRef: 't1' } } });
    expect(await setup.broker.invoke({ id: 'first-agent' }, 'browser.list_targets', {})).toMatchObject([{ targetRef: 't1' }]);
    expect(await setup.broker.invoke({ id: 'second-agent' }, 'browser.list_targets', {})).toEqual([]);
    await expect(setup.broker.completeClaim(setup.peer, approved.claim, [setup.target])).rejects.toMatchObject({ code: 'GRANT_CLAIM_INVALID' });
    expect(setup.broker.snapshot().grants).toHaveLength(1);
  });

  it('applies navigation policy per principal across generation replacement', async () => {
    expect.assertions(9);
    const setup = await fixture();
    await approve(setup, 'same-origin-agent');
    await approve(setup, 'follow-tab-agent', 'follow-tab');
    const navigated = { ...setup.target, generation: 2, url: 'https://other.test/next' };
    setup.send({ kind: 'notification', method: 'targets.publish', protocolVersion: 1, parameters: { target: navigated } });
    await setup.broker.reconcileProvider(setup.peer, [navigated]);
    expect(setup.broker.snapshot().grants.map(grant => grant.state).sort()).toEqual(['active', 'out-of-scope']);
    await expect(setup.broker.invoke({ id: 'same-origin-agent' }, 'browser.snapshot', { targetRef: 't1' })).rejects.toMatchObject({ code: 'TARGET_OUT_OF_SCOPE' });
    expect(await setup.broker.invoke({ id: 'follow-tab-agent' }, 'browser.list_targets', {})).toMatchObject([{ targetRef: 't1', url: navigated.url }]);
    const firstGrant = setup.broker.snapshot().grants[0]!;
    expect(await setup.broker.revokeGrant(firstGrant.id)).toBe(true);
    expect(setup.broker.snapshot().grants).toHaveLength(1);
    expect(setup.broker.snapshot().scopes).toHaveLength(2);
    await setup.broker.reconcileScope(setup.peer, firstGrant.requestId, [navigated]);
    expect(setup.broker.snapshot().grants).toHaveLength(1);
  });

  it('fences the previous peer on resume and preserves stable target references', async () => {
    expect.assertions(5);
    const setup = await fixture();
    const credential = await setup.broker.connectSession({ id: 'original-peer' });
    await approve(setup, 'original-peer');
    await setup.broker.connectSession({ id: 'resumed-peer' }, { resume: { logicalSessionId: credential.logicalSessionId, credential: credential.resumeCredential } });
    await expect(setup.broker.invoke({ id: 'original-peer' }, 'browser.list_targets', {})).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(await setup.broker.invoke({ id: 'resumed-peer' }, 'browser.list_targets', {})).toMatchObject([{ targetRef: 't1' }]);
    await expect(setup.broker.connectSession({ id: 'replayed-peer' }, { resume: { logicalSessionId: credential.logicalSessionId, credential: credential.resumeCredential } })).rejects.toBeDefined();
    expect(setup.broker.snapshot().principals).toHaveLength(1);
  });

  it('removes only the revoked grant during provider recovery', async () => {
    expect.assertions(6);
    const setup = await fixture();
    await approve(setup, 'first-agent');
    await approve(setup, 'second-agent');
    await setup.broker.disconnectPeer(setup.peer.id);
    expect(setup.broker.snapshot().grants.map(grant => grant.state)).toEqual(['recovering', 'recovering']);
    expect(await setup.broker.revokeGrant(setup.broker.snapshot().grants[0]!.id)).toBe(true);
    expect(setup.broker.snapshot().grants).toHaveLength(1);
    await expect(setup.broker.invoke({ id: 'second-agent' }, 'browser.snapshot', { targetRef: 't1' })).rejects.toMatchObject({ code: 'PROVIDER_RECOVERING' });
  });
});
