import type { PairedAgentCredential, PairedAgentCredentialStore } from './browser.js';
import type {
  AgentAuthenticationAdapter,
  AuthenticatedPrincipal,
  BrokerAgentCredentialRecord,
  ClientAuthenticationAdapter,
} from './node.js';

export interface MemoryAgentAuthenticationOptions<Principal extends AuthenticatedPrincipal> {
  readonly brokerId: string;
  readonly pairingCode: string;
  readonly pairingCodeExpiresAt: number;
  readonly principal: Principal;
}

export interface MemoryAgentAuthenticationAdapter<Principal extends AuthenticatedPrincipal>
  extends AgentAuthenticationAdapter<Principal> {
  readonly records: ReadonlyMap<string, BrokerAgentCredentialRecord>;
}

export function createMemoryAgentAuthenticationAdapter<Principal extends AuthenticatedPrincipal>(
  options: MemoryAgentAuthenticationOptions<Principal>,
): MemoryAgentAuthenticationAdapter<Principal> {
  const records = new Map<string, BrokerAgentCredentialRecord>();
  let failedPairingAttempts = 0;
  let pairingCodeConsumed = false;

  return {
    async activate(record, abortSignal) {
      if (abortSignal.aborted) {
        return undefined;
      }
      const storedRecord = records.get(record.credentialId);
      if (storedRecord?.status !== 'pending') {
        return undefined;
      }
      const activeRecord: BrokerAgentCredentialRecord = { ...storedRecord, status: 'active' };
      records.set(activeRecord.credentialId, activeRecord);
      return activeRecord;
    },
    async authenticate(identity, abortSignal) {
      if (abortSignal.aborted) {
        return undefined;
      }
      const storedRecord = records.get(identity.credentialId);
      if (
        storedRecord?.status !== 'active'
        || storedRecord.agentId !== identity.agentId
        || storedRecord.brokerId !== identity.brokerId
        || storedRecord.principalId !== identity.principalId
        || storedRecord.principalId !== options.principal.id
      ) {
        return undefined;
      }
      return options.principal;
    },
    async load(credentialId, abortSignal) {
      if (abortSignal.aborted) {
        return undefined;
      }
      return records.get(credentialId);
    },
    async pair(input) {
      if (input.abortSignal.aborted) {
        return undefined;
      }
      const pairingAllowed = !pairingCodeConsumed
        && Date.now() <= options.pairingCodeExpiresAt
        && failedPairingAttempts < 5
        && input.brokerId === options.brokerId
        && input.pairingCode === options.pairingCode;
      if (!pairingAllowed) {
        failedPairingAttempts += 1;
        return undefined;
      }
      pairingCodeConsumed = true;
      const record: BrokerAgentCredentialRecord = {
        agentId: input.agentId,
        brokerId: input.brokerId,
        credential: Uint8Array.from(input.credential),
        credentialId: input.credentialId,
        principalId: options.principal.id,
        status: 'pending',
      };
      records.set(record.credentialId, record);
      return record;
    },
    records,
    async revoke(credentialId) {
      records.delete(credentialId);
    },
  };
}

export interface MemoryPairedAgentCredentialStore extends PairedAgentCredentialStore {
  readonly records: ReadonlyMap<string, PairedAgentCredential>;
}

export function createMemoryPairedAgentCredentialStore(): MemoryPairedAgentCredentialStore {
  const records = new Map<string, PairedAgentCredential>();
  return {
    async load(endpoint) {
      return records.get(endpoint);
    },
    records,
    async remove(credentialId) {
      for (const [endpoint, record] of records) {
        if (record.credentialId === credentialId) {
          records.delete(endpoint);
        }
      }
    },
    async save(credential) {
      records.set(credential.endpoint, credential);
    },
  };
}

export function createStaticClientAuthenticationAdapter<Principal extends AuthenticatedPrincipal>(
  authorization: string,
  principal: Principal,
): ClientAuthenticationAdapter<Principal> {
  return {
    async authenticate(input) {
      return input.authorization === authorization ? principal : undefined;
    },
  };
}
