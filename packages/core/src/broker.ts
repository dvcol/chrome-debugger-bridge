import type {
  ArtifactAuthority,
  ArtifactByteRange,
  InlineOrArtifactResult,
  MemoryArtifactStore,
} from './artifact-store.js';
import type {
  AutomationCdpEvent,
  AutomationElementHandle,
  AutomationExecutionRequest,
  AutomationExecutionResult,
  AutomationOperation,
  AutomationProvider,
} from './automation.js';
import type { TargetChange, TargetRevocationReason } from './client.js';
import type {
  DiagnosticCode,
  DiagnosticTraceStore,
} from './diagnostic-trace.js';
import type {
  BridgeErrorCode,
  CapabilityGrant,
  CdpCommand,
  CdpEvent,
  CdpSubscriptionRequest,
  JsonObject,
  JsonValue,
  Lease,
  PublishedTarget,
} from './protocol.js';
import type { TimeoutMilliseconds } from './timing.js';

import {
  createMemoryArtifactStore,
  externalizeJsonResult,
} from './artifact-store.js';
import {
  AutomationProviderError,
  requiredAutomationLevel,
} from './automation.js';
import {
  isCdpNameAllowed,
  isKnownCdpEventName,
  requiredLeaseMode,
} from './cdp-authorization.js';
import { cdpKernelOwnedNames } from './cdp-catalogue.generated.js';
import { scheduleTimeout, validateTimeoutMilliseconds } from './timing.js';

type TargetChangeInput
  = | { readonly kind: 'published'; readonly target: PublishedTarget }
    | {
      readonly kind: 'revoked';
      readonly reason: TargetRevocationReason;
      readonly targetGeneration: number;
      readonly targetId: string;
    }
    | { readonly kind: 'snapshot'; readonly targets: readonly PublishedTarget[] }
    | { readonly kind: 'updated'; readonly target: PublishedTarget };

const statefulSubscriptionDomains = new Set([
  'Fetch',
  'Performance',
  'Profiler',
  'Tracing',
]);
const lifecycleManagedDomains = new Set(
  cdpKernelOwnedNames
    .filter(name => name.endsWith('.enable'))
    .map(name => name.slice(0, -'.enable'.length)),
);

interface LeaseDomainDemand {
  readonly activation: Promise<void> | undefined;
  readonly demand: string;
  readonly sessionId?: string;
  readonly target: PublishedTarget;
}

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
  readonly bindingId: string;
  readonly capabilities: CapabilityGrant;
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface ClientAuthority {
  readonly connectionId: string;
  /** Human-facing diagnostic label. It is never used for authorization. */
  readonly displayName?: string;
  /** False when a reactive authority store cannot currently resolve this session. */
  readonly authorityAvailable?: boolean;
  readonly logicalSessionId?: string;
  readonly principalId: string;
  /** Omitted for a trusted in-process caller. An empty list authorizes no target. */
  readonly targetGrants?: readonly ClientTargetGrant[];
}

const localClientAuthority: ClientAuthority = {
  connectionId: 'local',
  principalId: 'local',
};

export interface AgentAuthority {
  readonly connectionGeneration?: number;
  readonly principalId: string;
}

const localAgentAuthority: AgentAuthority = { principalId: 'local-agent' };
const cdpDomainNamePattern = /^[A-Za-z]+$/u;

export interface TargetCommandExecutor {
  execute: (
    command: CdpCommand,
    abortSignal: AbortSignal,
    lease: Lease,
  ) => Promise<JsonObject>;
  setSubscriptionDemand?: (
    methodPrefix: string,
    active: boolean,
    sessionId?: string,
  ) => Promise<void>;
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
    readonly code: Extract<
      BridgeErrorCode,
      | 'CAPABILITY_DENIED'
      | 'CDP_COMMAND_FAILED'
      | 'FEATURE_UNSUPPORTED'
      | 'LEASE_CONFLICT'
      | 'LEASE_EXPIRED'
      | 'LEASE_REQUIRED'
      | 'REQUEST_CANCELLED'
      | 'SESSION_GENERATION_STALE'
      | 'SESSION_NOT_FOUND'
      | 'TARGET_GENERATION_STALE'
      | 'TARGET_NOT_FOUND'
    >,
    readonly options: {
      readonly details?: JsonObject;
      readonly message?: string;
      readonly retryAfterMs?: number;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(
      options.message
      ?? (code === 'CDP_COMMAND_FAILED'
        ? 'The debugger command failed.'
        : 'The requested target operation is not available.'),
    );
  }

  get details(): JsonObject | undefined {
    return this.options.details;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }

  get retryable(): boolean {
    return this.options.retryable
      ?? (this.code === 'LEASE_CONFLICT' || this.code === 'SESSION_NOT_FOUND');
  }
}

function targetExecutorError(error: unknown): TargetBrokerError | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as Readonly<Record<PropertyKey, unknown>>;
  const code = record.code;
  if (
    code !== 'CDP_COMMAND_FAILED'
    && code !== 'REQUEST_CANCELLED'
    && code !== 'SESSION_GENERATION_STALE'
    && code !== 'SESSION_NOT_FOUND'
  ) return undefined;
  const retryable = record.retryable;
  const retryAfterMs = record.retryAfterMs;
  const details = record.details;
  return new TargetBrokerError(code, {
    ...(details !== null && typeof details === 'object' && !Array.isArray(details)
      ? { details: details as JsonObject }
      : {}),
    ...(error instanceof Error ? { message: error.message } : {}),
    ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
  });
}

export interface BrokerTimingPolicy {
  readonly artifactLifetimeMilliseconds: TimeoutMilliseconds;
  readonly commandTimeoutMilliseconds: TimeoutMilliseconds;
  readonly leaseMaximumDurationMilliseconds: TimeoutMilliseconds;
  readonly leaseMaximumLifetimeMilliseconds: TimeoutMilliseconds;
  readonly reconnectGraceMilliseconds: TimeoutMilliseconds;
}

export const defaultBrokerTimingPolicy: Readonly<BrokerTimingPolicy> = Object.freeze({
  artifactLifetimeMilliseconds: 60_000,
  commandTimeoutMilliseconds: 30_000,
  leaseMaximumDurationMilliseconds: 60_000,
  leaseMaximumLifetimeMilliseconds: 15 * 60_000,
  reconnectGraceMilliseconds: 5_000,
});

export interface CreateTargetBrokerOptions {
  readonly artifactStore?: MemoryArtifactStore;
  readonly diagnostics?: DiagnosticTraceStore;
  readonly maximumArtifactBytes?: number;
  readonly maximumInlineResultBytes?: number;
  /** Generates opaque protocol identifiers; hosts may supply their own secure identifier adapter. */
  readonly generateId?: () => string;
  readonly now?: () => number;
  readonly timing?: Partial<BrokerTimingPolicy>;
}

export interface TargetBroker {
  /** Current broker-owned leases, scoped when an authenticated client is provided. */
  listLeases: (authority?: ClientAuthority) => readonly (Lease & { readonly principalId: string })[];
  acquireLease: (
    request: AcquireLeaseRequest,
    authority?: ClientAuthority,
  ) => Lease;
  cancelCommand: (operationId: string, authority?: ClientAuthority) => void;
  cancelAutomation: (
    operationId: string,
    authority?: ClientAuthority,
  ) => void;
  connectClient: (authority: ClientAuthority) => void;
  disconnectClient: (authority: ClientAuthority) => void;
  /** Stops all broker work and releases broker-owned resources. */
  dispose: () => void;
  executeCommand: (
    command: CdpCommand,
    authority?: ClientAuthority,
  ) => Promise<{
    readonly operationId: string;
    readonly value: InlineOrArtifactResult<JsonObject>;
  }>;
  executeAutomation: (
    request: AutomationExecutionRequest,
    authority?: ClientAuthority,
  ) => Promise<AutomationExecutionResult>;
  getTargetAgentPrincipalId: (targetId: string) => string | undefined;
  listTargets: (authority?: ClientAuthority) => readonly PublishedTarget[];
  publishTarget: (target: PublishedTarget, authority?: AgentAuthority) => void;
  registerAutomationProvider: (
    provider: AutomationProvider,
    authority?: AgentAuthority,
  ) => void;
  registerTargetExecutor: (
    target: Pick<PublishedTarget, 'generation' | 'id'>,
    executor: TargetCommandExecutor,
    authority?: AgentAuthority,
  ) => void;
  reconcileTargets: (
    targets: readonly PublishedTarget[],
    authority?: AgentAuthority,
  ) => void;
  /** Re-evaluates live work after a reactive authority record changes. */
  refreshClientAuthority: (authority: ClientAuthority) => void;
  revokeAgentTargets: (
    authority: AgentAuthority,
    reason?: TargetRevocationReason,
  ) => void;
  revokeTarget: (
    targetId: string,
    generation: number,
    reason?: TargetRevocationReason,
    authority?: AgentAuthority,
  ) => void;
  updateTarget: (target: PublishedTarget, authority?: AgentAuthority) => void;
  watchTargets: (authority?: ClientAuthority) => AsyncIterable<TargetChange>;
  publishEvent: (
    target: Pick<PublishedTarget, 'generation' | 'id'>,
    method: string,
    parameters: JsonObject,
    sessionId?: string,
  ) => void;
  releaseLease: (
    request: ReleaseLeaseRequest,
    authority?: ClientAuthority,
  ) => void;
  readArtifact: (
    request: ArtifactAccessRequest,
    authority?: ClientAuthority,
  ) => Uint8Array;
  releaseArtifact: (
    request: ArtifactAccessRequest,
    authority?: ClientAuthority,
  ) => void;
  renewLease: (
    request: RenewLeaseRequest,
    authority?: ClientAuthority,
  ) => Lease;
  subscribe: (
    request: CdpSubscriptionRequest,
    authority?: ClientAuthority,
  ) => Promise<CdpSubscription>;
  unregisterAutomationProvider: (authority?: AgentAuthority) => void;
}

/** Stores only opaque target records received from an authenticated extension agent. */
export function createTargetBroker(
  options: CreateTargetBrokerOptions = {},
): TargetBroker {
  const timing: BrokerTimingPolicy = {
    ...defaultBrokerTimingPolicy,
    ...options.timing,
  };
  const artifactLifetimeMilliseconds = validateTimeoutMilliseconds(
    timing.artifactLifetimeMilliseconds,
    'artifactLifetimeMilliseconds',
  );
  const commandTimeoutMilliseconds = validateTimeoutMilliseconds(
    timing.commandTimeoutMilliseconds,
    'commandTimeoutMilliseconds',
  );
  const leaseMaximumDurationMilliseconds = validateTimeoutMilliseconds(
    timing.leaseMaximumDurationMilliseconds,
    'leaseMaximumDurationMilliseconds',
  );
  const leaseMaximumLifetimeMilliseconds = validateTimeoutMilliseconds(
    timing.leaseMaximumLifetimeMilliseconds,
    'leaseMaximumLifetimeMilliseconds',
  );
  const reconnectGraceMilliseconds = validateTimeoutMilliseconds(
    timing.reconnectGraceMilliseconds,
    'reconnectGraceMilliseconds',
  );
  const maximumArtifactBytes = options.maximumArtifactBytes ?? 16_777_216;
  const maximumInlineResultBytes = options.maximumInlineResultBytes ?? 65_536;
  const generateId
    = options.generateId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? Date.now;
  const artifactStore
    = options.artifactStore
      ?? createMemoryArtifactStore(maximumArtifactBytes, now);
  const targetsById = new Map<string, PublishedTarget>();
  const targetAgentPrincipalIdsById = new Map<string, string>();
  const agentConnectionGenerationsByPrincipalId = new Map<string, number>();
  const highestGenerationByTargetId = new Map<string, number>();
  const leasesById = new Map<string, Lease>();
  const leasePrincipalIdsById = new Map<string, string>();
  const leaseExpiryTimeoutsById = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const executorsByTargetKey = new Map<string, TargetCommandExecutor>();
  const automationProvidersByAgentPrincipalId = new Map<
    string,
    AutomationProvider
  >();
  const automationEventListenersByTargetKey = new Map<
    string,
    Set<{
      readonly agentPrincipalId: string;
      readonly listener: (event: AutomationCdpEvent) => void;
    }>
  >();
  const automationElementHandlesById = new Map<
    string,
    {
      readonly agentPrincipalId: string;
      readonly generation: number;
      readonly opaqueHandle: string;
      readonly principalId: string;
      readonly providerId: string;
      readonly snapshotId?: string;
      readonly targetId: string;
    }
  >();
  const automationDomainDemandsByKey = new Map<
    string,
    {
      readonly agentPrincipalId: string;
      readonly demand: string;
      readonly sessionId?: string;
      readonly target: PublishedTarget;
    }
  >();
  const cancellationsByOperationId = new Map<
    string,
    { readonly abortController: AbortController; readonly connectionId: string; readonly leaseId: string }
  >();
  const commandOperationIdsByTargetKey = new Map<string, Set<string>>();
  const domainDemandCountsByKey = new Map<string, number>();
  const leaseDomainDemandsByLeaseId = new Map<
    string,
    Map<string, LeaseDomainDemand>
  >();
  const subscriptions = new Map<string, SubscriptionState>();
  const subscriptionConnectionIdsById = new Map<string, string>();
  const connectedPrincipalIdsByConnectionId = new Map<string, string>();
  const reconnectGraceTimeoutsByPrincipalId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const targetWatchers = new Set<{
    close: () => void;
    offer: (change: TargetChange) => void;
  }>();
  let disposed = false;
  let targetChangeSequence = 0;
  let targetBroker: TargetBroker;

  function ensureActive(): void {
    if (disposed) throw new Error('The target broker is disposed.');
  }

  function getAgentConnectionGeneration(authority: AgentAuthority): number {
    const connectionGeneration = authority.connectionGeneration ?? 1;
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
      throw new TypeError('Agent connection generations must be positive safe integers.');
    }
    return connectionGeneration;
  }

  function ensureCurrentAgentConnection(authority: AgentAuthority): void {
    const connectionGeneration = getAgentConnectionGeneration(authority);
    const currentGeneration = agentConnectionGenerationsByPrincipalId.get(authority.principalId);
    if (currentGeneration !== undefined && connectionGeneration < currentGeneration) {
      throw new TargetBrokerError('CAPABILITY_DENIED', {
        details: { reason: 'provider-connection-fenced' },
        message: 'A newer provider connection fenced this connection.',
        retryable: false,
      });
    }
    if (currentGeneration === connectionGeneration) return;
    agentConnectionGenerationsByPrincipalId.set(authority.principalId, connectionGeneration);
    if (currentGeneration === undefined) return;
    for (const target of [...targetsById.values()]) {
      if (targetAgentPrincipalIdsById.get(target.id) === authority.principalId) {
        targetBroker.revokeTarget(target.id, target.generation, 'detached');
      }
    }
    const provider = automationProvidersByAgentPrincipalId.get(authority.principalId);
    automationProvidersByAgentPrincipalId.delete(authority.principalId);
    releaseAutomationResources(authority.principalId);
    void Promise.resolve(provider?.dispose()).catch(() => {});
  }

  function isCurrentAgentConnection(authority: AgentAuthority): boolean {
    return (agentConnectionGenerationsByPrincipalId.get(authority.principalId)
      ?? getAgentConnectionGeneration(authority)) === getAgentConnectionGeneration(authority);
  }

  function recordDiagnostic(code: DiagnosticCode): void {
    options.diagnostics?.record(code);
  }

  function publishTargetChange(change: TargetChangeInput): void {
    const sequencedChange = {
      ...change,
      sequence: ++targetChangeSequence,
    } as TargetChange;
    for (const watcher of targetWatchers) watcher.offer(sequencedChange);
  }

  function getTargetKey(targetId: string, generation: number): string {
    return `${targetId}:${generation}`;
  }

  function capabilityLevelAllows(
    maximumLevel: CapabilityGrant['level'],
    requestedLevel: NonNullable<CapabilityGrant['level']>,
  ): boolean {
    const levels = [
      'observe',
      'inspect',
      'interact',
      'debug',
      'unsafe',
    ] as const;
    return levels.indexOf(maximumLevel ?? 'observe')
      >= levels.indexOf(requestedLevel);
  }

  function getCurrentTarget(
    targetId: string,
    generation: number,
  ): PublishedTarget {
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

  function minimumCapabilityLevel(
    left: CapabilityGrant['level'],
    right: CapabilityGrant['level'],
  ): NonNullable<CapabilityGrant['level']> {
    const levels = [
      'observe',
      'inspect',
      'interact',
      'debug',
      'unsafe',
    ] as const;
    const leftIndex = levels.indexOf(left ?? 'observe');
    const rightIndex = levels.indexOf(right ?? 'observe');
    return levels[Math.min(leftIndex, rightIndex)]!;
  }

  function maximumCapabilityLevel(
    left: CapabilityGrant['level'],
    right: CapabilityGrant['level'],
  ): NonNullable<CapabilityGrant['level']> {
    const levels = [
      'observe',
      'inspect',
      'interact',
      'debug',
      'unsafe',
    ] as const;
    const leftIndex = levels.indexOf(left ?? 'observe');
    const rightIndex = levels.indexOf(right ?? 'observe');
    return levels[Math.max(leftIndex, rightIndex)]!;
  }

  function combinedTargetGrant(
    authority: ClientAuthority,
    targetId: string,
    targetGeneration: number,
  ): ClientTargetGrant | undefined {
    const matchingGrants = authority.targetGrants?.filter(
      candidate => candidate.targetId === targetId && candidate.targetGeneration === targetGeneration,
    );
    if (matchingGrants === undefined || matchingGrants.length === 0)
      return undefined;
    const capabilities = matchingGrants.reduce<CapabilityGrant>(
      (combined, grant) => ({
        allow: [...new Set([
          ...(combined.allow ?? []),
          ...(grant.capabilities.allow ?? []),
        ])].sort(),
        level: maximumCapabilityLevel(
          combined.level,
          grant.capabilities.level,
        ),
      }),
      { level: 'observe' },
    );
    return {
      bindingId: matchingGrants.map(grant => grant.bindingId).sort().join('+'),
      capabilities: {
        ...(capabilities.allow?.length === 0 ? {} : { allow: capabilities.allow }),
        level: capabilities.level,
      },
      targetGeneration,
      targetId,
    };
  }

  function intersectCapabilities(
    targetCapabilities: CapabilityGrant,
    grantedCapabilities: CapabilityGrant,
  ): CapabilityGrant {
    const targetAllowed = new Set(targetCapabilities.allow ?? []);
    const allow = (grantedCapabilities.allow ?? []).filter(method =>
      targetAllowed.has(method),
    );
    return {
      level: minimumCapabilityLevel(
        targetCapabilities.level,
        grantedCapabilities.level,
      ),
      ...(allow.length === 0 ? {} : { allow }),
    };
  }

  function getAuthorizedTarget(
    targetId: string,
    generation: number,
    authority: ClientAuthority,
  ): PublishedTarget {
    if (authority.authorityAvailable === false) {
      recordDiagnostic('CAPABILITY_DENIED');
      throw new TargetBrokerError('CAPABILITY_DENIED', {
        details: { reason: 'authority-store-unavailable' },
        message: 'The authority store is temporarily unavailable.',
        retryable: true,
      });
    }
    const target = getCurrentTarget(targetId, generation);
    if (authority.targetGrants === undefined) return target;
    const grant = combinedTargetGrant(authority, targetId, generation);
    if (grant === undefined) {
      recordDiagnostic('CAPABILITY_DENIED');
      throw new TargetBrokerError('CAPABILITY_DENIED');
    }
    return {
      ...target,
      capabilities: intersectCapabilities(
        target.capabilities,
        grant.capabilities,
      ),
    };
  }

  function assertAgentOwnsTarget(
    targetId: string,
    authority: AgentAuthority,
  ): void {
    const ownerPrincipalId = targetAgentPrincipalIdsById.get(targetId);
    if (
      ownerPrincipalId !== undefined
      && ownerPrincipalId !== authority.principalId
    ) {
      recordDiagnostic('CAPABILITY_DENIED');
      throw new TargetBrokerError('CAPABILITY_DENIED');
    }
  }

  function eventMatchesSubscription(
    request: CdpSubscriptionRequest,
    method: string,
    parameters: JsonObject,
    sessionId: string | undefined,
  ): boolean {
    const matches
      = 'domain' in request.match
        ? method.startsWith(`${request.match.domain}.`)
        : 'method' in request.match
          ? method === request.match.method
          : method.startsWith(request.match.methodPrefix);
    if (
      !matches
      || (request.sessionId !== undefined && request.sessionId !== sessionId)
    )
      return false;
    if (request.predicate === undefined) return true;
    let value: JsonValue | undefined = parameters;
    for (const segment of request.predicate.path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
      value = value[segment];
    }
    return JSON.stringify(value) === JSON.stringify(request.predicate.equals);
  }

  function getSubscriptionDemand(request: CdpSubscriptionRequest): string {
    if ('method' in request.match) return request.match.method;
    if ('domain' in request.match) return `${request.match.domain}.`;
    return request.match.methodPrefix;
  }

  function getAuthorizedSubscriptionMethods(
    request: CdpSubscriptionRequest,
    lease: Lease,
    target: PublishedTarget,
  ): ReadonlySet<string> {
    const matches = (method: string): boolean =>
      'method' in request.match
        ? method === request.match.method
        : 'domain' in request.match
          ? method.startsWith(`${request.match.domain}.`)
          : method.startsWith(request.match.methodPrefix);
    const methods = lease.methods.filter(
      method =>
        matches(method)
        && isCdpNameAllowed(target.capabilities, method, 'event')
        && (lease.mode !== 'shared-read'
          || requiredLeaseMode(target.capabilities, [method])
          !== 'exclusive-control')
        && ('method' in request.match || isKnownCdpEventName(method)),
    );
    if (methods.length === 0) throw new TargetBrokerError('CAPABILITY_DENIED');
    return new Set(methods);
  }

  function getDomainDemandKey(
    target: Pick<PublishedTarget, 'generation' | 'id'>,
    demand: string,
    sessionId?: string,
  ): string {
    return `${getTargetKey(target.id, target.generation)}:${sessionId ?? 'root'}:${demand}`;
  }

  function hasStatefulSubscriptionDemand(demand: string): boolean {
    return statefulSubscriptionDomains.has(demand.split('.', 1)[0] ?? '');
  }

  function incrementDomainDemand(
    target: PublishedTarget,
    demand: string,
    sessionId?: string,
  ): Promise<void> | undefined {
    const demandKey = getDomainDemandKey(target, demand, sessionId);
    const count = domainDemandCountsByKey.get(demandKey) ?? 0;
    domainDemandCountsByKey.set(demandKey, count + 1);
    if (count !== 0) return undefined;
    const executor = executorsByTargetKey.get(
      getTargetKey(target.id, target.generation),
    );
    const setup
      = sessionId === undefined
        ? executor?.setSubscriptionDemand?.(demand, true)
        : executor?.setSubscriptionDemand?.(demand, true, sessionId);
    if (setup === undefined) return undefined;
    return setup.catch((error: unknown) => {
      domainDemandCountsByKey.delete(demandKey);
      throw new TargetBrokerError('CDP_COMMAND_FAILED', {
        ...(error instanceof Error ? { message: error.message } : {}),
      });
    });
  }

  function decrementDomainDemand(
    target: PublishedTarget,
    demand: string,
    sessionId?: string,
  ): void {
    const demandKey = getDomainDemandKey(target, demand, sessionId);
    const count = domainDemandCountsByKey.get(demandKey) ?? 0;
    if (count <= 1) {
      domainDemandCountsByKey.delete(demandKey);
      const executor = executorsByTargetKey.get(
        getTargetKey(target.id, target.generation),
      );
      const setup
        = sessionId === undefined
          ? executor?.setSubscriptionDemand?.(demand, false)
          : executor?.setSubscriptionDemand?.(demand, false, sessionId);
      void setup?.catch(() => {});
    } else domainDemandCountsByKey.set(demandKey, count - 1);
  }

  function ensureLeaseDomainDemand(
    target: PublishedTarget,
    lease: Lease,
    method: string,
    sessionId?: string,
  ): Promise<void> | undefined {
    const domain = method.split('.', 1)[0];
    if (domain === undefined || !lifecycleManagedDomains.has(domain))
      return undefined;
    const demand = `${domain}.`;
    const demandKey = `${sessionId ?? 'root'}:${demand}`;
    const existingDemands = leaseDomainDemandsByLeaseId.get(lease.id);
    const existingDemand = existingDemands?.get(demandKey);
    if (existingDemand !== undefined) return existingDemand.activation;
    const demands = existingDemands ?? new Map<string, LeaseDomainDemand>();
    leaseDomainDemandsByLeaseId.set(lease.id, demands);
    const domainActivation = incrementDomainDemand(target, demand, sessionId);
    const activation = domainActivation?.catch((error: unknown) => {
      demands.delete(demandKey);
      if (demands.size === 0) leaseDomainDemandsByLeaseId.delete(lease.id);
      throw error;
    });
    demands.set(demandKey, {
      activation,
      demand,
      ...(sessionId === undefined ? {} : { sessionId }),
      target,
    });
    return activation;
  }

  function releaseLeaseDomainDemands(leaseId: string): void {
    const demands = leaseDomainDemandsByLeaseId.get(leaseId);
    if (demands === undefined) return;
    leaseDomainDemandsByLeaseId.delete(leaseId);
    for (const demand of demands.values()) {
      if (demand.activation === undefined) {
        decrementDomainDemand(demand.target, demand.demand, demand.sessionId);
      } else {
        void demand.activation
          .then(() =>
            decrementDomainDemand(
              demand.target,
              demand.demand,
              demand.sessionId,
            ),
          )
          .catch(() => {});
      }
    }
  }

  function releaseAutomationResources(
    agentPrincipalId: string,
    target?: Pick<PublishedTarget, 'generation' | 'id'>,
  ): void {
    const targetKey
      = target === undefined
        ? undefined
        : getTargetKey(target.id, target.generation);
    for (const [handleId, handle] of automationElementHandlesById) {
      if (
        handle.agentPrincipalId === agentPrincipalId
        && (target === undefined
          || (handle.targetId === target.id
            && handle.generation === target.generation))
      )
        automationElementHandlesById.delete(handleId);
    }
    for (const [listenerTargetKey, listeners] of automationEventListenersByTargetKey) {
      if (targetKey !== undefined && listenerTargetKey !== targetKey) continue;
      for (const listener of listeners)
        if (listener.agentPrincipalId === agentPrincipalId)
          listeners.delete(listener);
      if (listeners.size === 0)
        automationEventListenersByTargetKey.delete(listenerTargetKey);
    }
    for (const [demandKey, demand] of automationDomainDemandsByKey) {
      if (
        demand.agentPrincipalId !== agentPrincipalId
        || (targetKey !== undefined
          && getTargetKey(demand.target.id, demand.target.generation)
          !== targetKey)
      )
        continue;
      automationDomainDemandsByKey.delete(demandKey);
      decrementDomainDemand(
        demand.target,
        demand.demand,
        demand.sessionId,
      );
    }
  }

  function providerOperation(
    operation: AutomationOperation,
    authority: ClientAuthority,
    target: PublishedTarget,
    agentPrincipalId: string,
    provider: AutomationProvider,
  ): AutomationOperation {
    const resolveHandle = (handleId: string | undefined): string | undefined => {
      if (handleId === undefined) return undefined;
      const handle = automationElementHandlesById.get(handleId);
      if (
        handle === undefined
        || handle.agentPrincipalId !== agentPrincipalId
        || handle.generation !== target.generation
        || handle.principalId !== authority.principalId
        || handle.providerId !== provider.descriptor.id
        || handle.targetId !== target.id
      ) {
        throw new TargetBrokerError('TARGET_GENERATION_STALE', {
          message: 'The automation element handle is no longer valid.',
        });
      }
      return handle.opaqueHandle;
    };
    if (operation.kind !== 'action' && operation.kind !== 'inspect')
      return operation;
    if (operation.kind === 'inspect') {
      const elementHandleId = resolveHandle(operation.elementHandleId);
      return {
        ...operation,
        ...(elementHandleId === undefined ? {} : { elementHandleId }),
      };
    }
    const elementHandleId = resolveHandle(operation.elementHandleId);
    if (operation.action !== 'drag') {
      return {
        ...operation,
        ...(elementHandleId === undefined ? {} : { elementHandleId }),
      };
    }
    const destinationElementHandleId = resolveHandle(
      operation.destinationElementHandleId,
    );
    return {
      ...operation,
      ...(destinationElementHandleId === undefined
        ? {}
        : { destinationElementHandleId }),
      ...(elementHandleId === undefined ? {} : { elementHandleId }),
    };
  }

  function deleteLease(leaseId: string): void {
    const expiryTimeout = leaseExpiryTimeoutsById.get(leaseId);
    if (expiryTimeout !== undefined) clearTimeout(expiryTimeout);
    leaseExpiryTimeoutsById.delete(leaseId);
    releaseLeaseDomainDemands(leaseId);
    leasesById.delete(leaseId);
    leasePrincipalIdsById.delete(leaseId);
  }

  function scheduleLeaseExpiry(lease: Lease): void {
    const timeout = setTimeout(
      () => {
        if (leasesById.get(lease.id)?.expiresAt !== lease.expiresAt) return;
        deleteLease(lease.id);
        closeSubscriptionsUsingLease(lease.id);
      },
      Math.max(0, Date.parse(lease.expiresAt) - now()),
    );
    leaseExpiryTimeoutsById.set(lease.id, timeout);
  }

  function removeExpiredLeases(): void {
    for (const [leaseId, lease] of leasesById)
      if (Date.parse(lease.expiresAt) <= now()) deleteLease(leaseId);
  }

  function getActiveLease(
    request: Pick<
      RenewLeaseRequest,
      'leaseId' | 'targetGeneration' | 'targetId'
    >,
    authority: ClientAuthority,
  ): Lease {
    const lease = leasesById.get(request.leaseId);
    if (
      lease === undefined
      || leasePrincipalIdsById.get(request.leaseId) !== authority.principalId
      || lease.targetId !== request.targetId
      || lease.targetGeneration !== request.targetGeneration
    )
      throw new TargetBrokerError('LEASE_REQUIRED');
    if (Date.parse(lease.expiresAt) <= now()) {
      deleteLease(lease.id);
      closeSubscriptionsUsingLease(lease.id);
      throw new TargetBrokerError('LEASE_EXPIRED');
    }
    return lease;
  }

  function getArtifactAuthority(
    request: ArtifactAccessRequest,
    authority: ClientAuthority,
  ): ArtifactAuthority {
    getAuthorizedTarget(request.targetId, request.targetGeneration, authority);
    const lease = getActiveLease(request, authority);
    return {
      ownerId: lease.id,
      targetGeneration: request.targetGeneration,
      targetId: request.targetId,
    };
  }

  function closeSubscriptionsUsingLease(leaseId: string): void {
    for (const subscription of subscriptions.values())
      if (subscription.request.leaseId === leaseId) subscription.close();
  }

  return (targetBroker = {
    acquireLease(request, authority = localClientAuthority) {
      ensureActive();
      const target = getAuthorizedTarget(
        request.targetId,
        request.targetGeneration,
        authority,
      );
      const mode = request.mode ?? 'shared-read';
      if (
        !Number.isSafeInteger(request.durationMilliseconds)
        || request.durationMilliseconds < 1
        || (leaseMaximumDurationMilliseconds !== null
          && request.durationMilliseconds > leaseMaximumDurationMilliseconds)
        || request.requestedMethods.some(
          method =>
            !isCdpNameAllowed(target.capabilities, method, 'command')
            && !isCdpNameAllowed(target.capabilities, method, 'event'),
        )
      ) {
        recordDiagnostic('CAPABILITY_DENIED');
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      removeExpiredLeases();
      if (
        mode === 'shared-read'
        && requiredLeaseMode(target.capabilities, request.requestedMethods)
        === 'exclusive-control'
      ) {
        recordDiagnostic('CAPABILITY_DENIED');
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      const conflictingLease
        = mode === 'exclusive-control'
          ? [...leasesById.values()].find(
              lease =>
                lease.targetId === target.id
                && lease.targetGeneration === target.generation
                && lease.mode === 'exclusive-control',
            )
          : undefined;
      if (conflictingLease !== undefined) {
        recordDiagnostic('LEASE_CONFLICT');
        const controllerPrincipalId = leasePrincipalIdsById.get(
          conflictingLease.id,
        );
        const retryAfterMs = Math.max(
          0,
          Date.parse(conflictingLease.expiresAt) - now(),
        );
        throw new TargetBrokerError('LEASE_CONFLICT', {
          details: {
            controller: controllerPrincipalId ?? 'unknown',
            expiresAt: conflictingLease.expiresAt,
          },
          message:
            'Another client currently holds the exclusive controller lease.',
          retryAfterMs,
          retryable: true,
        });
      }
      const issuedAt = new Date(now()).toISOString();
      const maximumExpiry = leaseMaximumLifetimeMilliseconds === null
        ? undefined
        : now() + leaseMaximumLifetimeMilliseconds;
      const lease: Lease = {
        expiresAt: new Date(Math.min(
          now() + request.durationMilliseconds,
          maximumExpiry ?? Number.POSITIVE_INFINITY,
        )).toISOString(),
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
      if (cancellation?.connectionId === authority.connectionId)
        cancellation.abortController.abort();
    },
    cancelAutomation(operationId, authority = localClientAuthority) {
      targetBroker.cancelCommand(operationId, authority);
    },
    connectClient(authority) {
      ensureActive();
      connectedPrincipalIdsByConnectionId.set(
        authority.connectionId,
        authority.principalId,
      );
      const reconnectGraceTimeout = reconnectGraceTimeoutsByPrincipalId.get(
        authority.principalId,
      );
      if (reconnectGraceTimeout !== undefined) {
        clearTimeout(reconnectGraceTimeout);
        reconnectGraceTimeoutsByPrincipalId.delete(authority.principalId);
      }
    },
    disconnectClient(authority) {
      if (
        disposed
        || connectedPrincipalIdsByConnectionId.get(authority.connectionId)
        !== authority.principalId
      )
        return;
      connectedPrincipalIdsByConnectionId.delete(authority.connectionId);
      for (const cancellation of cancellationsByOperationId.values())
        if (cancellation.connectionId === authority.connectionId)
          cancellation.abortController.abort();
      for (const [
        subscriptionId,
        connectionId,
      ] of subscriptionConnectionIdsById)
        if (connectionId === authority.connectionId)
          subscriptions.get(subscriptionId)?.close();
      if (
        [...connectedPrincipalIdsByConnectionId.values()].includes(
          authority.principalId,
        )
      )
        return;
      const releasePrincipalLeases = (): void => {
        reconnectGraceTimeoutsByPrincipalId.delete(authority.principalId);
        if (
          [...connectedPrincipalIdsByConnectionId.values()].includes(
            authority.principalId,
          )
        )
          return;
        for (const [leaseId, principalId] of leasePrincipalIdsById)
          if (principalId === authority.principalId) deleteLease(leaseId);
      };
      if (reconnectGraceMilliseconds === 0) releasePrincipalLeases();
      else if (reconnectGraceMilliseconds !== null)
        reconnectGraceTimeoutsByPrincipalId.set(
          authority.principalId,
          setTimeout(releasePrincipalLeases, reconnectGraceMilliseconds),
        );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancellation of cancellationsByOperationId.values())
        cancellation.abortController.abort();
      cancellationsByOperationId.clear();
      commandOperationIdsByTargetKey.clear();
      for (const subscription of subscriptions.values()) subscription.close();
      subscriptions.clear();
      for (const leaseId of leasesById.keys())
        releaseLeaseDomainDemands(leaseId);
      for (const target of targetsById.values())
        artifactStore.revokeTarget(target.id, target.generation);
      for (const [agentPrincipalId, provider] of automationProvidersByAgentPrincipalId) {
        releaseAutomationResources(agentPrincipalId);
        void Promise.resolve(provider.dispose()).catch(() => {});
      }
      automationProvidersByAgentPrincipalId.clear();
      automationElementHandlesById.clear();
      automationEventListenersByTargetKey.clear();
      automationDomainDemandsByKey.clear();
      targetsById.clear();
      executorsByTargetKey.clear();
      leasesById.clear();
      leasePrincipalIdsById.clear();
      for (const expiryTimeout of leaseExpiryTimeoutsById.values())
        clearTimeout(expiryTimeout);
      leaseExpiryTimeoutsById.clear();
      for (const reconnectGraceTimeout of reconnectGraceTimeoutsByPrincipalId.values())
        clearTimeout(reconnectGraceTimeout);
      reconnectGraceTimeoutsByPrincipalId.clear();
      connectedPrincipalIdsByConnectionId.clear();
      domainDemandCountsByKey.clear();
      for (const watcher of targetWatchers) watcher.close();
      targetWatchers.clear();
    },
    async executeCommand(command, authority = localClientAuthority) {
      ensureActive();
      const target = getAuthorizedTarget(
        command.targetId,
        command.targetGeneration,
        authority,
      );
      let lease: Lease;
      try {
        lease = getActiveLease(command, authority);
      } catch (error) {
        if (
          error instanceof TargetBrokerError
          && error.code !== 'FEATURE_UNSUPPORTED'
        )
          recordDiagnostic(error.code);
        else recordDiagnostic('LEASE_REQUIRED');
        throw error;
      }
      if (
        !lease.methods.includes(command.method)
        || !isCdpNameAllowed(target.capabilities, command.method, 'command')
        || (lease.mode === 'shared-read'
          && requiredLeaseMode(target.capabilities, [command.method])
          === 'exclusive-control')
      ) {
        recordDiagnostic('CAPABILITY_DENIED');
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      const executor = executorsByTargetKey.get(
        getTargetKey(target.id, target.generation),
      );
      if (executor === undefined) {
        recordDiagnostic('TARGET_NOT_FOUND');
        throw new TargetBrokerError('TARGET_NOT_FOUND');
      }
      const abortController = new AbortController();
      cancellationsByOperationId.set(command.operationId, {
        abortController,
        connectionId: authority.connectionId,
        leaseId: lease.id,
      });
      const targetKey = getTargetKey(target.id, target.generation);
      const operationIds
        = commandOperationIdsByTargetKey.get(targetKey) ?? new Set<string>();
      operationIds.add(command.operationId);
      commandOperationIdsByTargetKey.set(targetKey, operationIds);
      const timeout = scheduleTimeout(
        () => abortController.abort(),
        commandTimeoutMilliseconds,
      );
      try {
        const domainActivation = ensureLeaseDomainDemand(
          target,
          lease,
          command.method,
          command.sessionId,
        );
        if (domainActivation !== undefined) await domainActivation;
        const value = await executor.execute(
          command,
          abortController.signal,
          lease,
        );
        if (abortController.signal.aborted) {
          recordDiagnostic('REQUEST_CANCELLED');
          throw new TargetBrokerError('REQUEST_CANCELLED');
        }
        const externalizedValue = await externalizeJsonResult(value, {
          expiresAt: artifactLifetimeMilliseconds === null
            ? new Date(8.64e15).toISOString()
            : new Date(now() + artifactLifetimeMilliseconds).toISOString(),
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
        const executorError = targetExecutorError(error);
        if (executorError !== undefined) {
          if (executorError.code !== 'FEATURE_UNSUPPORTED')
            recordDiagnostic(executorError.code);
          throw executorError;
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
        if (timeout !== undefined) clearTimeout(timeout);
        cancellationsByOperationId.delete(command.operationId);
        operationIds.delete(command.operationId);
        if (operationIds.size === 0)
          commandOperationIdsByTargetKey.delete(targetKey);
      }
    },
    async executeAutomation(request, authority = localClientAuthority) {
      ensureActive();
      const totalStartedAt = globalThis.performance.now();
      const target = getAuthorizedTarget(
        request.targetId,
        request.targetGeneration,
        authority,
      );
      const authorityBindingId = combinedTargetGrant(
        authority,
        target.id,
        target.generation,
      )?.bindingId ?? 'trusted-in-process';
      const lease = getActiveLease(request, authority);
      const requiredLevel = requiredAutomationLevel(request.operation);
      if (
        !capabilityLevelAllows(target.capabilities.level, requiredLevel)
        || (requiredLevel === 'interact'
          && lease.mode !== 'exclusive-control')
      ) {
        recordDiagnostic('CAPABILITY_DENIED');
        throw new TargetBrokerError('CAPABILITY_DENIED');
      }
      const agentPrincipalId = targetAgentPrincipalIdsById.get(target.id);
      if (agentPrincipalId === undefined)
        throw new TargetBrokerError('TARGET_NOT_FOUND');
      const provider
        = automationProvidersByAgentPrincipalId.get(agentPrincipalId);
      if (provider === undefined) {
        throw new TargetBrokerError('FEATURE_UNSUPPORTED', {
          message: 'No automation provider is registered for this target.',
        });
      }
      if (
        !provider.descriptor.capabilities.operations.includes(
          request.operation.kind,
        )
        || (request.operation.kind === 'snapshot'
          && !provider.descriptor.capabilities.snapshotModes.includes(
            request.operation.mode,
          ))
          || (request.operation.kind === 'action'
            && !provider.descriptor.capabilities.actions.includes(
              request.operation.action,
            ))
      ) {
        throw new TargetBrokerError('FEATURE_UNSUPPORTED', {
          message: `Automation provider "${provider.descriptor.id}" does not support this operation.`,
        });
      }
      const executor = executorsByTargetKey.get(
        getTargetKey(target.id, target.generation),
      );
      if (executor === undefined)
        throw new TargetBrokerError('TARGET_NOT_FOUND');
      const operation = providerOperation(
        request.operation,
        authority,
        target,
        agentPrincipalId,
        provider,
      );
      const abortController = new AbortController();
      cancellationsByOperationId.set(request.operationId, {
        abortController,
        connectionId: authority.connectionId,
        leaseId: lease.id,
      });
      const targetKey = getTargetKey(target.id, target.generation);
      const operationIds
        = commandOperationIdsByTargetKey.get(targetKey) ?? new Set<string>();
      operationIds.add(request.operationId);
      commandOperationIdsByTargetKey.set(targetKey, operationIds);
      const timeout = scheduleTimeout(
        () => abortController.abort(),
        commandTimeoutMilliseconds,
      );
      let cdbTransportDurationMilliseconds = 0;
      let cdpCommandCount = 0;
      let chromeDurationMilliseconds = 0;
      const listenerRecords = automationEventListenersByTargetKey.get(
        targetKey,
      ) ?? new Set<{
        readonly agentPrincipalId: string;
        readonly listener: (event: AutomationCdpEvent) => void;
      }>();
      automationEventListenersByTargetKey.set(targetKey, listenerRecords);
      const context = {
        abortSignal: abortController.signal,
        authorityBindingId,
        connectionId: authority.connectionId,
        leaseId: lease.id,
        ...(authority.logicalSessionId === undefined ? {} : { logicalSessionId: authority.logicalSessionId }),
        principalId: authority.principalId,
        target,
        async executeCdp(
          method: string,
          parameters: JsonObject = {},
          sessionId?: string,
        ): Promise<JsonObject> {
          if (abortController.signal.aborted)
            throw new TargetBrokerError('REQUEST_CANCELLED');
          if (
            method === 'Browser.close'
            || method === 'Target.attachToBrowserTarget'
            || method === 'Target.attachToTarget'
            || method === 'Target.closeTarget'
            || method === 'Target.createTarget'
            || method === 'Target.detachFromTarget'
          ) {
            throw new TargetBrokerError('CAPABILITY_DENIED', {
              message: `Automation providers cannot execute ${method}.`,
            });
          }
          const transportStartedAt = globalThis.performance.now();
          const [domain, commandName] = method.split('.', 2);
          if (
            domain !== undefined
            && (commandName === 'enable' || commandName === 'disable')
          ) {
            await context.setDomainDemand(
              domain,
              commandName === 'enable',
              sessionId,
            );
            cdbTransportDurationMilliseconds
              += globalThis.performance.now() - transportStartedAt;
            return {};
          }
          cdpCommandCount += 1;
          const chromeStartedAt = globalThis.performance.now();
          try {
            const executorLease: Lease = {
              ...lease,
              methods: [method],
            };
            return await executor.execute(
              {
                leaseId: lease.id,
                method,
                operationId: generateId(),
                parameters,
                ...(sessionId === undefined ? {} : { sessionId }),
                targetGeneration: target.generation,
                targetId: target.id,
              },
              abortController.signal,
              executorLease,
            );
          } finally {
            const commandDuration
              = globalThis.performance.now() - chromeStartedAt;
            chromeDurationMilliseconds += commandDuration;
            cdbTransportDurationMilliseconds
              += globalThis.performance.now()
                - transportStartedAt
                - commandDuration;
          }
        },
        onCdpEvent(listener: (event: AutomationCdpEvent) => void): () => void {
          const record = { agentPrincipalId, listener };
          listenerRecords.add(record);
          return () => listenerRecords.delete(record);
        },
        async setDomainDemand(
          domain: string,
          active: boolean,
          sessionId?: string,
        ): Promise<void> {
          if (!cdpDomainNamePattern.test(domain))
            throw new TargetBrokerError('CAPABILITY_DENIED');
          const demand = `${domain}.`;
          const demandKey = `${agentPrincipalId}:${provider.descriptor.id}:${authority.principalId}:${targetKey}:${sessionId ?? 'root'}:${demand}`;
          const currentDemand = automationDomainDemandsByKey.get(demandKey);
          if (active) {
            if (currentDemand !== undefined) return;
            await incrementDomainDemand(target, demand, sessionId);
            automationDomainDemandsByKey.set(demandKey, {
              agentPrincipalId,
              demand,
              ...(sessionId === undefined ? {} : { sessionId }),
              target,
            });
          } else if (currentDemand !== undefined) {
            automationDomainDemandsByKey.delete(demandKey);
            decrementDomainDemand(target, demand, sessionId);
          }
        },
      };
      try {
        const providerStartedAt = globalThis.performance.now();
        const result = await provider.execute(
          { operation, operationId: request.operationId },
          context,
        );
        const providerDurationMilliseconds
          = globalThis.performance.now() - providerStartedAt;
        if (abortController.signal.aborted)
          throw new TargetBrokerError('REQUEST_CANCELLED');
        const elements: AutomationElementHandle[] | undefined
          = result.elements?.map((element) => {
            const id = generateId();
            automationElementHandlesById.set(id, {
              agentPrincipalId,
              generation: target.generation,
              opaqueHandle: element.handle,
              principalId: authority.principalId,
              providerId: provider.descriptor.id,
              ...(result.snapshotId === undefined
                ? {}
                : { snapshotId: result.snapshotId }),
              targetId: target.id,
            });
            return {
              id,
              ...(element.metadata === undefined
                ? {}
                : { metadata: element.metadata }),
            };
          });
        return {
          ...(elements === undefined ? {} : { elements }),
          metrics: {
            cdbTransportDurationMilliseconds,
            cdpCommandCount,
            chromeDurationMilliseconds,
            providerDurationMilliseconds,
            totalDurationMilliseconds:
              globalThis.performance.now() - totalStartedAt,
          },
          operationId: request.operationId,
          provider: provider.descriptor,
          ...(result.snapshotId === undefined
            ? {}
            : { snapshotId: result.snapshotId }),
          value: result.value,
        };
      } catch (error) {
        if (error instanceof TargetBrokerError) throw error;
        if (abortController.signal.aborted)
          throw new TargetBrokerError('REQUEST_CANCELLED');
        if (error instanceof AutomationProviderError) {
          throw new TargetBrokerError('CDP_COMMAND_FAILED', {
            details: {
              automationCode: error.code,
              ...(error.details ?? {}),
              providerId: provider.descriptor.id,
            },
            message: error.message,
            retryable: error.retryable,
          });
        }
        throw new TargetBrokerError('CDP_COMMAND_FAILED', {
          ...(error instanceof Error ? { message: error.message } : {}),
        });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        cancellationsByOperationId.delete(request.operationId);
        operationIds.delete(request.operationId);
        if (operationIds.size === 0)
          commandOperationIdsByTargetKey.delete(targetKey);
      }
    },
    getTargetAgentPrincipalId(targetId) {
      ensureActive();
      return targetAgentPrincipalIdsById.get(targetId);
    },
    listLeases(authority = localClientAuthority) {
      ensureActive();
      if (authority.authorityAvailable === false) return [];
      return [...leasesById.values()].flatMap((lease) => {
        const principalId = leasePrincipalIdsById.get(lease.id);
        return principalId === undefined || (authority !== localClientAuthority && principalId !== authority.principalId)
          ? []
          : [structuredClone({ ...lease, principalId })];
      });
    },
    listTargets(authority = localClientAuthority) {
      ensureActive();
      if (authority.targetGrants === undefined)
        return [...targetsById.values()];
      return [...targetsById.values()].flatMap((target) => {
        if (authority.authorityAvailable === false) {
          throw new TargetBrokerError('CAPABILITY_DENIED', {
            details: { reason: 'authority-store-unavailable' },
            message: 'The authority store is temporarily unavailable.',
            retryable: true,
          });
        }
        const grant = combinedTargetGrant(authority, target.id, target.generation);
        return grant === undefined
          ? []
          : [
              {
                ...target,
                capabilities: intersectCapabilities(
                  target.capabilities,
                  grant.capabilities,
                ),
              },
            ];
      });
    },
    publishTarget(target, authority = localAgentAuthority) {
      ensureActive();
      ensureCurrentAgentConnection(authority);
      assertAgentOwnsTarget(target.id, authority);
      const highestGeneration = highestGenerationByTargetId.get(target.id);
      if (
        highestGeneration !== undefined
        && target.generation <= highestGeneration
      ) {
        throw new TargetBrokerError('TARGET_GENERATION_STALE');
      }
      targetsById.set(target.id, target);
      targetAgentPrincipalIdsById.set(target.id, authority.principalId);
      highestGenerationByTargetId.set(target.id, target.generation);
      publishTargetChange({ kind: 'published', target });
    },
    registerAutomationProvider(provider, authority = localAgentAuthority) {
      ensureActive();
      ensureCurrentAgentConnection(authority);
      const existing = automationProvidersByAgentPrincipalId.get(
        authority.principalId,
      );
      if (existing === provider) return;
      if (existing !== undefined) {
        releaseAutomationResources(authority.principalId);
        void Promise.resolve(existing.dispose()).catch(() => {});
      }
      automationProvidersByAgentPrincipalId.set(
        authority.principalId,
        provider,
      );
    },
    registerTargetExecutor(target, executor, authority = localAgentAuthority) {
      ensureActive();
      ensureCurrentAgentConnection(authority);
      assertAgentOwnsTarget(target.id, authority);
      executorsByTargetKey.set(
        getTargetKey(target.id, target.generation),
        executor,
      );
    },
    reconcileTargets(targets, authority = localAgentAuthority) {
      ensureActive();
      ensureCurrentAgentConnection(authority);
      const targetIds = new Set(targets.map(target => target.id));
      for (const target of [...targetsById.values()]) {
        if (
          targetAgentPrincipalIdsById.get(target.id)
          === authority.principalId
          && !targetIds.has(target.id)
        ) {
          targetBroker.revokeTarget(
            target.id,
            target.generation,
            'detached',
            authority,
          );
        }
      }
      for (const target of targets) {
        assertAgentOwnsTarget(target.id, authority);
        const currentTarget = targetsById.get(target.id);
        if (currentTarget === undefined)
          targetBroker.publishTarget(target, authority);
        else if (currentTarget.generation === target.generation)
          targetBroker.updateTarget(target, authority);
        else if (currentTarget.generation < target.generation) {
          targetBroker.revokeTarget(
            currentTarget.id,
            currentTarget.generation,
            'detached',
            authority,
          );
          targetBroker.publishTarget(target, authority);
        }
      }
    },
    refreshClientAuthority(authority) {
      if (disposed) return;
      for (const [leaseId, principalId] of leasePrincipalIdsById) {
        if (principalId !== authority.principalId) continue;
        const lease = leasesById.get(leaseId);
        const target = lease === undefined ? undefined : targetsById.get(lease.targetId);
        const grant = lease === undefined || authority.targetGrants === undefined
          ? undefined
          : combinedTargetGrant(authority, lease.targetId, lease.targetGeneration);
        const effectiveCapabilities = target === undefined
          ? undefined
          : grant === undefined && authority.targetGrants === undefined
            ? target.capabilities
            : grant === undefined
              ? undefined
              : intersectCapabilities(target.capabilities, grant.capabilities);
        if (
          lease !== undefined
          && (authority.authorityAvailable === false
            || target?.generation !== lease.targetGeneration
            || effectiveCapabilities === undefined
            || lease.methods.some(method => (
              !isCdpNameAllowed(effectiveCapabilities, method, 'command')
              && !isCdpNameAllowed(effectiveCapabilities, method, 'event')
            ))
            || (lease.mode === 'shared-read'
              && requiredLeaseMode(effectiveCapabilities, lease.methods) === 'exclusive-control'))
        ) {
          deleteLease(leaseId);
          closeSubscriptionsUsingLease(leaseId);
        }
      }
      for (const cancellation of cancellationsByOperationId.values()) {
        if (cancellation.connectionId === authority.connectionId && !leasesById.has(cancellation.leaseId))
          cancellation.abortController.abort();
      }
      publishTargetChange({ kind: 'snapshot', targets: [...targetsById.values()] });
    },
    revokeAgentTargets(authority, reason = 'detached') {
      ensureActive();
      if (!isCurrentAgentConnection(authority)) return;
      for (const target of [...targetsById.values()]) {
        if (
          targetAgentPrincipalIdsById.get(target.id) === authority.principalId
        ) {
          targetBroker.revokeTarget(
            target.id,
            target.generation,
            reason,
            authority,
          );
        }
      }
    },
    revokeTarget(targetId, generation, reason = 'explicit', authority) {
      ensureActive();
      if (authority !== undefined) {
        ensureCurrentAgentConnection(authority);
        assertAgentOwnsTarget(targetId, authority);
      }
      const target = targetsById.get(targetId);
      if (target?.generation === generation) {
        recordDiagnostic('TARGET_REVOKED');
        const agentPrincipalId = targetAgentPrincipalIdsById.get(targetId);
        targetsById.delete(targetId);
        targetAgentPrincipalIdsById.delete(targetId);
        if (agentPrincipalId !== undefined) {
          const provider = automationProvidersByAgentPrincipalId.get(
            agentPrincipalId,
          );
          releaseAutomationResources(agentPrincipalId, target);
          void Promise.resolve(provider?.invalidateTarget?.(target)).catch(
            () => {},
          );
        }
        for (const operationId of commandOperationIdsByTargetKey.get(
          getTargetKey(targetId, generation),
        ) ?? [])
          cancellationsByOperationId.get(operationId)?.abortController.abort();
        for (const [leaseId, lease] of leasesById) {
          if (
            lease.targetId === targetId
            && lease.targetGeneration === generation
          ) {
            deleteLease(leaseId);
          }
        }
        for (const subscription of subscriptions.values())
          if (
            subscription.request.targetId === targetId
            && subscription.request.targetGeneration === generation
          )
            subscription.close();
        executorsByTargetKey.delete(getTargetKey(targetId, generation));
        artifactStore.revokeTarget(targetId, generation);
        for (const demandKey of domainDemandCountsByKey.keys())
          if (demandKey.startsWith(`${getTargetKey(targetId, generation)}:`))
            domainDemandCountsByKey.delete(demandKey);
        publishTargetChange({
          kind: 'revoked',
          reason,
          targetGeneration: generation,
          targetId,
        });
      }
    },
    updateTarget(target, authority = localAgentAuthority) {
      ensureActive();
      ensureCurrentAgentConnection(authority);
      assertAgentOwnsTarget(target.id, authority);
      const currentTarget = getCurrentTarget(target.id, target.generation);
      targetsById.set(target.id, target);
      highestGenerationByTargetId.set(target.id, currentTarget.generation);
      for (const [leaseId, lease] of leasesById) {
        if (
          lease.targetId === target.id
          && lease.targetGeneration === target.generation
          && lease.methods.some(
            method =>
              !isCdpNameAllowed(target.capabilities, method, 'command')
              && !isCdpNameAllowed(target.capabilities, method, 'event'),
          )
        ) {
          deleteLease(leaseId);
          closeSubscriptionsUsingLease(leaseId);
        }
      }
      publishTargetChange({ kind: 'updated', target });
    },
    watchTargets(authority = localClientAuthority) {
      ensureActive();
      const changes: TargetChange[] = [
        {
          kind: 'snapshot',
          sequence: targetChangeSequence,
          targets: [...targetBroker.listTargets(authority)],
        },
      ];
      let resolver:
        ((result: IteratorResult<TargetChange>) => void) | undefined;
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
            authorizedChange = {
              ...change,
              targets: change.targets.flatMap((target) => {
                const grant = combinedTargetGrant(authority, target.id, target.generation);
                if (authority.targetGrants !== undefined && grant === undefined)
                  return [];
                return grant === undefined
                  ? [target]
                  : [
                      {
                        ...target,
                        capabilities: intersectCapabilities(
                          target.capabilities,
                          grant.capabilities,
                        ),
                      },
                    ];
              }),
            };
          } else if (change.kind === 'published' || change.kind === 'updated') {
            const grant = combinedTargetGrant(authority, change.target.id, change.target.generation);
            if (authority.targetGrants !== undefined && grant === undefined)
              return;
            authorizedChange
              = grant === undefined
                ? change
                : {
                    ...change,
                    target: {
                      ...change.target,
                      capabilities: intersectCapabilities(
                        change.target.capabilities,
                        grant.capabilities,
                      ),
                    },
                  };
          } else {
            if (
              authority.targetGrants !== undefined
              && !authority.targetGrants.some(
                candidate => candidate.targetId === change.targetId
                  && candidate.targetGeneration === change.targetGeneration,
              )
            )
              return;
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
              return new Promise(resolve => (resolver = resolve));
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
      if (!isCdpNameAllowed(publishedTarget.capabilities, method, 'event'))
        return;
      for (const subscription of subscriptions.values())
        if (
          subscription.request.targetId === target.id
          && subscription.request.targetGeneration === target.generation
        )
          subscription.offer(method, parameters, sessionId);
      const event: AutomationCdpEvent = {
        method,
        parameters,
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      for (const listener of automationEventListenersByTargetKey.get(
        getTargetKey(target.id, target.generation),
      ) ?? []) {
        try {
          listener.listener(event);
        } catch {
          /** A provider event listener cannot interrupt broker event delivery. */
        }
      }
    },
    releaseLease(request, authority = localClientAuthority) {
      ensureActive();
      getAuthorizedTarget(
        request.targetId,
        request.targetGeneration,
        authority,
      );
      const lease = getActiveLease(request, authority);
      deleteLease(lease.id);
      closeSubscriptionsUsingLease(lease.id);
    },
    readArtifact(request, authority = localClientAuthority) {
      ensureActive();
      return artifactStore.read(
        request.artifactId,
        getArtifactAuthority(request, authority),
        request.range,
      );
    },
    releaseArtifact(request, authority = localClientAuthority) {
      ensureActive();
      artifactStore.release(
        request.artifactId,
        getArtifactAuthority(request, authority),
      );
    },
    renewLease(request, authority = localClientAuthority) {
      ensureActive();
      getAuthorizedTarget(
        request.targetId,
        request.targetGeneration,
        authority,
      );
      if (
        !Number.isSafeInteger(request.durationMilliseconds)
        || request.durationMilliseconds < 1
        || (leaseMaximumDurationMilliseconds !== null
          && request.durationMilliseconds > leaseMaximumDurationMilliseconds)
      )
        throw new TargetBrokerError('CAPABILITY_DENIED');
      const lease = getActiveLease(request, authority);
      const maximumExpiry = leaseMaximumLifetimeMilliseconds === null
        ? undefined
        : Date.parse(lease.issuedAt) + leaseMaximumLifetimeMilliseconds;
      if (maximumExpiry !== undefined && maximumExpiry <= now()) {
        deleteLease(lease.id);
        closeSubscriptionsUsingLease(lease.id);
        throw new TargetBrokerError('LEASE_EXPIRED');
      }
      const renewedLease: Lease = {
        ...lease,
        expiresAt: new Date(Math.min(
          now() + request.durationMilliseconds,
          maximumExpiry ?? Number.POSITIVE_INFINITY,
        )).toISOString(),
      };
      leasesById.set(lease.id, renewedLease);
      const previousExpiryTimeout = leaseExpiryTimeoutsById.get(lease.id);
      if (previousExpiryTimeout !== undefined)
        clearTimeout(previousExpiryTimeout);
      scheduleLeaseExpiry(renewedLease);
      return renewedLease;
    },
    async subscribe(request, authority = localClientAuthority) {
      ensureActive();
      const target = getAuthorizedTarget(
        request.targetId,
        request.targetGeneration,
        authority,
      );
      const lease = getActiveLease(request, authority);
      const authorizedMethods = getAuthorizedSubscriptionMethods(
        request,
        lease,
        target,
      );
      const demand = getSubscriptionDemand(request);
      if (
        (request.batch !== undefined
          && request.batch.maximumEvents > request.buffer.capacity)
        || (hasStatefulSubscriptionDemand(demand) && request.buffer.capacity > 16)
      )
        throw new TargetBrokerError('CAPABILITY_DENIED');
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
        if (flushTimeout === undefined && buffer.length > 0)
          flushTimeout = setTimeout(flush, batch.flushMilliseconds);
      };
      const close = (): void => {
        closed = true;
        if (flushTimeout !== undefined) clearTimeout(flushTimeout);
        buffer.length = 0;
        subscriptions.delete(id);
        subscriptionConnectionIdsById.delete(id);
        resolver?.({ done: true, value: undefined });
        if (demandActive)
          decrementDomainDemand(target, demand, request.sessionId);
        demandActive = false;
      };
      const subscription: CdpSubscription = {
        close,
        get droppedCount() {
          return droppedCount;
        },
        id,
        get lastDeliveredSequence() {
          return lastDeliveredSequence;
        },
        get overflowed() {
          return overflowed;
        },
        targetGeneration: target.generation,
        targetId: target.id,
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const event = buffer.shift();
            if (event !== undefined) {
              lastDeliveredSequence = event.sequence;
              return Promise.resolve({ done: false, value: event });
            }
            if (closed)
              return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => {
              resolver = resolve;
              scheduleFlush();
            });
          },
        }),
      };
      await incrementDomainDemand(target, demand, request.sessionId);
      demandActive = true;
      subscriptions.set(id, {
        authorizedMethods,
        close,
        demand,
        offer(method, parameters, sessionId) {
          const matches = eventMatchesSubscription(
            request,
            method,
            parameters,
            sessionId,
          );
          let activeLease: Lease;
          try {
            activeLease = getActiveLease(request, authority);
          } catch {
            close();
            return;
          }
          if (
            !matches
            || closed
            || !activeLease.methods.includes(method)
            || !subscriptions.get(id)?.authorizedMethods.has(method)
            || !isCdpNameAllowed(target.capabilities, method, 'event')
            || (activeLease.mode === 'shared-read'
              && requiredLeaseMode(target.capabilities, [method])
              === 'exclusive-control')
          )
            return;
          const current = subscriptions.get(id);
          if (current === undefined) return;
          const event: CdpEvent = {
            method,
            parameters,
            sequence: current.sequence++,
            subscriptionId: id,
            targetGeneration: target.generation,
            targetId: target.id,
            ...(sessionId === undefined ? {} : { sessionId }),
          };
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
        },
        request,
        sequence: 1,
      });
      subscriptionConnectionIdsById.set(id, authority.connectionId);
      return subscription;
    },
    unregisterAutomationProvider(authority = localAgentAuthority) {
      if (disposed) return;
      if (!isCurrentAgentConnection(authority)) return;
      const provider = automationProvidersByAgentPrincipalId.get(
        authority.principalId,
      );
      if (provider === undefined) return;
      automationProvidersByAgentPrincipalId.delete(authority.principalId);
      releaseAutomationResources(authority.principalId);
      void Promise.resolve(provider.dispose()).catch(() => {});
    },
  });
}
