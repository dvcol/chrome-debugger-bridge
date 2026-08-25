import type { ArtifactAuthority, ArtifactByteRange, InlineOrArtifactResult, MemoryArtifactStore } from './artifact-store.js';
import type { TargetChange, TargetRevocationReason } from './client.js';
import type { DiagnosticCode, DiagnosticTraceStore } from './diagnostic-trace.js';
import type { BridgeErrorCode, CapabilityGrant, CdpCommand, CdpEvent, CdpSubscriptionRequest, JsonObject, JsonValue, Lease, PublishedTarget } from './protocol.js';

import { createMemoryArtifactStore, externalizeJsonResult } from './artifact-store.js';
import { isCdpNameAllowed, isKnownCdpEventName, requiredLeaseMode } from './cdp-authorization.js';

type TargetChangeInput
  = | { readonly kind: 'published'; readonly target: PublishedTarget }
    | { readonly kind: 'revoked'; readonly reason: TargetRevocationReason; readonly targetGeneration: number; readonly targetId: string }
    | { readonly kind: 'snapshot'; readonly targets: readonly PublishedTarget[] }
    | { readonly kind: 'updated'; readonly target: PublishedTarget };

const statefulSubscriptionDomains = new Set(['Fetch', 'Performance', 'Profiler', 'Tracing']);

export interface AcquireLeaseRequest {
  readonly durationMilliseconds: number;
  readonly mode?: Lease['mode'];
  readonly requestedMethods: readonly string[];
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface RenewLeaseRequest {
  readonly durationMilliseconds: number;
  readonly leaseId: string;
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface ReleaseLeaseRequest {
  readonly leaseId: string;
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface ArtifactAccessRequest {
  readonly artifactId: string;
  readonly leaseId: string;
  readonly range?: ArtifactByteRange;
  readonly targetGeneration: number;
  readonly targetId: string;
}

/** Authenticated caller identity. Principal ownership survives a transport reconnect; connection ownership does not. */
export interface ClientTargetGrant {
  readonly capabilities: CapabilityGrant;
  readonly targetId: string;
}

export interface ClientAuthority {
  readonly connectionId: string;
  /** Human-facing diagnostic label. It is never used for authorization. */
  readonly displayName?: string;
  readonly principalId: string;
  /** Omitted for a trusted in-process caller. An empty list authorizes no target. */
  readonly targetGrants?: readonly ClientTargetGrant[];
}

const localClientAuthority: ClientAuthority = { connectionId: 'local', principalId: 'local' };

export interface AgentAuthority {
  readonly principalId: string;
}

const localAgentAuthority: AgentAuthority = { principalId: 'local-agent' };

export interface TargetCommandExecutor {
  execute: (command: CdpCommand, abortSignal: AbortSignal, lease: Lease) => Promise<JsonObject>;
  setSubscriptionDemand?: (methodPrefix: string, active: boolean, sessionId?: string) => Promise<void>;
}

export interface CdpSubscription extends AsyncIterable<CdpEvent> {
  readonly droppedCount: number;
  readonly id: string;
  readonly lastDeliveredSequence: number;
  readonly overflowed: boolean;
  readonly targetGeneration: number;
  readonly targetId: string;
  close: () => void;
}

interface SubscriptionState {
  close: () => void;
  readonly authorizedMethods: ReadonlySet<string>;
  readonly demand: string;
  offer: (method: string, parameters: JsonObject, sessionId?: string) => void;
  request: CdpSubscriptionRequest;
  sequence: number;
}

export class TargetBrokerError extends Error {
  constructor(
    readonly code: Extract<BridgeErrorCode, 'CAPABILITY_DENIED' | 'CDP_COMMAND_FAILED' | 'LEASE_CONFLICT' | 'LEASE_EXPIRED' | 'LEASE_REQUIRED' | 'REQUEST_CANCELLED' | 'TARGET_GENERATION_STALE' | 'TARGET_NOT_FOUND'>,
    readonly options: { readonly details?: JsonObject; readonly message?: string; readonly retryAfterMs?: number; readonly retryable?: boolean } = {},
  ) {
    super(options.message ?? (code === 'CDP_COMMAND_FAILED' ? 'The debugger command failed.' : 'The requested target operation is not available.'));
  }

  get details(): JsonObject | undefined {
    return this.options.details;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }

  get retryable(): boolean {
    return this.options.retryable ?? this.code === 'LEASE_CONFLICT';
  }
}

export interface CreateTargetBrokerOptions {
  readonly artifactLifetimeMilliseconds?: number;
  readonly artifactStore?: MemoryArtifactStore;
  readonly commandTimeoutMilliseconds?: number;
  readonly diagnostics?: DiagnosticTraceStore;
  readonly maximumArtifactBytes?: number;
  readonly maximumInlineResultBytes?: number;
  readonly maximumLeaseMilliseconds?: number;
  /** Generates opaque protocol identifiers; hosts may supply their own secure identifier adapter. */
  readonly generateId?: () => string;
  readonly now?: () => number;
  /** Retains a principal's leases after its final connection closes; zero releases them immediately. */
  readonly reconnectGraceMilliseconds?: number;
}

export interface TargetBroker {
  acquireLease: (request: AcquireLeaseRequest, authority?: ClientAuthority) => Lease;
  cancelCommand: (operationId: string, authority?: ClientAuthority) => void;
  connectClient: (authority: ClientAuthority) => void;
  disconnectClient: (authority: ClientAuthority) => void;
  /** Stops all broker work and releases broker-owned resources. */
  dispose: () => void;
  executeCommand: (command: CdpCommand, authority?: ClientAuthority) => Promise<{ readonly operationId: string; readonly value: InlineOrArtifactResult<JsonObject> }>;
  getTargetAgentPrincipalId: (targetId: string) => string | undefined;
  listTargets: (authority?: ClientAuthority) => readonly PublishedTarget[];
  publishTarget: (target: PublishedTarget, authority?: AgentAuthority) => void;
  registerTargetExecutor: (target: Pick<PublishedTarget, 'generation' | 'id'>, executor: TargetCommandExecutor, authority?: AgentAuthority) => void;
  reconcileTargets: (targets: readonly PublishedTarget[], authority?: AgentAuthority) => void;
  revokeAgentTargets: (authority: AgentAuthority, reason?: TargetRevocationReason) => void;
  revokeTarget: (targetId: string, generation: number, reason?: TargetRevocationReason, authority?: AgentAuthority) => void;
  updateTarget: (target: PublishedTarget, authority?: AgentAuthority) => void;
  watchTargets: (authority?: ClientAuthority) => AsyncIterable<TargetChange>;
  publishEvent: (target: Pick<PublishedTarget, 'generation' | 'id'>, method: string, parameters: JsonObject, sessionId?: string) => void;
  releaseLease: (request: ReleaseLeaseRequest, authority?: ClientAuthority) => void;
  readArtifact: (request: ArtifactAccessRequest, authority?: ClientAuthority) => Uint8Array;
  releaseArtifact: (request: ArtifactAccessRequest, authority?: ClientAuthority) => void;
  renewLease: (request: RenewLeaseRequest, authority?: ClientAuthority) => Lease;
  subscribe: (request: CdpSubscriptionRequest, authority?: ClientAuthority) => Promise<CdpSubscription>;
}

/** Stores only opaque target records received from an authenticated extension agent. */
export function createTargetBroker(options: CreateTargetBrokerOptions = {}): TargetBroker {
  const artifactLifetimeMilliseconds = options.artifactLifetimeMilliseconds ?? 60_000;
  const commandTimeoutMilliseconds = options.commandTimeoutMilliseconds ?? 30_000;
  const maximumArtifactBytes = options.maximumArtifactBytes ?? 16_777_216;
  const maximumInlineResultBytes = options.maximumInlineResultBytes ?? 65_536;
  const maximumLeaseMilliseconds = options.maximumLeaseMilliseconds ?? 60_000;
  const reconnectGraceMilliseconds = options.reconnectGraceMilliseconds ?? 5_000;
  const generateId = options.generateId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? Date.now;
  const artifactStore = options.artifactStore ?? createMemoryArtifactStore(maximumArtifactBytes, now);
  const targetsById = new Map<string, PublishedTarget>();
  const targetAgentPrincipalIdsById = new Map<string, string>();
  const highestGenerationByTargetId = new Map<string, number>();
  const leasesById = new Map<string, Lease>();
  const leasePrincipalIdsById = new Map<string, string>();
  const leaseExpiryTimeoutsById = new Map<string, ReturnType<typeof setTimeout>>();
  const executorsByTargetKey = new Map<string, TargetCommandExecutor>();
  const cancellationsByOperationId = new Map<string, { readonly abortController: AbortController; readonly connectionId: string }>();
  const commandOperationIdsByTargetKey = new Map<string, Set<string>>();
  const subscriptionDemandCountsByKey = new Map<string, number>();
  const subscriptions = new Map<string, SubscriptionState>();
  const subscriptionConnectionIdsById = new Map<string, string>();
  const connectedPrincipalIdsByConnectionId = new Map<string, string>();
  const reconnectGraceTimeoutsByPrincipalId = new Map<string, ReturnType<typeof setTimeout>>();
  const targetWatchers = new Set<{ close: () => void; offer: (change: TargetChange) => void }>();
  let disposed = false;
  let targetChangeSequence = 0;

  function ensureActive(): void {
    if (disposed) throw new Error('The target broker is disposed.');
  }

  function recordDiagnostic(code: DiagnosticCode): void {
    options.diagnostics?.record(code);
  }

  function publishTargetChange(change: TargetChangeInput): void {
    const sequencedChange = { ...change, sequence: ++targetChangeSequence } as TargetChange;
    for (const watcher of targetWatchers) watcher.offer(sequencedChange);
  }

  function getTargetKey(targetId: string, generation: number): string {
    return `${targetId}:${generation}`;
  }

  function getCurrentTarget(targetId: string, generation: number): PublishedTarget {
    const target = targetsById.get(targetId);
    if (target === undefined) {
      recordDiagnostic('TARGET_NOT_FOUND');
      throw new TargetBrokerError('TARGET_NOT_FOUND');
    }
    if (target.generation !== generation) {
      recordDiagnostic('TARGET_GENERATION_STALE');
      throw new TargetBrokerError('TARGET_GENERATION_STALE');
    }
    return target;
  }

  function minimumCapabilityLevel(left: CapabilityGrant['level'], right: CapabilityGrant['level']): NonNullable<CapabilityGrant['level']> {
    const levels = ['observe', 'inspect', 'interact', 'debug', 'unsafe'] as const;
    const leftIndex = levels.indexOf(left ?? 'observe');
    const rightIndex = levels.indexOf(right ?? 'observe');
    return levels[Math.min(leftIndex, rightIndex)]!;
  }

  function intersectCapabilities(targetCapabilities: CapabilityGrant, grantedCapabilities: CapabilityGrant): CapabilityGrant {
    const targetAllowed = new Set(targetCapabilities.allow ?? []);
    const allow = (grantedCapabilities.allow ?? []).filter(method => targetAllowed.has(method));
    return {
      level: minimumCapabilityLevel(targetCapabilities.level, grantedCapabilities.level),
      ...(allow.length === 0 ? {} : { allow }),
    };
  }

  function getAuthorizedTarget(targetId: string, generation: number, authority: ClientAuthority): PublishedTarget {
    const target = getCurrentTarget(targetId, generation);
    if (authority.targetGrants === undefined) return target;
    const grant = authority.targetGrants.find(candidate => candidate.targetId === targetId);
    if (grant === undefined) {
      recordDiagnostic('CAPABILITY_DENIED');
      throw new TargetBrokerError('CAPABILITY_DENIED');
    }
    return { ...target, capabilities: intersectCapabilities(target.capabilities, grant.capabilities) };
  }

  function assertAgentOwnsTarget(targetId: string, authority: AgentAuthority): void {
    const ownerPrincipalId = targetAgentPrincipalIdsById.get(targetId);
    if (ownerPrincipalId !== undefined && ownerPrincipalId !== authority.principalId) {
      recordDiagnostic('CAPABILITY_DENIED');
      throw new TargetBrokerError('CAPABILITY_DENIED');
    }
  }

  function eventMatchesSubscription(request: CdpSubscriptionRequest, method: string, parameters: JsonObject, sessionId: string | undefined): boolean {
    const matches = 'domain' in request.match
      ? method.startsWith(`${request.match.domain}.`)
      : 'method' in request.match
        ? method === request.match.method
        : method.startsWith(request.match.methodPrefix);
    if (!matches || (request.sessionId !== undefined && request.sessionId !== sessionId)) return false;
    if (request.predicate === undefined) return true;
    let value: JsonValue | undefined = parameters;
    for (const segment of request.predicate.path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      value = value[segment];
    }
    return JSON.stringify(value) === JSON.stringify(request.predicate.equals);
  }

  function getSubscriptionDemand(request: CdpSubscriptionRequest): string {
    if ('method' in request.match) return request.match.method;
    if ('domain' in request.match) return `${request.match.domain}.`;
    return request.match.methodPrefix;
  }

  function getAuthorizedSubscriptionMethods(request: CdpSubscriptionRequest, lease: Lease, target: PublishedTarget): ReadonlySet<string> {
    const matches = (method: string): boolean => 'method' in request.match
      ? method === request.match.method
      : 'domain' in request.match
        ? method.startsWith(`${request.match.domain}.`)
        : method.startsWith(request.match.methodPrefix);
    const methods = lease.methods.filter(method => matches(method) && isCdpNameAllowed(target.capabilities, method, 'event') && (lease.mode !== 'shared-read' || requiredLeaseMode(target.capabilities, [method]) !== 'exclusive-control') && ('method' in request.match || isKnownCdpEventName(method)));
    if (methods.length === 0) throw new TargetBrokerError('CAPABILITY_DENIED');
    return new Set(methods);
  }

  function getSubscriptionDemandKey(target: Pick<PublishedTarget, 'generation' | 'id'>, request: CdpSubscriptionRequest, demand: string): string {
    return `${getTargetKey(target.id, target.generation)}:${request.sessionId ?? 'root'}:${demand}`;
  }

  function hasStatefulSubscriptionDemand(demand: string): boolean {
    return statefulSubscriptionDomains.has(demand.split('.', 1)[0] ?? '');
  }

  async function incrementSubscriptionDemand(target: PublishedTarget, request: CdpSubscriptionRequest, demand: string): Promise<void> {
    const demandKey = getSubscriptionDemandKey(target, request, demand);
    const count = subscriptionDemandCountsByKey.get(demandKey) ?? 0;
    subscriptionDemandCountsByKey.set(demandKey, count + 1);
    if (count !== 0) return;
    const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
    try {
      if (request.sessionId === undefined) await executor?.setSubscriptionDemand?.(demand, true);
      else await executor?.setSubscriptionDemand?.(demand, true, request.sessionId);
    } catch (error) {
      subscriptionDemandCountsByKey.delete(demandKey);
      throw new TargetBrokerError('CDP_COMMAND_FAILED', {
        ...(error instanceof Error ? { message: error.message } : {}),
      });
    }
  }

  function decrementSubscriptionDemand(target: PublishedTarget, request: CdpSubscriptionRequest, demand: string): void {
    const demandKey = getSubscriptionDemandKey(target, request, demand);
    const count = subscriptionDemandCountsByKey.get(demandKey) ?? 0;
    if (count <= 1) {
      subscriptionDemandCountsByKey.delete(demandKey);
      const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
      const setup = request.sessionId === undefined
        ? executor?.setSubscriptionDemand?.(demand, false)
        : executor?.setSubscriptionDemand?.(demand, false, request.sessionId);
      void setup?.catch(() => {});
    } else subscriptionDemandCountsByKey.set(demandKey, count - 1);
  }

  function deleteLease(leaseId: string): void {
    const expiryTimeout = leaseExpiryTimeoutsById.get(leaseId);
    if (expiryTimeout !== undefined) clearTimeout(expiryTimeout);
    leaseExpiryTimeoutsById.delete(leaseId);
    leasesById.delete(leaseId);
    leasePrincipalIdsById.delete(leaseId);
  }

  function scheduleLeaseExpiry(lease: Lease): void {
    const timeout = setTimeout(() => {
      if (leasesById.get(lease.id)?.expiresAt !== lease.expiresAt) return;
      deleteLease(lease.id);
      closeSubscriptionsUsingLease(lease.id);
    }, Math.max(0, Date.parse(lease.expiresAt) - now()));
    leaseExpiryTimeoutsById.set(lease.id, timeout);
  }

  function removeExpiredLeases(): void {
    for (const [leaseId, lease] of leasesById) if (Date.parse(lease.expiresAt) <= now()) deleteLease(leaseId);
  }

  function getActiveLease(request: Pick<RenewLeaseRequest, 'leaseId' | 'targetGeneration' | 'targetId'>, authority: ClientAuthority): Lease {
    const lease = leasesById.get(request.leaseId);
    if (lease === undefined || leasePrincipalIdsById.get(request.leaseId) !== authority.principalId || lease.targetId !== request.targetId || lease.targetGeneration !== request.targetGeneration) throw new TargetBrokerError('LEASE_REQUIRED');
    if (Date.parse(lease.expiresAt) <= now()) {
      deleteLease(lease.id);
      closeSubscriptionsUsingLease(lease.id);
      throw new TargetBrokerError('LEASE_EXPIRED');
    }
    return lease;
  }

  function getArtifactAuthority(request: ArtifactAccessRequest, authority: ClientAuthority): ArtifactAuthority {
    getAuthorizedTarget(request.targetId, request.targetGeneration, authority);
    const lease = getActiveLease(request, authority);
    return { ownerId: lease.id, targetGeneration: request.targetGeneration, targetId: request.targetId };
  }

  function closeSubscriptionsUsingLease(leaseId: string): void {
    for (const subscription of subscriptions.values()) if (subscription.request.leaseId === leaseId) subscription.close();
  }

  let targetBroker: TargetBroker;
  return targetBroker = {
    acquireLease(request, authority = localClientAuthority) {
      ensureActive();
      const target = getAuthorizedTarget(request.targetId, request.targetGeneration, authority);
      const mode = request.mode ?? 'shared-read';
      if (
        !Number.isSafeInteger(request.durationMilliseconds)
        || request.durationMilliseconds < 1
        || request.durationMilliseconds > maximumLeaseMilliseconds
        || request.requestedMethods.some(method => !isCdpNameAllowed(target.capabilities, method, 'command') && !isCdpNameAllowed(target.capabilities, method, 'event'))
      ) {
        recordDiagnostic('CAPABILITY_DENIED');
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      removeExpiredLeases();
      if (mode === 'shared-read' && requiredLeaseMode(target.capabilities, request.requestedMethods) === 'exclusive-control') {
        recordDiagnostic('CAPABILITY_DENIED');
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      const conflictingLease = mode === 'exclusive-control'
        ? [...leasesById.values()].find(lease => lease.targetId === target.id && lease.targetGeneration === target.generation && lease.mode === 'exclusive-control')
        : undefined;
      if (conflictingLease !== undefined) {
        recordDiagnostic('LEASE_CONFLICT');
        const controllerPrincipalId = leasePrincipalIdsById.get(conflictingLease.id);
        const retryAfterMs = Math.max(0, Date.parse(conflictingLease.expiresAt) - now());
        throw new TargetBrokerError('LEASE_CONFLICT', {
          details: {
            controller: controllerPrincipalId ?? 'unknown',
            expiresAt: conflictingLease.expiresAt,
          },
          message: 'Another client currently holds the exclusive controller lease.',
          retryAfterMs,
          retryable: true,
        });
      }
      const issuedAt = new Date(now()).toISOString();
      const lease: Lease = {
        expiresAt: new Date(now() + request.durationMilliseconds).toISOString(),
        id: generateId(),
        issuedAt,
        methods: [...request.requestedMethods],
        mode,
        targetGeneration: target.generation,
        targetId: target.id,
      };
      leasesById.set(lease.id, lease);
      leasePrincipalIdsById.set(lease.id, authority.principalId);
      scheduleLeaseExpiry(lease);
      return lease;
    },
    cancelCommand(operationId, authority = localClientAuthority) {
      if (disposed) return;
      const cancellation = cancellationsByOperationId.get(operationId);
      if (cancellation?.connectionId === authority.connectionId) cancellation.abortController.abort();
    },
    connectClient(authority) {
      ensureActive();
      connectedPrincipalIdsByConnectionId.set(authority.connectionId, authority.principalId);
      const reconnectGraceTimeout = reconnectGraceTimeoutsByPrincipalId.get(authority.principalId);
      if (reconnectGraceTimeout !== undefined) {
        clearTimeout(reconnectGraceTimeout);
        reconnectGraceTimeoutsByPrincipalId.delete(authority.principalId);
      }
    },
    disconnectClient(authority) {
      if (disposed || connectedPrincipalIdsByConnectionId.get(authority.connectionId) !== authority.principalId) return;
      connectedPrincipalIdsByConnectionId.delete(authority.connectionId);
      for (const cancellation of cancellationsByOperationId.values()) if (cancellation.connectionId === authority.connectionId) cancellation.abortController.abort();
      for (const [subscriptionId, connectionId] of subscriptionConnectionIdsById) if (connectionId === authority.connectionId) subscriptions.get(subscriptionId)?.close();
      if ([...connectedPrincipalIdsByConnectionId.values()].includes(authority.principalId)) return;
      const releasePrincipalLeases = (): void => {
        reconnectGraceTimeoutsByPrincipalId.delete(authority.principalId);
        if ([...connectedPrincipalIdsByConnectionId.values()].includes(authority.principalId)) return;
        for (const [leaseId, principalId] of leasePrincipalIdsById) if (principalId === authority.principalId) deleteLease(leaseId);
      };
      if (reconnectGraceMilliseconds === 0) releasePrincipalLeases();
      else reconnectGraceTimeoutsByPrincipalId.set(authority.principalId, setTimeout(releasePrincipalLeases, reconnectGraceMilliseconds));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancellation of cancellationsByOperationId.values()) cancellation.abortController.abort();
      cancellationsByOperationId.clear();
      commandOperationIdsByTargetKey.clear();
      for (const subscription of subscriptions.values()) subscription.close();
      subscriptions.clear();
      for (const target of targetsById.values()) artifactStore.revokeTarget(target.id, target.generation);
      targetsById.clear();
      executorsByTargetKey.clear();
      leasesById.clear();
      leasePrincipalIdsById.clear();
      for (const expiryTimeout of leaseExpiryTimeoutsById.values()) clearTimeout(expiryTimeout);
      leaseExpiryTimeoutsById.clear();
      for (const reconnectGraceTimeout of reconnectGraceTimeoutsByPrincipalId.values()) clearTimeout(reconnectGraceTimeout);
      reconnectGraceTimeoutsByPrincipalId.clear();
      connectedPrincipalIdsByConnectionId.clear();
      subscriptionDemandCountsByKey.clear();
      for (const watcher of targetWatchers) watcher.close();
      targetWatchers.clear();
    },
    async executeCommand(command, authority = localClientAuthority) {
      ensureActive();
      const target = getAuthorizedTarget(command.targetId, command.targetGeneration, authority);
      let lease: Lease;
      try {
        lease = getActiveLease(command, authority);
      } catch (error) {
        recordDiagnostic(error instanceof TargetBrokerError ? error.code : 'LEASE_REQUIRED');
        throw error;
      }
      if (!lease.methods.includes(command.method) || !isCdpNameAllowed(target.capabilities, command.method, 'command') || (lease.mode === 'shared-read' && requiredLeaseMode(target.capabilities, [command.method]) === 'exclusive-control')) {
        recordDiagnostic('CAPABILITY_DENIED');
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
      if (executor === undefined) {
        recordDiagnostic('TARGET_NOT_FOUND');
        throw new TargetBrokerError('TARGET_NOT_FOUND');
      }
      const abortController = new AbortController();
      cancellationsByOperationId.set(command.operationId, { abortController, connectionId: authority.connectionId });
      const targetKey = getTargetKey(target.id, target.generation);
      const operationIds = commandOperationIdsByTargetKey.get(targetKey) ?? new Set<string>();
      operationIds.add(command.operationId);
      commandOperationIdsByTargetKey.set(targetKey, operationIds);
      const timeout = setTimeout(() => abortController.abort(), commandTimeoutMilliseconds);
      try {
        const value = await executor.execute(command, abortController.signal, lease);
        if (abortController.signal.aborted) {
          recordDiagnostic('REQUEST_CANCELLED');
          throw new TargetBrokerError('REQUEST_CANCELLED');
        }
        const externalizedValue = await externalizeJsonResult(value, {
          expiresAt: new Date(now() + artifactLifetimeMilliseconds).toISOString(),
          maximumInlineBytes: maximumInlineResultBytes,
          ownerId: lease.id,
          signal: abortController.signal,
          store: artifactStore,
          targetGeneration: target.generation,
          targetId: target.id,
        });
        return { operationId: command.operationId, value: externalizedValue };
      } catch (error) {
        if (error instanceof TargetBrokerError) {
          throw error;
        }
        if (abortController.signal.aborted) {
          recordDiagnostic('REQUEST_CANCELLED');
          throw new TargetBrokerError('REQUEST_CANCELLED');
        }
        recordDiagnostic('CDP_COMMAND_FAILED');
        throw new TargetBrokerError('CDP_COMMAND_FAILED', {
          ...(error instanceof Error ? { message: error.message } : {}),
        });
      } finally {
        clearTimeout(timeout);
        cancellationsByOperationId.delete(command.operationId);
        operationIds.delete(command.operationId);
        if (operationIds.size === 0) commandOperationIdsByTargetKey.delete(targetKey);
      }
    },
    getTargetAgentPrincipalId(targetId) {
      ensureActive();
      return targetAgentPrincipalIdsById.get(targetId);
    },
    listTargets(authority = localClientAuthority) {
      ensureActive();
      if (authority.targetGrants === undefined) return [...targetsById.values()];
      return [...targetsById.values()].flatMap((target) => {
        const grant = authority.targetGrants?.find(candidate => candidate.targetId === target.id);
        return grant === undefined ? [] : [{ ...target, capabilities: intersectCapabilities(target.capabilities, grant.capabilities) }];
      });
    },
    publishTarget(target, authority = localAgentAuthority) {
      ensureActive();
      assertAgentOwnsTarget(target.id, authority);
      const highestGeneration = highestGenerationByTargetId.get(target.id);
      if (highestGeneration !== undefined && target.generation <= highestGeneration) {
        throw new TargetBrokerError('TARGET_GENERATION_STALE');
      }
      targetsById.set(target.id, target);
      targetAgentPrincipalIdsById.set(target.id, authority.principalId);
      highestGenerationByTargetId.set(target.id, target.generation);
      publishTargetChange({ kind: 'published', target });
    },
    registerTargetExecutor(target, executor, authority = localAgentAuthority) {
      ensureActive();
      assertAgentOwnsTarget(target.id, authority);
      executorsByTargetKey.set(getTargetKey(target.id, target.generation), executor);
    },
    reconcileTargets(targets, authority = localAgentAuthority) {
      ensureActive();
      const targetIds = new Set(targets.map(target => target.id));
      for (const target of [...targetsById.values()]) {
        if (targetAgentPrincipalIdsById.get(target.id) === authority.principalId && !targetIds.has(target.id)) {
          targetBroker.revokeTarget(target.id, target.generation, 'detached', authority);
        }
      }
      for (const target of targets) {
        assertAgentOwnsTarget(target.id, authority);
        const currentTarget = targetsById.get(target.id);
        if (currentTarget === undefined) targetBroker.publishTarget(target, authority);
        else if (currentTarget.generation === target.generation) targetBroker.updateTarget(target, authority);
        else if (currentTarget.generation < target.generation) {
          targetBroker.revokeTarget(currentTarget.id, currentTarget.generation, 'detached', authority);
          targetBroker.publishTarget(target, authority);
        }
      }
    },
    revokeAgentTargets(authority, reason = 'detached') {
      ensureActive();
      for (const target of [...targetsById.values()]) {
        if (targetAgentPrincipalIdsById.get(target.id) === authority.principalId) {
          targetBroker.revokeTarget(target.id, target.generation, reason, authority);
        }
      }
    },
    revokeTarget(targetId, generation, reason = 'explicit', authority) {
      ensureActive();
      if (authority !== undefined) assertAgentOwnsTarget(targetId, authority);
      const target = targetsById.get(targetId);
      if (target?.generation === generation) {
        recordDiagnostic('TARGET_REVOKED');
        targetsById.delete(targetId);
        targetAgentPrincipalIdsById.delete(targetId);
        for (const operationId of commandOperationIdsByTargetKey.get(getTargetKey(targetId, generation)) ?? []) cancellationsByOperationId.get(operationId)?.abortController.abort();
        for (const [leaseId, lease] of leasesById) {
          if (lease.targetId === targetId && lease.targetGeneration === generation) {
            deleteLease(leaseId);
          }
        }
        for (const subscription of subscriptions.values()) if (subscription.request.targetId === targetId && subscription.request.targetGeneration === generation) subscription.close();
        executorsByTargetKey.delete(getTargetKey(targetId, generation));
        artifactStore.revokeTarget(targetId, generation);
        for (const demandKey of subscriptionDemandCountsByKey.keys()) if (demandKey.startsWith(`${getTargetKey(targetId, generation)}:`)) subscriptionDemandCountsByKey.delete(demandKey);
        publishTargetChange({ kind: 'revoked', reason, targetGeneration: generation, targetId });
      }
    },
    updateTarget(target, authority = localAgentAuthority) {
      ensureActive();
      assertAgentOwnsTarget(target.id, authority);
      const currentTarget = getCurrentTarget(target.id, target.generation);
      targetsById.set(target.id, target);
      highestGenerationByTargetId.set(target.id, currentTarget.generation);
      for (const [leaseId, lease] of leasesById) {
        if (lease.targetId === target.id && lease.targetGeneration === target.generation && lease.methods.some(method => !isCdpNameAllowed(target.capabilities, method, 'command') && !isCdpNameAllowed(target.capabilities, method, 'event'))) {
          deleteLease(leaseId);
          closeSubscriptionsUsingLease(leaseId);
        }
      }
      publishTargetChange({ kind: 'updated', target });
    },
    watchTargets(authority = localClientAuthority) {
      ensureActive();
      const changes: TargetChange[] = [{ kind: 'snapshot', sequence: targetChangeSequence, targets: [...targetBroker.listTargets(authority)] }];
      let resolver: ((result: IteratorResult<TargetChange>) => void) | undefined;
      let closed = false;
      const watcher = {
        close() {
          if (closed) return;
          closed = true;
          targetWatchers.delete(watcher);
          resolver?.({ done: true, value: undefined });
          resolver = undefined;
        },
        offer(change: TargetChange) {
          if (closed) return;
          let authorizedChange: TargetChange | undefined;
          if (change.kind === 'snapshot') {
            authorizedChange = { ...change, targets: change.targets.flatMap((target) => {
              const grant = authority.targetGrants?.find(candidate => candidate.targetId === target.id);
              if (authority.targetGrants !== undefined && grant === undefined) return [];
              return grant === undefined ? [target] : [{ ...target, capabilities: intersectCapabilities(target.capabilities, grant.capabilities) }];
            }) };
          } else if (change.kind === 'published' || change.kind === 'updated') {
            const grant = authority.targetGrants?.find(candidate => candidate.targetId === change.target.id);
            if (authority.targetGrants !== undefined && grant === undefined) return;
            authorizedChange = grant === undefined ? change : { ...change, target: { ...change.target, capabilities: intersectCapabilities(change.target.capabilities, grant.capabilities) } };
          } else {
            if (authority.targetGrants !== undefined && !authority.targetGrants.some(candidate => candidate.targetId === change.targetId)) return;
            authorizedChange = change;
          }
          if (resolver !== undefined) {
            const resolve = resolver;
            resolver = undefined;
            resolve({ done: false, value: authorizedChange });
          } else changes.push(authorizedChange);
        },
      };
      targetWatchers.add(watcher);
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<TargetChange>> {
              const change = changes.shift();
              if (change !== undefined) return { done: false, value: change };
              if (closed) return { done: true, value: undefined };
              return new Promise(resolve => resolver = resolve);
            },
            async return(): Promise<IteratorResult<TargetChange>> {
              watcher.close();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    publishEvent(target, method, parameters, sessionId) {
      ensureActive();
      const publishedTarget = getCurrentTarget(target.id, target.generation);
      if (!isCdpNameAllowed(publishedTarget.capabilities, method, 'event')) return;
      for (const subscription of subscriptions.values()) if (subscription.request.targetId === target.id && subscription.request.targetGeneration === target.generation) subscription.offer(method, parameters, sessionId);
    },
    releaseLease(request, authority = localClientAuthority) {
      ensureActive();
      getAuthorizedTarget(request.targetId, request.targetGeneration, authority);
      const lease = getActiveLease(request, authority);
      deleteLease(lease.id);
      closeSubscriptionsUsingLease(lease.id);
    },
    readArtifact(request, authority = localClientAuthority) {
      ensureActive();
      return artifactStore.read(request.artifactId, getArtifactAuthority(request, authority), request.range);
    },
    releaseArtifact(request, authority = localClientAuthority) {
      ensureActive();
      artifactStore.release(request.artifactId, getArtifactAuthority(request, authority));
    },
    renewLease(request, authority = localClientAuthority) {
      ensureActive();
      getAuthorizedTarget(request.targetId, request.targetGeneration, authority);
      if (!Number.isSafeInteger(request.durationMilliseconds) || request.durationMilliseconds < 1 || request.durationMilliseconds > maximumLeaseMilliseconds) throw new TargetBrokerError('CAPABILITY_DENIED');
      const lease = getActiveLease(request, authority);
      const renewedLease: Lease = { ...lease, expiresAt: new Date(now() + request.durationMilliseconds).toISOString() };
      leasesById.set(lease.id, renewedLease);
      const previousExpiryTimeout = leaseExpiryTimeoutsById.get(lease.id);
      if (previousExpiryTimeout !== undefined) clearTimeout(previousExpiryTimeout);
      scheduleLeaseExpiry(renewedLease);
      return renewedLease;
    },
    async subscribe(request, authority = localClientAuthority) {
      ensureActive();
      const target = getAuthorizedTarget(request.targetId, request.targetGeneration, authority);
      const lease = getActiveLease(request, authority);
      const authorizedMethods = getAuthorizedSubscriptionMethods(request, lease, target);
      const demand = getSubscriptionDemand(request);
      if ((request.batch !== undefined && request.batch.maximumEvents > request.buffer.capacity) || (hasStatefulSubscriptionDemand(demand) && request.buffer.capacity > 16)) throw new TargetBrokerError('CAPABILITY_DENIED');
      const id = generateId();
      const buffer: CdpEvent[] = [];
      const batch = request.batch ?? { flushMilliseconds: 1, maximumEvents: 1 };
      let closed = false;
      let droppedCount = 0;
      let flushTimeout: ReturnType<typeof setTimeout> | undefined;
      let lastDeliveredSequence = 0;
      let overflowed = false;
      let demandActive = false;
      let resolver: ((result: IteratorResult<CdpEvent>) => void) | undefined;
      const flush = (): void => {
        flushTimeout = undefined;
        if (resolver === undefined) return;
        const event = buffer.shift();
        if (event === undefined) return;
        const resolve = resolver;
        resolver = undefined;
        lastDeliveredSequence = event.sequence;
        resolve({ done: false, value: event });
      };
      const scheduleFlush = (): void => {
        if (flushTimeout === undefined && buffer.length > 0) flushTimeout = setTimeout(flush, batch.flushMilliseconds);
      };
      const close = (): void => {
        closed = true;
        if (flushTimeout !== undefined) clearTimeout(flushTimeout);
        buffer.length = 0;
        subscriptions.delete(id);
        subscriptionConnectionIdsById.delete(id);
        resolver?.({ done: true, value: undefined });
        if (demandActive) decrementSubscriptionDemand(target, request, demand);
        demandActive = false;
      };
      const subscription: CdpSubscription = { close, get droppedCount() {
        return droppedCount;
      }, id, get lastDeliveredSequence() {
        return lastDeliveredSequence;
      }, get overflowed() {
        return overflowed;
      }, targetGeneration: target.generation, targetId: target.id, [Symbol.asyncIterator]: () => ({ next: async () => {
        const event = buffer.shift();
        if (event !== undefined) {
          lastDeliveredSequence = event.sequence;
          return Promise.resolve({ done: false, value: event });
        }
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          resolver = resolve;
          scheduleFlush();
        });
      } }) };
      await incrementSubscriptionDemand(target, request, demand);
      demandActive = true;
      subscriptions.set(id, { authorizedMethods, close, demand, offer(method, parameters, sessionId) {
        const matches = eventMatchesSubscription(request, method, parameters, sessionId);
        let activeLease: Lease;
        try {
          activeLease = getActiveLease(request, authority);
        } catch {
          close();
          return;
        }
        if (!matches || closed || !activeLease.methods.includes(method) || !subscriptions.get(id)?.authorizedMethods.has(method) || !isCdpNameAllowed(target.capabilities, method, 'event') || (activeLease.mode === 'shared-read' && requiredLeaseMode(target.capabilities, [method]) === 'exclusive-control')) return;
        const current = subscriptions.get(id);
        if (current === undefined) return;
        const event: CdpEvent = { method, parameters, sequence: current.sequence++, subscriptionId: id, targetGeneration: target.generation, targetId: target.id, ...(sessionId === undefined ? {} : { sessionId }) };
        if (buffer.length < request.buffer.capacity) {
          buffer.push(event);
          if (buffer.length >= batch.maximumEvents) flush();
          else scheduleFlush();
        } else {
          overflowed = true;
          droppedCount += 1;
          if (request.buffer.overflowStrategy === 'disconnect') close();
          else if (request.buffer.overflowStrategy === 'drop-oldest') {
            buffer.shift();
            buffer.push(event);
            if (buffer.length >= batch.maximumEvents) flush();
          }
        }
      }, request, sequence: 1 });
      subscriptionConnectionIdsById.set(id, authority.connectionId);
      return subscription;
    },
  };
}
