import type { AgentAuthenticationTranscript } from '@dvcol/cdb/authentication';

import type { BrokerCredential, BrokerIdentityStore, ProviderAuthenticationInput, ProviderAuthenticationResult, ProviderPairingOffer } from './contract.js';

import {
  createBrokerAuthenticationProof,
  decodeBase64UrlBytes,
  generateRandomBase64Url,
  importAgentCredential,
  verifyAgentAuthenticationProof,
} from '@dvcol/cdb/authentication';

interface Challenge {
  readonly credential: BrokerCredential;
  readonly transcript: AgentAuthenticationTranscript;
}

export interface ProviderAuthentication {
  authenticate: (peerId: string, proof: string) => Promise<ProviderAuthenticationResult & { readonly credential: BrokerCredential; readonly transcript: AgentAuthenticationTranscript }>;
  begin: (peerId: string, instanceId: string, input: ProviderAuthenticationInput) => AgentAuthenticationTranscript;
  dispose: () => void;
  forget: (peerId: string) => void;
  invite: (peerId: string, instanceId: string) => ProviderPairingOffer;
}

/** Proves installation pairing on an existing host-authenticated transport, bound to its actual peer. */
export function createProviderAuthentication(identityStore: BrokerIdentityStore, pairingLifetimeMilliseconds: number | null): ProviderAuthentication {
  const challenges = new Map<string, Challenge>();
  const invitations = new Map<string, { readonly peerId: string; readonly code: string; readonly expiresAt: number | null }>();
  const generations = new Map<string, number>();
  const attempts = new Map<string, string>();
  let disposed = false;

  function ensureActive(): void {
    if (disposed) throw new Error('Provider authentication has stopped.');
  }

  return {
    async authenticate(peerId, proof) {
      ensureActive();
      const challenge = challenges.get(peerId);
      challenges.delete(peerId);
      if (challenge === undefined) throw new Error('No current provider authentication challenge.');
      const { transcript } = challenge;
      const current = (): void => {
        ensureActive();
        if (attempts.get(peerId) !== transcript.connectionId || Date.parse(transcript.expiresAt) <= Date.now())
          throw new Error('The provider authentication challenge expired or was replaced.');
      };
      current();
      const key = await importAgentCredential(challenge.credential.credential);
      if (!await verifyAgentAuthenticationProof(key, transcript, proof)) throw new Error('Provider authentication failed.');
      current();
      if (challenge.credential.status === 'pending' && identityStore.findByAgentId(challenge.credential.agentId) !== undefined)
        throw new Error('The provider was paired by another connection.');
      if (challenge.credential.status === 'active' && identityStore.load(challenge.credential.credentialId) === undefined)
        throw new Error('The provider pairing was revoked.');
      const credential = challenge.credential.status === 'active'
        ? challenge.credential
        : await identityStore.activate(challenge.credential);
      current();
      const connectionGeneration = (generations.get(credential.principalId) ?? 0) + 1;
      generations.set(credential.principalId, connectionGeneration);
      const claims = { connectionGeneration, principalId: credential.principalId };
      const brokerProof = await createBrokerAuthenticationProof(key, transcript, claims);
      current();
      if (generations.get(credential.principalId) !== connectionGeneration)
        throw new Error('A newer provider connection replaced this authentication.');
      return { claims, credential, proof: brokerProof, transcript };
    },
    begin(peerId, instanceId, input) {
      ensureActive();
      decodeBase64UrlBytes(input.clientNonce);
      let credential = identityStore.load(input.credentialId);
      if (input.pairing !== undefined) {
        const invitation = invitations.get(instanceId);
        if (credential !== undefined || identityStore.findByAgentId(instanceId) !== undefined
          || invitation?.peerId !== peerId || invitation.code !== input.pairing.code
          || (invitation.expiresAt !== null && invitation.expiresAt <= Date.now()))
          throw new Error('The provider pairing invitation is not valid.');
        const bytes = decodeBase64UrlBytes(input.pairing.credential);
        invitations.delete(instanceId);
        credential = { agentId: instanceId, brokerId: identityStore.brokerId, credential: bytes, credentialId: input.credentialId, principalId: instanceId, status: 'pending' };
      }
      if (credential === undefined || credential.agentId !== instanceId || credential.brokerId !== identityStore.brokerId)
        throw new Error('The provider pairing is not recognized.');
      const transcript: AgentAuthenticationTranscript = {
        agentId: instanceId,
        brokerId: identityStore.brokerId,
        clientNonce: input.clientNonce,
        connectionId: crypto.randomUUID(),
        credentialId: credential.credentialId,
        endpointPath: 'cdb:broker',
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
        origin: `peer:${peerId}`,
        protocolVersion: 1,
        serverNonce: generateRandomBase64Url(32),
        transportProtocol: 'chrome-debugger-bridge.rpc.v1',
      };
      challenges.set(peerId, { credential, transcript });
      attempts.set(peerId, transcript.connectionId);
      return structuredClone(transcript);
    },
    dispose() {
      disposed = true;
      challenges.clear();
      invitations.clear();
      attempts.clear();
      generations.clear();
    },
    forget(peerId) {
      challenges.delete(peerId);
      attempts.delete(peerId);
      for (const [instanceId, invitation] of invitations) if (invitation.peerId === peerId) invitations.delete(instanceId);
    },
    invite(peerId, instanceId) {
      ensureActive();
      if (identityStore.findByAgentId(instanceId) !== undefined) throw new Error('Forget the existing provider pairing before replacing it.');
      const invitation = {
        peerId,
        code: generateRandomBase64Url(24),
        expiresAt: pairingLifetimeMilliseconds === null ? null : Date.now() + pairingLifetimeMilliseconds,
      };
      invitations.set(instanceId, invitation);
      return { brokerId: identityStore.brokerId, code: invitation.code, expiresAt: invitation.expiresAt === null ? null : new Date(invitation.expiresAt).toISOString() };
    },
  };
}
