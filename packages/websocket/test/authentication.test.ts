import type { AgentAuthenticationTranscript, AuthenticatedFrame } from '../src/authentication.js';

import { expect, it } from 'vitest';

import {
  createAgentAuthenticationProof,
  createAuthenticatedFrame,
  createBrokerAuthenticationProof,
  importAgentCredential,
  openAuthenticatedFrame,
  verifyAgentAuthenticationProof,
  verifyBrokerAuthenticationProof,
} from '../src/authentication.js';
import { validateWebSocketEndpointSecurity } from '../src/protocols.js';
import { createMemoryAgentAuthenticationAdapter } from '../src/testing.js';

const transcript: AgentAuthenticationTranscript = {
  agentId: '10000000-0000-4000-8000-000000000001',
  brokerId: '20000000-0000-4000-8000-000000000001',
  clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  connectionId: '30000000-0000-4000-8000-000000000001',
  credentialId: '40000000-0000-4000-8000-000000000001',
  endpointPath: '/__chrome_debugger_bridge/agent',
  expiresAt: '2026-08-03T12:05:00.000Z',
  origin: 'chrome-extension://abcdefghijklmnop',
  protocolVersion: 1,
  serverNonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA',
};

it('binds mutual proofs to their direction and one handshake transcript', async () => {
  expect.assertions(3);
  const credential = await importAgentCredential(new Uint8Array(32).fill(7));
  const agentProof = await createAgentAuthenticationProof(credential, transcript);
  const brokerClaims = {
    connectionGeneration: 1,
    principalId: '50000000-0000-4000-8000-000000000001',
  } as const;

  expect(await verifyAgentAuthenticationProof(credential, transcript, agentProof)).toBe(true);
  expect(await verifyBrokerAuthenticationProof(credential, transcript, brokerClaims, agentProof)).toBe(false);
  expect(await verifyAgentAuthenticationProof(
    credential,
    { ...transcript, connectionId: '30000000-0000-4000-8000-000000000002' },
    agentProof,
  )).toBe(false);
});

it('binds the accepted principal and connection generation into the broker proof', async () => {
  expect.assertions(2);
  const credential = await importAgentCredential(new Uint8Array(32).fill(8));
  const claims = {
    connectionGeneration: 1,
    principalId: '50000000-0000-4000-8000-000000000001',
  } as const;
  const proof = await createBrokerAuthenticationProof(credential, transcript, claims);

  expect(await verifyBrokerAuthenticationProof(credential, transcript, claims, proof)).toBe(true);
  expect(await verifyBrokerAuthenticationProof(credential, transcript, {
    ...claims,
    principalId: '50000000-0000-4000-8000-000000000002',
  }, proof)).toBe(false);
});

it('rejects replayed or modified authenticated frames', async () => {
  expect.assertions(4);
  const credential = await importAgentCredential(new Uint8Array(32).fill(9));
  const frame = await createAuthenticatedFrame(credential, transcript, 'agent-to-broker', 1, { accepted: true });

  await expect(openAuthenticatedFrame(credential, transcript, 'agent-to-broker', 1, frame))
    .resolves
    .toEqual({ accepted: true });
  await expect(openAuthenticatedFrame(credential, transcript, 'agent-to-broker', 2, frame))
    .rejects
    .toThrow('context');
  await expect(openAuthenticatedFrame(credential, transcript, 'agent-to-broker', 1, {
    ...frame,
    payload: JSON.stringify({ accepted: false }),
  } satisfies AuthenticatedFrame)).rejects.toThrow('proof');
  await expect(openAuthenticatedFrame(credential, transcript, 'agent-to-broker', 1, {
    ...frame,
    unexpected: true,
  })).rejects.toThrow('envelope');
});

it('rejects credentials with less than 256 bits of entropy', async () => {
  expect.assertions(1);

  await expect(importAgentCredential(new Uint8Array(31))).rejects.toThrow('32 bytes');
});

it('keeps paired credentials pending until the agent proves possession', async () => {
  expect.assertions(4);
  const brokerId = '20000000-0000-4000-8000-000000000001';
  const principal = { id: '50000000-0000-4000-8000-000000000001', role: 'agent' as const };
  const adapter = createMemoryAgentAuthenticationAdapter({
    brokerId,
    pairingCode: '047204',
    pairingCodeExpiresAt: Date.now() + 300_000,
    principal,
  });
  const pendingRecord = await adapter.pair({
    abortSignal: new AbortController().signal,
    agentId: '10000000-0000-4000-8000-000000000001',
    brokerId,
    credential: new Uint8Array(32).fill(4),
    credentialId: '40000000-0000-4000-8000-000000000001',
    origin: 'chrome-extension://abcdefghijklmnop',
    pairingCode: '047204',
  });
  if (pendingRecord === undefined) {
    throw new Error('Expected the test pairing to reserve a credential');
  }
  const identity = {
    agentId: pendingRecord.agentId,
    brokerId: pendingRecord.brokerId,
    credentialId: pendingRecord.credentialId,
    principalId: pendingRecord.principalId,
  };

  expect(pendingRecord.status).toBe('pending');
  expect(await adapter.authenticate(identity, new AbortController().signal)).toBeUndefined();
  expect((await adapter.activate(pendingRecord, new AbortController().signal))?.status).toBe('active');
  expect(await adapter.authenticate(identity, new AbortController().signal)).toEqual(principal);
});

it('restricts plaintext credentials to WebSocket loopback endpoints', () => {
  expect.assertions(3);

  expect(() => validateWebSocketEndpointSecurity(new URL('http://127.0.0.1:9222/agent')))
    .toThrow('WebSocket protocol');
  expect(() => validateWebSocketEndpointSecurity(new URL('ws://debug.example.com/agent')))
    .toThrow('loopback');
  expect(() => validateWebSocketEndpointSecurity(new URL('wss://debug.example.com/agent')))
    .not
    .toThrow();
});
