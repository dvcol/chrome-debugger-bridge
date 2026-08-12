import type { ArtifactAuthority, ArtifactByteRange, InlineOrArtifactResult, MemoryArtifactStore } from './artifact-store.js';
import type { TargetChange, TargetRevocationReason } from './client.js';
import type { DiagnosticCode, DiagnosticTraceStore } from './diagnostic-trace.js';
import type { CdpCommand, CdpEvent, CdpSubscriptionRequest, JsonObject, JsonValue, Lease, PublishedTarget } from './protocol.js';

import { createMemoryArtifactStore, externalizeJsonResult } from './artifact-store.js';
import { isCdpNameAllowed, requiredLeaseMode } from './cdp-authorization.js';

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
export interface ClientAuthority {
  readonly connectionId: string;
  readonly principalId: string;
}

const localClientAuthority: ClientAuthority = { connectionId: 'local', principalId: 'local' };

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
  offer: (method: string, parameters: JsonObject, sessionId?: string) => void;
  request: CdpSubscriptionRequest;
  sequence: number;
}

export class TargetBrokerError extends Error {
  constructor(readonly code: 'CAPABILITY_DENIED' | 'CDP_COMMAND_FAILED' | 'LEASE_CONFLICT' | 'LEASE_EXPIRED' | 'LEASE_REQUIRED' | 'REQUEST_CANCELLED' | 'TARGET_GENERATION_STALE' | 'TARGET_NOT_FOUND') {
    super(code === 'CDP_COMMAND_FAILED' ? 'The debugger command failed.' : 'The requested target operation is not available.');
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
  listTargets: () => readonly PublishedTarget[];
  publishTarget: (target: PublishedTarget) => void;
  registerTargetExecutor: (target: Pick<PublishedTarget, 'generation' | 'id'>, executor: TargetCommandExecutor) => void;
  reconcileTargets: (targets: readonly PublishedTarget[]) => void;
  revokeTarget: (targetId: string, generation: number, reason?: TargetRevocationReason) => void;
  updateTarget: (target: PublishedTarget) => void;
  watchTargets: () => AsyncIterable<TargetChange>;
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
  const highestGenerationByTargetId = new Map<string, number>();
  const leasesById = new Map<string, Lease>();
  const leasePrincipalIdsById = new Map<string, string>();
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
    return 'domain' in request.match
      ? `${request.match.domain}.`
      : 'method' in request.match
        ? request.match.method
        : request.match.methodPrefix;
  }

  function getSubscriptionDemandKey(target: Pick<PublishedTarget, 'generation' | 'id'>, request: CdpSubscriptionRequest): string {
    return `${getTargetKey(target.id, target.generation)}:${request.sessionId ?? 'root'}:${getSubscriptionDemand(request).split('.', 1)[0]}`;
  }

  function hasStatefulSubscriptionDemand(request: CdpSubscriptionRequest): boolean {
    return statefulSubscriptionDomains.has(getSubscriptionDemand(request).split('.', 1)[0] ?? '');
  }

  async function incrementSubscriptionDemand(target: PublishedTarget, request: CdpSubscriptionRequest): Promise<void> {
    const demandKey = getSubscriptionDemandKey(target, request);
    const count = subscriptionDemandCountsByKey.get(demandKey) ?? 0;
    subscriptionDemandCountsByKey.set(demandKey, count + 1);
    if (count !== 0) return;
    const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
    try {
      if (request.sessionId === undefined) await executor?.setSubscriptionDemand?.(getSubscriptionDemand(request), true);
      else await executor?.setSubscriptionDemand?.(getSubscriptionDemand(request), true, request.sessionId);
    } catch {
      subscriptionDemandCountsByKey.delete(demandKey);
      throw new TargetBrokerError('CDP_COMMAND_FAILED');
    }
  }

  function decrementSubscriptionDemand(target: PublishedTarget, request: CdpSubscriptionRequest): void {
    const demandKey = getSubscriptionDemandKey(target, request);
    const count = subscriptionDemandCountsByKey.get(demandKey) ?? 0;
    if (count <= 1) {
      subscriptionDemandCountsByKey.delete(demandKey);
      const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
      const setup = request.sessionId === undefined
        ? executor?.setSubscriptionDemand?.(getSubscriptionDemand(request), false)
        : executor?.setSubscriptionDemand?.(getSubscriptionDemand(request), false, request.sessionId);
      void setup?.catch(() => {});
    } else subscriptionDemandCountsByKey.set(demandKey, count - 1);
  }

  function deleteLease(leaseId: string): void {
    leasesById.delete(leaseId);
    leasePrincipalIdsById.delete(leaseId);
  }

  function removeExpiredLeases(): void {
    for (const [leaseId, lease] of leasesById) if (Date.parse(lease.expiresAt) <= now()) deleteLease(leaseId);
  }

  function getActiveLease(request: Pick<RenewLeaseRequest, 'leaseId' | 'targetGeneration' | 'targetId'>, authority: ClientAuthority): Lease {
    const lease = leasesById.get(request.leaseId);
    if (lease === undefined || leasePrincipalIdsById.get(request.leaseId) !== authority.principalId || lease.targetId !== request.targetId || lease.targetGeneration !== request.targetGeneration) throw new TargetBrokerError('LEASE_REQUIRED');
    if (Date.parse(lease.expiresAt) <= now()) {
      deleteLease(lease.id);
      throw new TargetBrokerError('LEASE_EXPIRED');
    }
    return lease;
  }

  function getArtifactAuthority(request: ArtifactAccessRequest, authority: ClientAuthority): ArtifactAuthority {
    getCurrentTarget(request.targetId, request.targetGeneration);
    const lease = getActiveLease(request, authority);
    return { ownerId: lease.id, targetGeneration: request.targetGeneration, targetId: request.targetId };
  }

  let targetBroker: TargetBroker;
  return targetBroker = {
    acquireLease(request, authority = localClientAuthority) {
      ensureActive();
      const target = getCurrentTarget(request.targetId, request.targetGeneration);
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
      if (mode === 'exclusive-control' && [...leasesById.values()].some(lease => lease.targetId === target.id && lease.targetGeneration === target.generation && lease.mode === 'exclusive-control')) {
        recordDiagnostic('LEASE_CONFLICT');
        throw new TargetBrokerError('LEASE_CONFLICT');
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
      for (const reconnectGraceTimeout of reconnectGraceTimeoutsByPrincipalId.values()) clearTimeout(reconnectGraceTimeout);
      reconnectGraceTimeoutsByPrincipalId.clear();
      connectedPrincipalIdsByConnectionId.clear();
      subscriptionDemandCountsByKey.clear();
      for (const watcher of targetWatchers) watcher.close();
      targetWatchers.clear();
    },
    async executeCommand(command, authority = localClientAuthority) {
      ensureActive();
      const target = getCurrentTarget(command.targetId, command.targetGeneration);
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
        throw new TargetBrokerError('CDP_COMMAND_FAILED');
      } finally {
        clearTimeout(timeout);
        cancellationsByOperationId.delete(command.operationId);
        operationIds.delete(command.operationId);
        if (operationIds.size === 0) commandOperationIdsByTargetKey.delete(targetKey);
      }
    },
    listTargets() {
      ensureActive();
      return [...targetsById.values()];
    },
    publishTarget(target) {
      ensureActive();
      const highestGeneration = highestGenerationByTargetId.get(target.id);
      if (highestGeneration !== undefined && target.generation <= highestGeneration) {
        throw new TargetBrokerError('TARGET_GENERATION_STALE');
      }
      targetsById.set(target.id, target);
      highestGenerationByTargetId.set(target.id, target.generation);
      publishTargetChange({ kind: 'published', target });
    },
    registerTargetExecutor(target, executor) {
      ensureActive();
      executorsByTargetKey.set(getTargetKey(target.id, target.generation), executor);
    },
    reconcileTargets(targets) {
      ensureActive();
      const targetIds = new Set(targets.map(target => target.id));
      for (const target of [...targetsById.values()]) {
        if (!targetIds.has(target.id)) targetBroker.revokeTarget(target.id, target.generation, 'detached');
      }
      for (const target of targets) {
        const currentTarget = targetsById.get(target.id);
        if (currentTarget === undefined) targetBroker.publishTarget(target);
        else if (currentTarget.generation === target.generation) targetBroker.updateTarget(target);
        else if (currentTarget.generation < target.generation) {
          targetBroker.revokeTarget(currentTarget.id, currentTarget.generation, 'detached');
          targetBroker.publishTarget(target);
        }
      }
    },
    revokeTarget(targetId, generation, reason = 'explicit') {
      ensureActive();
      const target = targetsById.get(targetId);
      if (target?.generation === generation) {
        recordDiagnostic('TARGET_REVOKED');
        targetsById.delete(targetId);
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
    updateTarget(target) {
      ensureActive();
      const currentTarget = getCurrentTarget(target.id, target.generation);
      targetsById.set(target.id, target);
      highestGenerationByTargetId.set(target.id, currentTarget.generation);
      for (const [leaseId, lease] of leasesById) {
        if (lease.targetId === target.id && lease.targetGeneration === target.generation && lease.methods.some(method => !isCdpNameAllowed(target.capabilities, method, 'command') && !isCdpNameAllowed(target.capabilities, method, 'event'))) deleteLease(leaseId);
      }
      publishTargetChange({ kind: 'updated', target });
    },
    watchTargets() {
      ensureActive();
      const changes: TargetChange[] = [{ kind: 'snapshot', sequence: targetChangeSequence, targets: [...targetsById.values()] }];
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
          if (resolver !== undefined) {
            const resolve = resolver;
            resolver = undefined;
            resolve({ done: false, value: change });
          } else changes.push(change);
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
      getCurrentTarget(request.targetId, request.targetGeneration);
      const lease = getActiveLease(request, authority);
      deleteLease(lease.id);
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
      getCurrentTarget(request.targetId, request.targetGeneration);
      if (!Number.isSafeInteger(request.durationMilliseconds) || request.durationMilliseconds < 1 || request.durationMilliseconds > maximumLeaseMilliseconds) throw new TargetBrokerError('CAPABILITY_DENIED');
      const lease = getActiveLease(request, authority);
      const renewedLease: Lease = { ...lease, expiresAt: new Date(now() + request.durationMilliseconds).toISOString() };
      leasesById.set(lease.id, renewedLease);
      return renewedLease;
    },
    async subscribe(request, authority = localClientAuthority) {
      ensureActive();
      const target = getCurrentTarget(request.targetId, request.targetGeneration);
      const lease = getActiveLease(request, authority);
      const requestedName = 'method' in request.match ? request.match.method : undefined;
      if (requestedName !== undefined && (!lease.methods.includes(requestedName) || !isCdpNameAllowed(target.capabilities, requestedName, 'event') || (lease.mode === 'shared-read' && requiredLeaseMode(target.capabilities, [requestedName]) === 'exclusive-control'))) throw new TargetBrokerError('CAPABILITY_DENIED');
      if ((request.batch !== undefined && request.batch.maximumEvents > request.buffer.capacity) || (hasStatefulSubscriptionDemand(request) && request.buffer.capacity > 16)) throw new TargetBrokerError('CAPABILITY_DENIED');
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
        if (demandActive) decrementSubscriptionDemand(target, request);
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
      await incrementSubscriptionDemand(target, request);
      demandActive = true;
      subscriptions.set(id, { close, offer(method, parameters, sessionId) {
        const matches = eventMatchesSubscription(request, method, parameters, sessionId);
        if (!matches || closed || !lease.methods.includes(method) || !isCdpNameAllowed(target.capabilities, method, 'event') || (lease.mode === 'shared-read' && requiredLeaseMode(target.capabilities, [method]) === 'exclusive-control')) return;
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
