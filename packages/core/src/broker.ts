import type { TargetChange, TargetRevocationReason } from './client.js';
import type { CdpCommand, CdpEvent, CdpSubscriptionRequest, JsonObject, Lease, PublishedTarget } from './protocol.js';

type TargetChangeInput
  = | { readonly kind: 'published'; readonly target: PublishedTarget }
    | { readonly kind: 'revoked'; readonly reason: TargetRevocationReason; readonly targetGeneration: number; readonly targetId: string }
    | { readonly kind: 'snapshot'; readonly targets: readonly PublishedTarget[] }
    | { readonly kind: 'updated'; readonly target: PublishedTarget };

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

export interface TargetCommandExecutor {
  execute: (command: CdpCommand, abortSignal: AbortSignal) => Promise<JsonObject>;
  setSubscriptionDemand?: (methodPrefix: string, active: boolean) => Promise<void>;
}

export interface CdpSubscription extends AsyncIterable<CdpEvent> {
  readonly id: string;
  readonly overflowed: boolean;
  close: () => void;
}

export class TargetBrokerError extends Error {
  constructor(readonly code: 'CAPABILITY_DENIED' | 'CDP_COMMAND_FAILED' | 'LEASE_CONFLICT' | 'LEASE_EXPIRED' | 'LEASE_REQUIRED' | 'REQUEST_CANCELLED' | 'TARGET_GENERATION_STALE' | 'TARGET_NOT_FOUND') {
    super(code === 'CDP_COMMAND_FAILED' ? 'The debugger command failed.' : 'The requested target operation is not available.');
  }
}

export interface CreateTargetBrokerOptions {
  readonly commandTimeoutMilliseconds?: number;
  readonly maximumLeaseMilliseconds?: number;
  readonly now?: () => number;
}

export interface TargetBroker {
  acquireLease: (request: AcquireLeaseRequest) => Lease;
  cancelCommand: (operationId: string) => void;
  executeCommand: (command: CdpCommand) => Promise<{ readonly operationId: string; readonly value: JsonObject }>;
  listTargets: () => readonly PublishedTarget[];
  publishTarget: (target: PublishedTarget) => void;
  registerTargetExecutor: (target: Pick<PublishedTarget, 'generation' | 'id'>, executor: TargetCommandExecutor) => void;
  reconcileTargets: (targets: readonly PublishedTarget[]) => void;
  revokeTarget: (targetId: string, generation: number, reason?: TargetRevocationReason) => void;
  updateTarget: (target: PublishedTarget) => void;
  watchTargets: () => AsyncIterable<TargetChange>;
  publishEvent: (target: Pick<PublishedTarget, 'generation' | 'id'>, method: string, parameters: JsonObject) => void;
  releaseLease: (request: ReleaseLeaseRequest) => void;
  renewLease: (request: RenewLeaseRequest) => Lease;
  subscribe: (request: CdpSubscriptionRequest) => Promise<CdpSubscription>;
}

/** Stores only opaque target records received from an authenticated extension agent. */
export function createTargetBroker(options: CreateTargetBrokerOptions = {}): TargetBroker {
  const commandTimeoutMilliseconds = options.commandTimeoutMilliseconds ?? 30_000;
  const maximumLeaseMilliseconds = options.maximumLeaseMilliseconds ?? 60_000;
  const now = options.now ?? Date.now;
  const targetsById = new Map<string, PublishedTarget>();
  const highestGenerationByTargetId = new Map<string, number>();
  const leasesById = new Map<string, Lease>();
  const executorsByTargetKey = new Map<string, TargetCommandExecutor>();
  const cancellationsByOperationId = new Map<string, AbortController>();
  const commandOperationIdsByTargetKey = new Map<string, Set<string>>();
  const subscriptions = new Map<string, { close: () => void; offer: (method: string, parameters: JsonObject) => void; request: CdpSubscriptionRequest; sequence: number }>();
  const targetWatchers = new Set<{ offer: (change: TargetChange) => void }>();
  let targetChangeSequence = 0;

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
      throw new TargetBrokerError('TARGET_NOT_FOUND');
    }
    if (target.generation !== generation) {
      throw new TargetBrokerError('TARGET_GENERATION_STALE');
    }
    return target;
  }

  function removeExpiredLeases(): void {
    for (const [leaseId, lease] of leasesById) if (Date.parse(lease.expiresAt) <= now()) leasesById.delete(leaseId);
  }

  function getActiveLease(request: Pick<RenewLeaseRequest, 'leaseId' | 'targetGeneration' | 'targetId'>): Lease {
    const lease = leasesById.get(request.leaseId);
    if (lease === undefined || lease.targetId !== request.targetId || lease.targetGeneration !== request.targetGeneration) throw new TargetBrokerError('LEASE_REQUIRED');
    if (Date.parse(lease.expiresAt) <= now()) {
      leasesById.delete(lease.id);
      throw new TargetBrokerError('LEASE_EXPIRED');
    }
    return lease;
  }

  let targetBroker: TargetBroker;
  return targetBroker = {
    acquireLease(request) {
      const target = getCurrentTarget(request.targetId, request.targetGeneration);
      const mode = request.mode ?? 'shared-read';
      if (
        !Number.isSafeInteger(request.durationMilliseconds)
        || request.durationMilliseconds < 1
        || request.durationMilliseconds > maximumLeaseMilliseconds
        || request.requestedMethods.some(method => !target.capabilities.methods.includes(method))
      ) {
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      removeExpiredLeases();
      if (mode === 'exclusive-control' && [...leasesById.values()].some(lease => lease.targetId === target.id && lease.targetGeneration === target.generation && lease.mode === 'exclusive-control')) {
        throw new TargetBrokerError('LEASE_CONFLICT');
      }
      const issuedAt = new Date(now()).toISOString();
      const lease: Lease = {
        expiresAt: new Date(now() + request.durationMilliseconds).toISOString(),
        id: globalThis.crypto.randomUUID(),
        issuedAt,
        methods: [...request.requestedMethods],
        mode,
        targetGeneration: target.generation,
        targetId: target.id,
      };
      leasesById.set(lease.id, lease);
      return lease;
    },
    cancelCommand(operationId) {
      cancellationsByOperationId.get(operationId)?.abort();
    },
    async executeCommand(command) {
      const target = getCurrentTarget(command.targetId, command.targetGeneration);
      const lease = leasesById.get(command.leaseId);
      if (lease === undefined || lease.targetId !== target.id || lease.targetGeneration !== target.generation) {
        throw new TargetBrokerError('LEASE_REQUIRED');
      }
      if (Date.parse(lease.expiresAt) <= now()) {
        leasesById.delete(lease.id);
        throw new TargetBrokerError('LEASE_EXPIRED');
      }
      if (!lease.methods.includes(command.method) || !target.capabilities.methods.includes(command.method)) {
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
      if (executor === undefined) {
        throw new TargetBrokerError('TARGET_NOT_FOUND');
      }
      const abortController = new AbortController();
      cancellationsByOperationId.set(command.operationId, abortController);
      const targetKey = getTargetKey(target.id, target.generation);
      const operationIds = commandOperationIdsByTargetKey.get(targetKey) ?? new Set<string>();
      operationIds.add(command.operationId);
      commandOperationIdsByTargetKey.set(targetKey, operationIds);
      const timeout = setTimeout(() => abortController.abort(), commandTimeoutMilliseconds);
      try {
        const value = await executor.execute(command, abortController.signal);
        if (abortController.signal.aborted) {
          throw new TargetBrokerError('REQUEST_CANCELLED');
        }
        return { operationId: command.operationId, value };
      } catch (error) {
        if (error instanceof TargetBrokerError) {
          throw error;
        }
        if (abortController.signal.aborted) {
          throw new TargetBrokerError('REQUEST_CANCELLED');
        }
        throw new TargetBrokerError('CDP_COMMAND_FAILED');
      } finally {
        clearTimeout(timeout);
        cancellationsByOperationId.delete(command.operationId);
        operationIds.delete(command.operationId);
        if (operationIds.size === 0) commandOperationIdsByTargetKey.delete(targetKey);
      }
    },
    listTargets() {
      return [...targetsById.values()];
    },
    publishTarget(target) {
      const highestGeneration = highestGenerationByTargetId.get(target.id);
      if (highestGeneration !== undefined && target.generation <= highestGeneration) {
        throw new TargetBrokerError('TARGET_GENERATION_STALE');
      }
      targetsById.set(target.id, target);
      highestGenerationByTargetId.set(target.id, target.generation);
      publishTargetChange({ kind: 'published', target });
    },
    registerTargetExecutor(target, executor) {
      executorsByTargetKey.set(getTargetKey(target.id, target.generation), executor);
    },
    reconcileTargets(targets) {
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
      const target = targetsById.get(targetId);
      if (target?.generation === generation) {
        targetsById.delete(targetId);
        executorsByTargetKey.delete(getTargetKey(targetId, generation));
        for (const operationId of commandOperationIdsByTargetKey.get(getTargetKey(targetId, generation)) ?? []) cancellationsByOperationId.get(operationId)?.abort();
        for (const [leaseId, lease] of leasesById) {
          if (lease.targetId === targetId && lease.targetGeneration === generation) {
            leasesById.delete(leaseId);
          }
        }
        for (const subscription of subscriptions.values()) if (subscription.request.targetId === targetId && subscription.request.targetGeneration === generation) subscription.close();
        publishTargetChange({ kind: 'revoked', reason, targetGeneration: generation, targetId });
      }
    },
    updateTarget(target) {
      const currentTarget = getCurrentTarget(target.id, target.generation);
      targetsById.set(target.id, target);
      highestGenerationByTargetId.set(target.id, currentTarget.generation);
      for (const [leaseId, lease] of leasesById) {
        if (lease.targetId === target.id && lease.targetGeneration === target.generation && lease.methods.some(method => !target.capabilities.methods.includes(method))) leasesById.delete(leaseId);
      }
      publishTargetChange({ kind: 'updated', target });
    },
    watchTargets() {
      const changes: TargetChange[] = [{ kind: 'snapshot', sequence: targetChangeSequence, targets: [...targetsById.values()] }];
      let resolver: ((result: IteratorResult<TargetChange>) => void) | undefined;
      let closed = false;
      const watcher = {
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
              closed = true;
              targetWatchers.delete(watcher);
              resolver?.({ done: true, value: undefined });
              resolver = undefined;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    publishEvent(target, method, parameters) {
      for (const subscription of subscriptions.values()) if (subscription.request.targetId === target.id && subscription.request.targetGeneration === target.generation) subscription.offer(method, parameters);
    },
    releaseLease(request) {
      getCurrentTarget(request.targetId, request.targetGeneration);
      const lease = getActiveLease(request);
      leasesById.delete(lease.id);
    },
    renewLease(request) {
      getCurrentTarget(request.targetId, request.targetGeneration);
      if (!Number.isSafeInteger(request.durationMilliseconds) || request.durationMilliseconds < 1 || request.durationMilliseconds > maximumLeaseMilliseconds) throw new TargetBrokerError('CAPABILITY_DENIED');
      const lease = getActiveLease(request);
      const renewedLease: Lease = { ...lease, expiresAt: new Date(now() + request.durationMilliseconds).toISOString() };
      leasesById.set(lease.id, renewedLease);
      return renewedLease;
    },
    async subscribe(request) {
      const target = getCurrentTarget(request.targetId, request.targetGeneration);
      const lease = leasesById.get(request.leaseId);
      if (lease === undefined || lease.targetId !== target.id || lease.targetGeneration !== target.generation || Date.parse(lease.expiresAt) <= now()) throw new TargetBrokerError('LEASE_REQUIRED');
      const id = globalThis.crypto.randomUUID();
      const buffer: CdpEvent[] = [];
      let closed = false;
      let overflowed = false;
      let resolver: ((result: IteratorResult<CdpEvent>) => void) | undefined;
      const close = (): void => {
        closed = true;
        subscriptions.delete(id);
        resolver?.({ done: true, value: undefined });
        const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
        if (executor?.setSubscriptionDemand !== undefined) {
          const methodPrefix = 'method' in request.match ? request.match.method : request.match.methodPrefix;
          void executor.setSubscriptionDemand(methodPrefix, false);
        }
      };
      const subscription: CdpSubscription = { close, id, get overflowed() {
        return overflowed;
      }, [Symbol.asyncIterator]: () => ({ next: async () => {
        const event = buffer.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => resolver = resolve);
      } }) };
      subscriptions.set(id, { close, offer(method, parameters) {
        const matches = 'method' in request.match ? method === request.match.method : method.startsWith(request.match.methodPrefix);
        if (!matches || closed) return;
        const current = subscriptions.get(id);
        if (current === undefined) return;
        const event: CdpEvent = { method, parameters, sequence: current.sequence++, subscriptionId: id, targetGeneration: target.generation, targetId: target.id };
        if (resolver !== undefined) {
          const resolve = resolver;
          resolver = undefined;
          resolve({ done: false, value: event });
        } else if (buffer.length < request.buffer.capacity) buffer.push(event);
        else {
          overflowed = true;
          if (request.buffer.overflowStrategy === 'disconnect') close();
          else if (request.buffer.overflowStrategy === 'drop-oldest') {
            buffer.shift();
            buffer.push(event);
          }
        }
      }, request, sequence: 1 });
      const executor = executorsByTargetKey.get(getTargetKey(target.id, target.generation));
      if (executor?.setSubscriptionDemand !== undefined) {
        const methodPrefix = 'method' in request.match ? request.match.method : request.match.methodPrefix;
        await executor.setSubscriptionDemand(methodPrefix, true);
      }
      return subscription;
    },
  };
}
