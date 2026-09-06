import type { AuthorityBinding, AuthorityRecord, AuthorityStore } from './authority.js';
import type { AgentAuthority } from './broker.js';
import type { CapabilityGrant, PublishedTarget } from './protocol.js';
import type { TimeoutMilliseconds } from './timing.js';

import { cdpCapabilityLevels, isCdpNameAllowed } from './cdp-catalogue.js';
import { capabilityGrantSchema } from './protocol.js';
import { validateTimeoutMilliseconds } from './timing.js';

export interface GrantedTargetReference {
  readonly targetGeneration: number;
  readonly targetId: string;
}

/** Values are derived from an authenticated provider connection by the embedding host. */
export type GrantRequestProvider = Required<AgentAuthority>;

export interface GrantRequestTargetDirectory {
  getProviderConnectionGeneration: (principalId: string) => number | undefined;
  getTarget: (targetId: string) => {
    readonly providerPrincipalId: string;
    readonly target: PublishedTarget;
  } | undefined;
}

export interface GrantRequestInput {
  readonly bindingExpiresAt?: string | null;
  readonly capabilities: CapabilityGrant;
  readonly expiresAt?: string | null;
  readonly id?: string;
  readonly logicalSessionId: string;
  readonly principalId: string;
  readonly requestedTargetId?: string;
}

export interface GrantRequest extends Omit<GrantRequestInput, 'id'> {
  readonly id: string;
  readonly state: 'claimed' | 'granted' | 'pending';
}

export interface GrantRequestClaim {
  readonly id: string;
  readonly provider: GrantRequestProvider;
  readonly requestId: string;
}

export interface GrantRequestChange {
  readonly error?: GrantRequestError;
  readonly request?: GrantRequest;
  readonly requestId: string;
}

export interface GrantRequestTimingPolicy {
  readonly requestTimeoutMilliseconds: TimeoutMilliseconds;
}

export const defaultGrantRequestTimingPolicy: Readonly<GrantRequestTimingPolicy> = Object.freeze({
  requestTimeoutMilliseconds: 60_000,
});

export interface GrantRequestCoordinator {
  cancel: (requestId: string) => Promise<void>;
  claim: (requestId: string, provider: GrantRequestProvider) => GrantRequestClaim;
  complete: (claim: GrantRequestClaim, targets: readonly GrantedTargetReference[]) => Promise<readonly AuthorityBinding[]>;
  dispose: () => Promise<void>;
  getRequest: (requestId: string) => GrantRequest | undefined;
  reconcile: (requestId: string, provider: GrantRequestProvider, targets: readonly GrantedTargetReference[]) => Promise<readonly AuthorityBinding[]>;
  release: (claim: GrantRequestClaim) => void;
  request: (input: GrantRequestInput) => Promise<GrantRequest>;
  subscribe: (listener: (change: GrantRequestChange) => void) => () => void;
}

export interface CreateGrantRequestCoordinatorOptions {
  readonly authorityStore: AuthorityStore;
  readonly targetDirectory: GrantRequestTargetDirectory;
  readonly timing?: Partial<GrantRequestTimingPolicy>;
}

export class GrantRequestError extends Error {
  constructor(
    readonly code: 'GRANT_AUTHORITY_UNAVAILABLE' | 'GRANT_CLAIM_INVALID' | 'GRANT_COORDINATOR_DISPOSED' | 'GRANT_PROVIDER_FENCED' | 'GRANT_REQUEST_EXPIRED' | 'GRANT_REQUEST_INVALID' | 'GRANT_SESSION_UNAVAILABLE' | 'GRANT_TARGET_DENIED' | 'GRANT_TARGET_UNAVAILABLE',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface StoredGrantRequest {
  readonly bindingIds: Set<string>;
  bindings: readonly AuthorityBinding[];
  cancelled: boolean;
  claim?: GrantRequestClaim;
  completing: boolean;
  operation?: Promise<readonly AuthorityBinding[]>;
  request: GrantRequest;
  timeout?: ReturnType<typeof setTimeout>;
}

/** Coordinates approved requests; hosts authenticate approval and own target-selection policy. */
export function createGrantRequestCoordinator(
  options: CreateGrantRequestCoordinatorOptions,
): GrantRequestCoordinator {
  const requests = new Map<string, StoredGrantRequest>();
  const listeners = new Set<(change: GrantRequestChange) => void>();
  const timing = { ...defaultGrantRequestTimingPolicy, ...options.timing };
  validateTimeoutMilliseconds(timing.requestTimeoutMilliseconds, 'requestTimeoutMilliseconds');
  let disposed = false;

  function notify(requestId: string, error?: GrantRequestError): void {
    const stored = requests.get(requestId);
    const request = stored?.cancelled === true ? undefined : stored?.request;
    const change = {
      ...(error === undefined ? {} : { error }),
      ...(request === undefined ? {} : { request: structuredClone(request) }),
      requestId,
    };
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(change)).catch(() => {});
      } catch {
        /** Observers do not participate in authority transactions. */
      }
    }
  }

  function expiresAt(stored: StoredGrantRequest): string | null | undefined {
    const { bindingExpiresAt, expiresAt: requestExpiresAt, state } = stored.request;
    if (state === 'granted') return bindingExpiresAt;
    if (bindingExpiresAt === undefined || bindingExpiresAt === null) return requestExpiresAt;
    if (requestExpiresAt === undefined || requestExpiresAt === null) return bindingExpiresAt;
    return Date.parse(bindingExpiresAt) < Date.parse(requestExpiresAt) ? bindingExpiresAt : requestExpiresAt;
  }

  function assertUnexpired(stored: StoredGrantRequest): void {
    const expiration = expiresAt(stored);
    if (expiration !== undefined && expiration !== null && Date.parse(expiration) <= Date.now())
      throw new GrantRequestError('GRANT_REQUEST_EXPIRED', 'The grant request or its approved authority expired.');
  }

  function scheduleExpiry(stored: StoredGrantRequest): void {
    if (stored.timeout !== undefined) clearTimeout(stored.timeout);
    delete stored.timeout;
    const expiration = expiresAt(stored);
    if (expiration === undefined || expiration === null) return;
    const deadline = Date.parse(expiration);
    stored.timeout = setTimeout(() => {
      if (deadline > Date.now()) {
        scheduleExpiry(stored);
        return;
      }
      void cancel(stored.request.id).catch(() => notify(stored.request.id, new GrantRequestError('GRANT_AUTHORITY_UNAVAILABLE', 'Expired authority could not be removed from the store.', true)));
    }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
  }

  function ensureActive(): void {
    if (disposed) throw new GrantRequestError('GRANT_COORDINATOR_DISPOSED', 'The grant request coordinator was disposed.');
  }

  function authorityFailure(error: unknown): never {
    if (error instanceof GrantRequestError) throw error;
    throw new GrantRequestError('GRANT_AUTHORITY_UNAVAILABLE', 'The authority store is unavailable.', true);
  }

  function assertSession(record: AuthorityRecord | undefined, request: GrantRequestInput, requireConnected = true): asserts record is AuthorityRecord {
    const resumable = !requireConnected && record?.resumeExpiresAt !== undefined
      && (record.resumeExpiresAt === null || Date.parse(record.resumeExpiresAt) > Date.now());
    if (record === undefined || record.principalId !== request.principalId || (record.activeConnectionId === undefined && !resumable))
      throw new GrantRequestError('GRANT_SESSION_UNAVAILABLE', 'The requesting logical session is no longer available.');
  }

  function assertProvider(provider: GrantRequestProvider): void {
    if (
      !Number.isSafeInteger(provider.connectionGeneration)
      || provider.connectionGeneration < 1
      || options.targetDirectory.getProviderConnectionGeneration(provider.principalId) !== provider.connectionGeneration
    ) throw new GrantRequestError('GRANT_PROVIDER_FENCED', 'The approving provider connection is no longer current.');
  }

  function getClaim(claim: GrantRequestClaim): StoredGrantRequest {
    ensureActive();
    const stored = requests.get(claim.requestId);
    if (
      stored?.request.state !== 'claimed'
      || stored.cancelled
      || stored.completing
      || stored.claim?.id !== claim.id
      || stored.claim.provider.principalId !== claim.provider.principalId
      || stored.claim.provider.connectionGeneration !== claim.provider.connectionGeneration
    ) throw new GrantRequestError('GRANT_CLAIM_INVALID', 'The grant claim is no longer active.');
    assertProvider(stored.claim.provider);
    assertUnexpired(stored);
    return stored;
  }

  async function removeBindings(stored: StoredGrantRequest): Promise<void> {
    await options.authorityStore.update(stored.request.logicalSessionId, record => record === undefined
      ? undefined
      : { ...record, bindings: record.bindings.filter(binding => !stored.bindingIds.has(binding.bindingId)) });
  }

  async function commitTargets(
    stored: StoredGrantRequest,
    provider: GrantRequestProvider,
    targets: readonly GrantedTargetReference[],
  ): Promise<readonly AuthorityBinding[]> {
    stored.completing = true;
    try {
      const targetIds = new Set<string>();
      for (const target of targets) {
        if (target.targetId.length === 0 || !Number.isSafeInteger(target.targetGeneration) || target.targetGeneration < 1 || targetIds.has(target.targetId))
          throw new GrantRequestError('GRANT_REQUEST_INVALID', 'Approval targets require unique identifiers and exact positive generations.');
        targetIds.add(target.targetId);
      }
      const bindings = targets.map(target => stored.bindings.find(binding =>
        binding.targetId === target.targetId && binding.targetGeneration === target.targetGeneration,
      ) ?? {
        ...target,
        bindingId: crypto.randomUUID(),
        capabilities: structuredClone(stored.request.capabilities),
        ...(stored.request.bindingExpiresAt === undefined ? {} : { expiresAt: stored.request.bindingExpiresAt }),
      });
      for (const binding of bindings) stored.bindingIds.add(binding.bindingId);
      await options.authorityStore.update(stored.request.logicalSessionId, (record) => {
        ensureActive();
        assertSession(record, stored.request, stored.request.state !== 'granted');
        assertProvider(provider);
        assertUnexpired(stored);
        if (requests.get(stored.request.id) !== stored || stored.cancelled)
          throw new GrantRequestError('GRANT_CLAIM_INVALID', 'The grant request was cancelled.');
        for (const target of targets) {
          if (stored.request.requestedTargetId !== undefined && stored.request.requestedTargetId !== target.targetId)
            throw new GrantRequestError('GRANT_TARGET_DENIED', 'The approved target does not match the requested target.');
          const published = options.targetDirectory.getTarget(target.targetId);
          if (published?.providerPrincipalId !== provider.principalId || published.target.generation !== target.targetGeneration)
            throw new GrantRequestError('GRANT_TARGET_UNAVAILABLE', 'The approving provider has not published this target generation.', true);
          if (
            cdpCapabilityLevels.indexOf(published.target.capabilities.level ?? 'observe')
            < cdpCapabilityLevels.indexOf(stored.request.capabilities.level ?? 'observe')
            || stored.request.capabilities.allow?.some(method =>
              !isCdpNameAllowed(published.target.capabilities, method, 'command')
              && !isCdpNameAllowed(published.target.capabilities, method, 'event'))
          ) throw new GrantRequestError('GRANT_TARGET_DENIED', 'The target cannot provide the requested capabilities.');
        }
        return { ...record, bindings: [...record.bindings.filter(binding => !stored.bindingIds.has(binding.bindingId)), ...bindings] };
      }).catch(async (error: unknown) => {
        if (error instanceof GrantRequestError) throw error;
        try {
          await removeBindings(stored);
          stored.bindings = [];
          stored.bindingIds.clear();
        } catch {
          stored.cancelled = true;
          if (stored.timeout !== undefined) clearTimeout(stored.timeout);
          notify(stored.request.id, new GrantRequestError('GRANT_AUTHORITY_UNAVAILABLE', 'Uncertain authority could not be removed from the store.', true));
        }
        authorityFailure(error);
      });
      if (requests.get(stored.request.id) !== stored || stored.cancelled)
        throw new GrantRequestError('GRANT_CLAIM_INVALID', 'The grant request was cancelled before completion.');
      stored.bindings = bindings;
      stored.bindingIds.clear();
      for (const binding of bindings) stored.bindingIds.add(binding.bindingId);
      stored.request = { ...stored.request, state: 'granted' };
      scheduleExpiry(stored);
      notify(stored.request.id);
      return structuredClone(bindings);
    } finally {
      stored.completing = false;
      delete stored.operation;
    }
  }

  async function cancel(requestId: string): Promise<void> {
    const stored = requests.get(requestId);
    if (stored === undefined) return;
    if (!stored.cancelled) {
      stored.cancelled = true;
      if (stored.timeout !== undefined) clearTimeout(stored.timeout);
      notify(requestId);
    }
    await stored.operation?.catch(() => undefined);
    if (stored.bindingIds.size > 0) await removeBindings(stored).catch(authorityFailure);
    if (requests.get(requestId) === stored) requests.delete(requestId);
  }

  return {
    cancel,
    claim(requestId, provider) {
      ensureActive();
      assertProvider(provider);
      const stored = requests.get(requestId);
      const claimWasFenced = stored?.claim !== undefined
        && options.targetDirectory.getProviderConnectionGeneration(stored.claim.provider.principalId) !== stored.claim.provider.connectionGeneration;
      if (stored === undefined || stored.cancelled || stored.completing || (stored.request.state !== 'pending' && !(stored.request.state === 'claimed' && claimWasFenced)))
        throw new GrantRequestError('GRANT_CLAIM_INVALID', 'The grant request is not pending.');
      assertUnexpired(stored);
      const claim = { id: crypto.randomUUID(), provider: structuredClone(provider), requestId };
      stored.claim = claim;
      stored.request = { ...stored.request, state: 'claimed' };
      notify(requestId);
      return structuredClone(claim);
    },
    async complete(claim, targets) {
      const stored = getClaim(claim);
      if (targets.length === 0)
        throw new GrantRequestError('GRANT_REQUEST_INVALID', 'An initial approval requires at least one published target.');
      const operation = commitTargets(stored, stored.claim!.provider, structuredClone(targets));
      stored.operation = operation;
      return operation;
    },
    async dispose() {
      disposed = true;
      await Promise.all(Array.from(requests.keys(), cancel));
      listeners.clear();
    },
    getRequest(requestId) {
      const stored = requests.get(requestId);
      return stored === undefined || stored.cancelled ? undefined : structuredClone(stored.request);
    },
    async reconcile(requestId, provider, targets) {
      ensureActive();
      assertProvider(provider);
      const stored = requests.get(requestId);
      if (stored?.request.state !== 'granted' || stored.cancelled || stored.completing || stored.claim?.provider.principalId !== provider.principalId)
        throw new GrantRequestError('GRANT_CLAIM_INVALID', 'This provider does not own an idle approved grant request.');
      assertUnexpired(stored);
      const operation = commitTargets(stored, structuredClone(provider), structuredClone(targets));
      stored.operation = operation;
      return operation;
    },
    release(claim) {
      const stored = getClaim(claim);
      delete stored.claim;
      stored.request = { ...stored.request, state: 'pending' };
      notify(stored.request.id);
    },
    async request(input) {
      ensureActive();
      const requested = structuredClone(input);
      const capabilities = await capabilityGrantSchema['~standard'].validate(requested.capabilities);
      if (capabilities.issues !== undefined)
        throw new GrantRequestError('GRANT_REQUEST_INVALID', 'The requested capabilities are invalid.');
      for (const expiration of [requested.expiresAt, requested.bindingExpiresAt]) {
        if (expiration !== undefined && expiration !== null && !Number.isFinite(Date.parse(expiration)))
          throw new GrantRequestError('GRANT_REQUEST_INVALID', 'Grant request expiration must be an ISO timestamp or null.');
      }
      if (requested.logicalSessionId.length === 0 || requested.principalId.length === 0 || requested.requestedTargetId?.length === 0)
        throw new GrantRequestError('GRANT_REQUEST_INVALID', 'Grant request identities must not be empty.');
      assertSession(await options.authorityStore.get(requested.logicalSessionId).catch(authorityFailure), requested);
      ensureActive();
      const id = requested.id ?? crypto.randomUUID();
      if (id.length === 0 || requests.has(id))
        throw new GrantRequestError('GRANT_REQUEST_INVALID', 'The grant request identifier is empty or already in use.');
      const request: GrantRequest = {
        ...requested,
        expiresAt: requested.expiresAt === undefined
          ? timing.requestTimeoutMilliseconds === null ? null : new Date(Date.now() + timing.requestTimeoutMilliseconds).toISOString()
          : requested.expiresAt,
        id,
        state: 'pending',
      };
      const stored: StoredGrantRequest = { bindingIds: new Set(), bindings: [], cancelled: false, completing: false, request };
      requests.set(id, stored);
      scheduleExpiry(stored);
      notify(id);
      return structuredClone(request);
    },
    subscribe(listener) {
      ensureActive();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
