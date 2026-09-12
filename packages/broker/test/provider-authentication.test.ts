import { createAgentAuthenticationProof, decodeBase64UrlBytes, generateRandomBase64Url, importAgentCredential } from '@dvcol/cdb/authentication';
import { expect, it } from 'vitest';

import { createMemoryBrokerIdentityStore } from '../src/identity-store.js';
import { createProviderAuthentication } from '../src/provider-authentication.js';

it('binds pairing and proofs to their peer and retains the installation identity on reconnect', async () => {
  expect.assertions(6);
  const store = createMemoryBrokerIdentityStore();
  const authentication = createProviderAuthentication(store, 60_000);
  const offer = authentication.invite('first-peer', 'installation');
  const credential = generateRandomBase64Url(32);
  const input = { credentialId: 'credential', clientNonce: generateRandomBase64Url(32), pairing: { code: offer.code, credential } };
  expect(() => authentication.begin('another-peer', 'installation', input)).toThrow('invitation');
  const transcript = authentication.begin('first-peer', 'installation', input);
  const key = await importAgentCredential(decodeBase64UrlBytes(credential));
  const proof = await createAgentAuthenticationProof(key, transcript);
  expect(store.findByAgentId('installation')).toBeUndefined();
  const authenticated = await authentication.authenticate('first-peer', proof);
  expect(authenticated.claims).toEqual({ principalId: 'installation', connectionGeneration: 1 });
  await expect(authentication.authenticate('first-peer', proof)).rejects.toThrow('No current');
  const next = authentication.begin('second-peer', 'installation', { credentialId: input.credentialId, clientNonce: generateRandomBase64Url(32) });
  const reconnected = await authentication.authenticate('second-peer', await createAgentAuthenticationProof(key, next));
  expect(reconnected.claims).toEqual({ principalId: 'installation', connectionGeneration: 2 });
  expect(store.findByAgentId('installation')?.credentialId).toBe(input.credentialId);
  authentication.dispose();
});

it('authenticates either retained pairing for one installation and revokes only the selected credential', async () => {
  expect.assertions(4);
  const store = createMemoryBrokerIdentityStore();
  const authentication = createProviderAuthentication(store, 60_000);
  const credentials = ['first', 'second'].map(credentialId => ({ credentialId, credential: crypto.getRandomValues(new Uint8Array(32)) }));
  for (const credential of credentials) {
    await store.activate({ ...credential, agentId: 'installation', brokerId: store.brokerId, principalId: 'installation', status: 'active' });
    const transcript = authentication.begin(credential.credentialId, 'installation', { credentialId: credential.credentialId, clientNonce: generateRandomBase64Url(32) });
    const proof = await createAgentAuthenticationProof(await importAgentCredential(credential.credential), transcript);
    expect((await authentication.authenticate(credential.credentialId, proof)).claims.principalId).toBe('installation');
  }
  await store.remove('first');
  expect(() => authentication.begin('first', 'installation', { credentialId: 'first', clientNonce: generateRandomBase64Url(32) })).toThrow('not recognized');
  const remaining = credentials[1]!;
  const transcript = authentication.begin('second', 'installation', { credentialId: 'second', clientNonce: generateRandomBase64Url(32) });
  const proof = await createAgentAuthenticationProof(await importAgentCredential(remaining.credential), transcript);
  expect((await authentication.authenticate('second', proof)).claims.connectionGeneration).toBe(3);
  authentication.dispose();
});

it('rejects a stale challenge and a proof after pairing revocation', async () => {
  expect.assertions(2);
  const store = createMemoryBrokerIdentityStore();
  const credential = generateRandomBase64Url(32);
  await store.activate({ agentId: 'installation', brokerId: store.brokerId, credential: decodeBase64UrlBytes(credential), credentialId: 'credential', principalId: 'installation', status: 'pending' });
  const authentication = createProviderAuthentication(store, 60_000);
  const key = await importAgentCredential(decodeBase64UrlBytes(credential));
  const input = { credentialId: 'credential', clientNonce: generateRandomBase64Url(32) };
  const stale = authentication.begin('peer', 'installation', input);
  authentication.begin('peer', 'installation', { ...input, clientNonce: generateRandomBase64Url(32) });
  await expect(authentication.authenticate('peer', await createAgentAuthenticationProof(key, stale))).rejects.toThrow('authentication failed');
  const current = authentication.begin('peer', 'installation', input);
  await store.remove('credential');
  await expect(authentication.authenticate('peer', await createAgentAuthenticationProof(key, current))).rejects.toThrow('revoked');
  authentication.dispose();
});
