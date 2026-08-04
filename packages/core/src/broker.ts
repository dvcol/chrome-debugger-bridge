import type { CdpCommand, JsonObject, Lease, PublishedTarget } from './protocol.js';

export interface AcquireLeaseRequest {
  readonly durationMilliseconds: number;
  readonly requestedMethods: readonly string[];
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface TargetCommandExecutor {
  execute: (command: CdpCommand, abortSignal: AbortSignal) => Promise<JsonObject>;
}

export class TargetBrokerError extends Error {
  constructor(readonly code: 'CAPABILITY_DENIED' | 'CDP_COMMAND_FAILED' | 'LEASE_EXPIRED' | 'LEASE_REQUIRED' | 'REQUEST_CANCELLED' | 'TARGET_GENERATION_STALE' | 'TARGET_NOT_FOUND') {
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
  revokeTarget: (targetId: string, generation: number) => void;
}

/** Stores only opaque target records received from an authenticated extension agent. */
export function createTargetBroker(options: CreateTargetBrokerOptions = {}): TargetBroker {
  const commandTimeoutMilliseconds = options.commandTimeoutMilliseconds ?? 30_000;
  const maximumLeaseMilliseconds = options.maximumLeaseMilliseconds ?? 60_000;
  const now = options.now ?? Date.now;
  const targetsById = new Map<string, PublishedTarget>();
  const leasesById = new Map<string, Lease>();
  const executorsByTargetKey = new Map<string, TargetCommandExecutor>();
  const cancellationsByOperationId = new Map<string, AbortController>();

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

  return {
    acquireLease(request) {
      const target = getCurrentTarget(request.targetId, request.targetGeneration);
      if (
        !Number.isSafeInteger(request.durationMilliseconds)
        || request.durationMilliseconds < 1
        || request.durationMilliseconds > maximumLeaseMilliseconds
        || request.requestedMethods.some(method => !target.capabilities.methods.includes(method))
      ) {
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      const issuedAt = new Date(now()).toISOString();
      const lease: Lease = {
        expiresAt: new Date(now() + request.durationMilliseconds).toISOString(),
        id: globalThis.crypto.randomUUID(),
        issuedAt,
        methods: [...request.requestedMethods],
        mode: 'shared-read',
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
      }
    },
    listTargets() {
      return [...targetsById.values()];
    },
    publishTarget(target) {
      targetsById.set(target.id, target);
    },
    registerTargetExecutor(target, executor) {
      executorsByTargetKey.set(getTargetKey(target.id, target.generation), executor);
    },
    revokeTarget(targetId, generation) {
      const target = targetsById.get(targetId);
      if (target?.generation === generation) {
        targetsById.delete(targetId);
        executorsByTargetKey.delete(getTargetKey(targetId, generation));
        for (const [leaseId, lease] of leasesById) {
          if (lease.targetId === targetId && lease.targetGeneration === generation) {
            leasesById.delete(leaseId);
          }
        }
      }
    },
  };
}
