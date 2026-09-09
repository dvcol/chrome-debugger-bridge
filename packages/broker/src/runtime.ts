import type { AgentTargetConnection, AuthorityBinding, GrantedTargetReference, GrantRequest, GrantRequestClaim, GrantRequestProvider, JsonValue, LogicalSessionCredential } from '@dvcol/cdb';
import type { CdbToolInvocationContext, McpChromeDebuggerBridgeClient } from '@dvcol/cdb-mcp';
import type { AgentAuthenticationTranscript, BrokerAuthenticationClaims } from '@dvcol/cdb/authentication';

import type { BrokerDefinition } from './config.js';
import type { AccessLevel, BrokerGrant, BrokerPeer, BrokerRequest, BrokerState, BrokerTarget, BrokerTool, BrowserAccessResult, NavigationPolicy, ProviderAuthenticationInput, ProviderRegistration, ProviderState, ProviderTarget } from './contract.js';
import type { BrokerSession } from './session-client.js';

import { connectAgentTargetBroker, createGrantRequestCoordinator, createLogicalSessionManager, createMemoryAuthorityStore, createTargetBroker, scheduleTimeout } from '@dvcol/cdb';
import { createCdbToolSession } from '@dvcol/cdb-mcp';

import packageManifest from '../package.json' with { type: 'json' };
import { allowsNavigation, browserOrigin, defaultBrokerTimingPolicy, defineBroker } from './config.js';
import { BrokerError } from './error.js';
import { createMemoryBrokerIdentityStore } from './identity-store.js';
import { createProviderAuthentication } from './provider-authentication.js';
import { createBrokerSession } from './session-client.js';

const accessLevels: readonly AccessLevel[] = ['observe', 'inspect', 'interact', 'debug', 'unsafe'];

interface Provider {
  readonly registration: ProviderRegistration;
  readonly peer: BrokerPeer;
  readonly generation: number;
  readonly connection: AgentTargetConnection;
  readonly disconnect: () => void;
  state: ProviderState['state'];
  recoveryDeadline?: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
}

interface RequestMetadata {
  readonly navigation: NavigationPolicy;
  readonly createdAt: number;
}

interface BindingMetadata extends RequestMetadata {
  readonly requestId: string;
  readonly providerId: string;
  readonly approvedOrigin: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestMetadata(request: GrantRequest): RequestMetadata {
  const metadata = request.metadata;
  if (!object(metadata) || (metadata.navigation !== 'same-origin' && metadata.navigation !== 'follow-tab') || typeof metadata.createdAt !== 'number')
    throw new BrokerError('ACCESS_DENIED', 'The grant request has no broker policy.');
  return { navigation: metadata.navigation, createdAt: metadata.createdAt };
}

function bindingMetadata(binding: AuthorityBinding): BindingMetadata | undefined {
  const metadata = binding.metadata;
  if (!object(metadata) || (metadata.navigation !== 'same-origin' && metadata.navigation !== 'follow-tab')
    || typeof metadata.requestId !== 'string' || typeof metadata.providerId !== 'string'
    || typeof metadata.approvedOrigin !== 'string' || typeof metadata.createdAt !== 'number') return undefined;
  return { navigation: metadata.navigation, requestId: metadata.requestId, providerId: metadata.providerId, approvedOrigin: metadata.approvedOrigin, createdAt: metadata.createdAt };
}

export interface BrokerRuntime {
  readonly brokerId: string;
  readonly toolProvider: { readonly name: string; readonly version: string };
  readonly tools: readonly BrokerTool[];
  connectSession: (peer: BrokerPeer, input?: { readonly metadata?: JsonValue; readonly resume?: { readonly credential: string; readonly logicalSessionId: string } }) => Promise<LogicalSessionCredential>;
  snapshot: () => BrokerState;
  subscribe: (listener: (state: BrokerState) => void) => () => void;
  registerProvider: (peer: BrokerPeer, registration: ProviderRegistration) => { readonly brokerId: string };
  createPairingOffer: (peer: BrokerPeer) => { readonly brokerId: string; readonly code: string; readonly expiresAt: string | null };
  beginProviderAuthentication: (peer: BrokerPeer, input: ProviderAuthenticationInput) => AgentAuthenticationTranscript;
  authenticateProvider: (peer: BrokerPeer, proof: string, connection: AgentTargetConnection) => Promise<{ readonly proof: string; readonly claims: BrokerAuthenticationClaims; readonly transcript: AgentAuthenticationTranscript }>;
  reconcileProvider: (peer: BrokerPeer, targets: readonly ProviderTarget[]) => Promise<BrokerState>;
  claimRequest: (peer: BrokerPeer, requestId: string) => { readonly claim: GrantRequestClaim; readonly request: BrokerRequest };
  releaseClaim: (peer: BrokerPeer, claim: GrantRequestClaim) => void;
  completeClaim: (peer: BrokerPeer, claim: GrantRequestClaim, targets: readonly ProviderTarget[]) => Promise<BrokerState>;
  reconcileScope: (peer: BrokerPeer, requestId: string, targets: readonly ProviderTarget[]) => Promise<void>;
  revokeScope: (requestId: string) => Promise<void>;
  revokeGrant: (grantId: string) => Promise<boolean>;
  disconnectProvider: (providerId: string, forgetPairing?: boolean) => Promise<boolean>;
  disconnectPeer: (peerId: string) => Promise<void>;
  terminateSession: (peer: BrokerPeer) => Promise<boolean>;
  invoke: (peer: BrokerPeer, name: string, input: unknown, context?: CdbToolInvocationContext) => Promise<unknown>;
  dispose: () => Promise<void>;
}

/** Composes browser authority and tools without owning any process, server, or transport. */
export async function createBroker(configuration: BrokerDefinition = {}): Promise<BrokerRuntime> {
  const definition = defineBroker(configuration);
  const timing = { ...defaultBrokerTimingPolicy, ...definition.timing };
  const identityStore = definition.identityStore ?? createMemoryBrokerIdentityStore();
  const authorityStore = definition.authorityStore ?? createMemoryAuthorityStore();
  const targetBroker = createTargetBroker({
    maximumArtifactBytes: 16 * 1_024 * 1_024,
    maximumInlineResultBytes: 64 * 1_024,
    timing: { reconnectGraceMilliseconds: 0 },
  });
  const logicalSessions = createLogicalSessionManager({ authorityStore, timing: { resumeWindowMilliseconds: timing.clientResumeWindowMilliseconds } });
  const authentication = createProviderAuthentication(identityStore, timing.pairingLifetimeMilliseconds);
  const providers = new Map<string, Provider>();
  const registrations = new Map<string, ProviderRegistration>();
  const targetMetadata = new Map<string, ProviderTarget>();
  const sessions = new Map<string, BrokerSession>();
  const sessionsByPeer = new Map<string, BrokerSession>();
  const connectingSessions = new Map<string, Promise<LogicalSessionCredential>>();
  const fencedPeers = new Set<string>();
  const lastRequests = new Map<string, number>();
  const pendingRequests = new Map<string, ReturnType<typeof Promise.withResolvers<BrowserAccessResult>>>();
  const membershipUpdates = new Map<string, Promise<void>>();
  const listeners = new Set<(state: BrokerState) => void>();
  let revision = 0;
  let disposed = false;
  let publicationQueued = false;
  let authorityUpdates = Promise.resolve();

  const grantCoordinator = createGrantRequestCoordinator({
    authorityStore,
    targetDirectory: {
      getProviderConnectionGeneration: principalId => [...providers.values()].find(provider => provider.registration.instanceId === principalId && provider.state === 'ready')?.generation,
      getTarget(targetId) {
        const target = targetBroker.listTargets().find(candidate => candidate.id === targetId);
        const providerPrincipalId = targetBroker.getTargetAgentPrincipalId(targetId);
        return target === undefined || providerPrincipalId === undefined ? undefined : { target, providerPrincipalId };
      },
    },
    timing: { requestTimeoutMilliseconds: timing.accessRequestTimeoutMilliseconds },
  });

  function ensureActive(): void {
    if (disposed) throw new BrokerError('GRANT_REVOKED', 'The broker has stopped.');
  }

  function currentProvider(peer: BrokerPeer): Provider {
    ensureActive();
    const provider = [...providers.values()].find(candidate => candidate.peer.id === peer.id);
    if (provider === undefined || provider.state !== 'ready') throw new BrokerError('PROVIDER_RECOVERING', 'The authenticated provider is not ready.', true);
    return provider;
  }

  function providerAuthority(provider: Provider): GrantRequestProvider {
    return { principalId: provider.registration.instanceId, connectionGeneration: provider.generation };
  }

  function assertProviderIdentity(registration: ProviderRegistration): void {
    const existing = [...providers.values()].find(provider => provider.registration.id === registration.id || provider.registration.instanceId === registration.instanceId);
    if (existing !== undefined && (existing.registration.id !== registration.id || existing.registration.instanceId !== registration.instanceId))
      throw new BrokerError('ACCESS_DENIED', 'A provider cannot replace its stable installation identity.');
  }

  function targets(): BrokerTarget[] {
    return targetBroker.listTargets().flatMap((published) => {
      const provider = [...providers.values()].find(candidate => candidate.registration.instanceId === targetBroker.getTargetAgentPrincipalId(published.id));
      const metadata = targetMetadata.get(published.id);
      if (provider === undefined || metadata === undefined) return [];
      return [{
        ...metadata,
        generation: published.generation,
        ...(published.title === undefined ? {} : { title: published.title }),
        ...(published.url === undefined ? {} : { url: published.url }),
        providerId: provider.registration.id,
        state: provider.state === 'ready' ? 'available' as const : provider.state === 'recovering' || provider.state === 'connecting' ? 'recovering' as const : 'offline' as const,
      }];
    });
  }

  function grants(): BrokerGrant[] {
    const currentTargets = targets();
    return [...sessions.values()].flatMap(session => session.bindings.flatMap((binding) => {
      const metadata = bindingMetadata(binding);
      if (metadata === undefined || grantCoordinator.getRequest(metadata.requestId)?.state !== 'granted' || (binding.expiresAt != null && Date.parse(binding.expiresAt) <= Date.now())) return [];
      const target = currentTargets.find(candidate => candidate.id === binding.targetId);
      const state = target?.state !== 'available' || target.generation !== binding.targetGeneration
        ? 'recovering' as const
        : allowsNavigation(definition, { ...metadata, principalId: session.principal.id, targetId: binding.targetId, url: target.url }) ? 'active' as const : 'out-of-scope' as const;
      return [{
        ...metadata,
        id: binding.bindingId,
        principalId: session.principal.id,
        principalLabel: session.principal.label,
        targetId: binding.targetId,
        targetGeneration: binding.targetGeneration,
        level: binding.capabilities.level ?? 'observe',
        state,
        ...(target?.metadata === undefined ? {} : { metadata: target.metadata }),
      }];
    }));
  }

  function projectRequest(request: GrantRequest): BrokerRequest {
    const session = sessions.get(request.logicalSessionId);
    return {
      ...requestMetadata(request),
      id: request.id,
      principalId: request.principalId,
      principalLabel: session?.principal.label ?? request.principalId,
      level: request.capabilities.level ?? 'observe',
      expiresAt: request.expiresAt == null ? null : Date.parse(request.expiresAt),
      state: request.state === 'claimed' ? 'claiming' : 'pending',
      ...(request.requestedTargetId === undefined ? {} : { requestedTargetId: request.requestedTargetId }),
      ...(session?.principal.metadata === undefined ? {} : { metadata: session.principal.metadata }),
    };
  }

  function snapshot(): BrokerState {
    const currentTargets = targets();
    const registeredProviders = Array.from(providers.values(), provider => ({
      ...provider.registration,
      paired: identityStore.findByAgentId(provider.registration.instanceId) !== undefined,
      state: provider.state,
      targetCount: currentTargets.filter(target => target.providerId === provider.registration.id).length,
      ...(provider.recoveryDeadline === undefined ? {} : { recoveryDeadline: provider.recoveryDeadline }),
    }));
    for (const registration of registrations.values()) {
      if (!registeredProviders.some(provider => provider.id === registration.id))
        registeredProviders.push({ ...registration, paired: identityStore.findByAgentId(registration.instanceId) !== undefined, state: 'connecting', targetCount: 0 });
    }
    return structuredClone({
      revision,
      providers: registeredProviders,
      principals: Array.from(sessions.values(), session => session.principal),
      requests: grantCoordinator.inspect().filter(({ request }) => request.state !== 'granted').map(({ request }) => projectRequest(request)),
      scopes: grantCoordinator.inspect().flatMap(({ request, provider }) => request.state !== 'granted' || provider === undefined
        ? []
        : [{
            ...projectRequest(request),
            providerId: [...providers.values()].find(candidate => candidate.registration.instanceId === provider.principalId)?.registration.id ?? provider.principalId,
          }]),
      targets: currentTargets,
      grants: grants(),
      leases: targetBroker.listLeases(),
    });
  }

  function changed(): void {
    if (publicationQueued || disposed) return;
    publicationQueued = true;
    queueMicrotask(() => {
      publicationQueued = false;
      if (disposed) return;
      revision += 1;
      const state = snapshot();
      for (const listener of listeners) {
        try {
          listener(state);
        } catch { /** Presentation observers do not participate in authority changes. */ }
      }
    });
  }

  async function refreshSessions(): Promise<void> {
    await Promise.all(Array.from(sessions.values(), async session => session.refresh()));
  }

  const unsubscribeAuthority = authorityStore.subscribe(({ logicalSessionId }) => {
    authorityUpdates = authorityUpdates.then(async () => {
      const session = sessions.get(logicalSessionId);
      if (session === undefined) return;
      await session.refresh();
      let record;
      try {
        record = await authorityStore.get(logicalSessionId);
      } catch {
        changed();
        return;
      }
      if (record === undefined) {
        session.dispose();
        sessions.delete(logicalSessionId);
        for (const [peerId, registeredSession] of sessionsByPeer) {
          if (registeredSession === session) {
            sessionsByPeer.delete(peerId);
            fencedPeers.add(peerId);
          }
        }
        await Promise.all(grantCoordinator.inspect().filter(({ request }) => request.logicalSessionId === logicalSessionId).map(async ({ request }) => grantCoordinator.cancel(request.id)));
      }
      changed();
    }).catch(() => {
      changed();
    });
  });

  const unsubscribeRequests = grantCoordinator.subscribe(({ requestId, request, error, reason }) => {
    for (const session of sessions.values()) session.refreshTargets();
    const pending = pendingRequests.get(requestId);
    if (pending !== undefined && (request === undefined || error !== undefined)) {
      pendingRequests.delete(requestId);
      const code = reason === 'expired' ? 'ACCESS_REQUEST_TIMEOUT' : reason === 'rejected' ? 'ACCESS_REQUEST_REJECTED' : 'ACCESS_REQUEST_CANCELLED';
      const message = reason === 'expired' ? 'The browser access request expired.' : reason === 'rejected' ? 'The browser access request was rejected.' : 'The browser access request was cancelled.';
      pending.reject(new BrokerError(error?.code ?? code, error?.message ?? message, error?.retryable ?? false));
    }
    changed();
  });

  async function establishSession(peer: BrokerPeer, input: { readonly metadata?: JsonValue; readonly resume?: { readonly credential: string; readonly logicalSessionId: string } }): Promise<LogicalSessionCredential> {
    ensureActive();
    if (sessionsByPeer.has(peer.id)) throw new BrokerError('ACCESS_DENIED', 'This peer already has a browser session.');
    const credential = input.resume === undefined
      ? await logicalSessions.create({ connectionId: peer.id, principalId: crypto.randomUUID(), ...(input.metadata === undefined ? {} : { metadata: input.metadata }) })
      : await logicalSessions.resume({ connectionId: peer.id, logicalSessionId: input.resume.logicalSessionId, resumeCredential: input.resume.credential });
    ensureActive();
    const record = await authorityStore.get(credential.logicalSessionId);
    if (record === undefined || record.activeConnectionId !== peer.id) throw new BrokerError('GRANT_REVOKED', 'The browser session was replaced.');
    let session = sessions.get(record.logicalSessionId);
    if (session === undefined) {
      session = createBrokerSession({ definition, authorityStore, targetBroker, changed, isProviderReady: providerId => providers.get(providerId)?.state === 'ready', isRequestGranted: requestId => grantCoordinator.getRequest(requestId)?.state === 'granted' }, {
        id: record.principalId,
        label: peer.label ?? `Browser client ${record.principalId.slice(-4)}`,
        connectedAt: Date.now(),
        ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
      }, record);
      sessions.set(record.logicalSessionId, session);
    }
    for (const [previousPeerId, previousSession] of sessionsByPeer) {
      if (previousSession === session) {
        sessionsByPeer.delete(previousPeerId);
        fencedPeers.add(previousPeerId);
      }
    }
    session.bind(peer);
    sessionsByPeer.set(peer.id, session);
    await session.refresh();
    changed();
    return credential;
  }

  async function connectSession(peer: BrokerPeer, input: Parameters<typeof establishSession>[1] = {}): Promise<LogicalSessionCredential> {
    ensureActive();
    if (fencedPeers.has(peer.id) || connectingSessions.has(peer.id)) throw new BrokerError('ACCESS_DENIED', 'This browser connection was replaced or is already connecting.');
    const operation = establishSession(peer, input).finally(() => connectingSessions.delete(peer.id));
    connectingSessions.set(peer.id, operation);
    return operation;
  }

  async function sessionFor(peer: BrokerPeer): Promise<BrokerSession> {
    ensureActive();
    let session = sessionsByPeer.get(peer.id);
    if (session === undefined) {
      await (connectingSessions.get(peer.id) ?? connectSession(peer, { ...(peer.metadata === undefined ? {} : { metadata: peer.metadata }) }));
      session = sessionsByPeer.get(peer.id);
    }
    if (session === undefined) throw new BrokerError('GRANT_REVOKED', 'The browser session is unavailable.');
    await session.refresh();
    return session;
  }

  async function cancelProviderRequests(provider: Provider): Promise<void> {
    for (const state of grantCoordinator.inspect()) {
      if (state.provider?.principalId === provider.registration.instanceId) await grantCoordinator.cancel(state.request.id);
    }
    await refreshSessions();
  }

  function recover(provider: Provider): void {
    if (disposed || providers.get(provider.registration.id) !== provider || provider.state === 'disconnected') return;
    provider.state = 'recovering';
    if (provider.recoveryTimer !== undefined) clearTimeout(provider.recoveryTimer);
    if (timing.providerRecoveryMilliseconds === null) delete provider.recoveryDeadline;
    else provider.recoveryDeadline = Date.now() + timing.providerRecoveryMilliseconds;
    for (const session of sessions.values()) session.refreshTargets();
    const timer = scheduleTimeout(() => {
      if (providers.get(provider.registration.id) !== provider || provider.state !== 'recovering') return;
      provider.state = 'offline';
      targetBroker.revokeAgentTargets(providerAuthority(provider), 'detached');
      void cancelProviderRequests(provider).catch(() => {}).finally(changed);
    }, timing.providerRecoveryMilliseconds);
    if (timer !== undefined) {
      provider.recoveryTimer = timer;
      timer.unref();
    }
    changed();
  }

  function checkedTargets(provider: Provider, values: readonly ProviderTarget[]): BrokerTarget[] {
    const uniqueIds = new Set<string>();
    return values.map((value) => {
      const published = targetBroker.listTargets().find(target => target.id === value.id && target.generation === value.generation);
      if (uniqueIds.has(value.id) || published === undefined || targetBroker.getTargetAgentPrincipalId(value.id) !== provider.registration.instanceId)
        throw new BrokerError('TARGET_GONE', 'The provider has not published this exact target generation.', true);
      uniqueIds.add(value.id);
      const target = { ...value, ...(published.url === undefined ? {} : { url: published.url }), providerId: provider.registration.id, state: 'available' as const };
      if (browserOrigin(target.url) === undefined) throw new BrokerError('ACCESS_DENIED', 'Only HTTP(S) targets can be approved.');
      return target;
    });
  }

  function bindingTargets(request: GrantRequest, provider: Provider, values: readonly ProviderTarget[]): GrantedTargetReference[] {
    const previous = grantCoordinator.inspect().find(state => state.request.id === request.id)?.bindings ?? [];
    return checkedTargets(provider, values).map((target) => {
      const prior = previous.find(binding => binding.targetId === target.id);
      const metadata: BindingMetadata = {
        ...requestMetadata(request),
        requestId: request.id,
        providerId: provider.registration.id,
        approvedOrigin: (prior === undefined ? undefined : bindingMetadata(prior)?.approvedOrigin) ?? browserOrigin(target.url)!,
      };
      targetMetadata.set(target.id, structuredClone(target));
      return { targetId: target.id, targetGeneration: target.generation, metadata: { ...metadata } };
    });
  }

  async function reconcileScope(peer: BrokerPeer, requestId: string, values: readonly ProviderTarget[]): Promise<void> {
    const targets = structuredClone(values);
    const update = (membershipUpdates.get(requestId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const provider = currentProvider(peer);
      const request = grantCoordinator.getRequest(requestId);
      if (request === undefined) throw new BrokerError('GRANT_REVOKED', 'The approved scope no longer exists.');
      await grantCoordinator.reconcile(requestId, providerAuthority(provider), bindingTargets(request, provider, targets));
      await refreshSessions();
      changed();
    });
    membershipUpdates.set(requestId, update);
    try {
      await update;
    } finally {
      if (membershipUpdates.get(requestId) === update) membershipUpdates.delete(requestId);
    }
  }

  function accessResult(grant: BrokerGrant, session: BrokerSession): BrowserAccessResult {
    const published = targetBroker.listTargets(session.authority).find(target => target.id === grant.targetId);
    const targetRef = published === undefined ? undefined : session.tools.projectTarget(published)?.targetRef;
    if (targetRef === undefined) throw new BrokerError('TARGET_GONE', 'The approved target is not available yet.', true);
    const target = targets().find(candidate => candidate.id === grant.targetId);
    const { targetId: _targetId, targetGeneration: _targetGeneration, ...publicGrant } = grant;
    return {
      grant: { ...publicGrant, targetRef },
      target: { availability: 'available', capabilities: { level: grant.level }, targetRef, type: 'page', ...(target?.title === undefined ? {} : { title: target.title }), ...(target?.url === undefined ? {} : { url: target.url }) },
    };
  }

  const requestTool: BrokerTool = {
    name: 'browser.request_access',
    description: 'Request user-approved browser control. Reuse a current approved target or request another tab. No browser authority exists until approval completes.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: [...accessLevels], description: 'Exact cumulative access level requested.' },
        navigation: { type: 'string', enum: [...(definition.navigation?.allowed ?? ['same-origin', 'follow-tab'])], description: 'Approved navigation scope; defaults to same-origin.' },
        targetRef: { type: 'string', description: 'Existing stable target reference to request.' },
        newTarget: { type: 'boolean', description: 'Request another approved target instead of reusing an existing grant.' },
      },
      required: ['level'],
      additionalProperties: false,
    },
  };

  const descriptorClient = new Proxy({} as McpChromeDebuggerBridgeClient, { get() {
    return () => {
      throw new Error('Tool descriptors have no client authority.');
    };
  } });
  const descriptors = createCdbToolSession({ client: descriptorClient, enableRawCdp: true, ...(definition.automationProvider === undefined ? {} : { automationProvider: 'registered' }) });

  async function requestAccess(peer: BrokerPeer, input: unknown, context?: CdbToolInvocationContext): Promise<BrowserAccessResult> {
    context?.signal.throwIfAborted();
    if (!object(input) || !accessLevels.includes(input.level as AccessLevel)) throw new BrokerError('ACCESS_DENIED', 'A valid browser access level is required.');
    const level = input.level as AccessLevel;
    const navigation = input.navigation ?? definition.navigation?.default ?? 'same-origin';
    if ((navigation !== 'same-origin' && navigation !== 'follow-tab') || !(definition.navigation?.allowed ?? ['same-origin', 'follow-tab']).includes(navigation))
      throw new BrokerError('ACCESS_DENIED', 'The requested navigation policy is not permitted.');
    if (input.targetRef !== undefined && (typeof input.targetRef !== 'string' || input.newTarget === true)) throw new BrokerError('ACCESS_DENIED', 'targetRef and newTarget are mutually exclusive.');
    const session = await sessionFor(peer);
    const requestedTargetId = typeof input.targetRef === 'string' ? session.tools.targetIdForReference(input.targetRef) : undefined;
    if (input.targetRef !== undefined && requestedTargetId === undefined) throw new BrokerError('MCP_TARGET_REF_STALE', 'The target reference is no longer valid.');
    const candidates = grants().filter(grant => grant.principalId === session.principal.id && grant.state === 'active'
      && (requestedTargetId === undefined || grant.targetId === requestedTargetId)
      && accessLevels.indexOf(grant.level) >= accessLevels.indexOf(level) && (grant.navigation === 'follow-tab' || grant.navigation === navigation));
    const targetIds = new Set(candidates.map(grant => grant.targetId));
    if (input.newTarget !== true && targetIds.size === 1 && candidates[0] !== undefined) {
      return accessResult(candidates[0], session);
    }
    if (input.newTarget !== true && targetIds.size > 1) throw new BrokerError('TARGET_AMBIGUOUS', 'Choose a targetRef or request a new target.', true);
    if (grantCoordinator.inspect().some(state => state.request.logicalSessionId === session.logicalSessionId && state.request.state !== 'granted'))
      throw new BrokerError('REQUEST_RATE_LIMITED', 'This browser session already has a pending request.', true);
    const previous = lastRequests.get(session.principal.id);
    if (previous !== undefined && timing.requestRateLimitMilliseconds !== null && Date.now() - previous < timing.requestRateLimitMilliseconds)
      throw new BrokerError('REQUEST_RATE_LIMITED', 'Wait before requesting browser control again.', true, timing.requestRateLimitMilliseconds - (Date.now() - previous));
    lastRequests.set(session.principal.id, Date.now());
    const id = crypto.randomUUID();
    const pending = Promise.withResolvers<BrowserAccessResult>();
    pendingRequests.set(id, pending);
    const cancel = (): void => {
      pending.reject(new BrokerError('MCP_ACTION_CANCELLED', 'The browser access request was cancelled.'));
      void grantCoordinator.cancel(id).catch(() => {});
    };
    context?.signal.addEventListener('abort', cancel, { once: true });
    const outcome = pending.promise.finally(() => context?.signal.removeEventListener('abort', cancel));
    void outcome.catch(() => {});
    try {
      await grantCoordinator.request({
        id,
        principalId: session.principal.id,
        logicalSessionId: session.logicalSessionId,
        capabilities: { level },
        metadata: { navigation, createdAt: Date.now() },
        ...(requestedTargetId === undefined ? {} : { requestedTargetId }),
      });
    } catch (error) {
      pendingRequests.delete(id);
      context?.signal.removeEventListener('abort', cancel);
      throw error;
    }
    if (context?.signal.aborted) {
      await grantCoordinator.cancel(id);
      cancel();
    }
    changed();
    return outcome;
  }

  return {
    brokerId: identityStore.brokerId,
    toolProvider: { name: '@dvcol/cdb', version: packageManifest.version },
    connectSession,
    snapshot,
    tools: [requestTool, ...descriptors.definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))],
    subscribe(listener: (state: BrokerState) => void) {
      ensureActive();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerProvider(peer: BrokerPeer, registration: ProviderRegistration) {
      ensureActive();
      if (!registration.id || !registration.instanceId || !accessLevels.includes(registration.maximumLevel)) throw new BrokerError('ACCESS_DENIED', 'Invalid provider registration.');
      assertProviderIdentity(registration);
      registrations.set(peer.id, structuredClone(registration));
      changed();
      return { brokerId: identityStore.brokerId };
    },
    createPairingOffer(peer: BrokerPeer) {
      ensureActive();
      const registration = registrations.get(peer.id);
      if (registration === undefined) throw new BrokerError('ACCESS_DENIED', 'Register the provider before pairing.');
      return authentication.invite(peer.id, registration.instanceId);
    },
    beginProviderAuthentication(peer: BrokerPeer, input: ProviderAuthenticationInput) {
      const registration = registrations.get(peer.id);
      if (registration === undefined) throw new BrokerError('ACCESS_DENIED', 'Register the provider before authenticating.');
      return authentication.begin(peer.id, registration.instanceId, input);
    },
    async authenticateProvider(peer: BrokerPeer, proof: string, connection: AgentTargetConnection) {
      const registration = registrations.get(peer.id);
      if (registration === undefined) throw new BrokerError('ACCESS_DENIED', 'The provider registration expired.');
      const authenticated = await authentication.authenticate(peer.id, proof);
      ensureActive();
      if (registrations.get(peer.id) !== registration) throw new BrokerError('ACCESS_DENIED', 'The provider registration was replaced.');
      assertProviderIdentity(registration);
      const previous = providers.get(registration.id);
      if (previous?.recoveryTimer !== undefined) clearTimeout(previous.recoveryTimer);
      previous?.disconnect();
      previous?.connection.close?.(4000, 'Provider connection replaced');
      const authority = { principalId: registration.instanceId, connectionGeneration: authenticated.claims.connectionGeneration };
      const provider: Provider = {
        registration,
        peer,
        generation: authority.connectionGeneration,
        connection,
        state: 'connecting',
        disconnect: connectAgentTargetBroker(connection, targetBroker, {
          authority,
          connectionGeneration: authority.connectionGeneration,
          revokeTargetsOnDisconnect: false,
          connectionLimits: { maximumArtifactBytes: 16 * 1_024 * 1_024, maximumInlineResultBytes: 64 * 1_024, maximumMessageBytes: definition.maximumProviderMessageBytes ?? 64 * 1_024 * 1_024 },
        }),
      };
      providers.set(registration.id, provider);
      for (const session of sessions.values()) session.refreshTargets();
      void connection.closed?.then(() => {
        provider.disconnect();
        recover(provider);
      });
      if (definition.automationProvider !== undefined) {
        try {
          const automation = await definition.automationProvider();
          ensureActive();
          if (providers.get(registration.id) !== provider || provider.state !== 'connecting')
            throw new BrokerError('PROVIDER_RECOVERING', 'The provider connection changed during automation setup.', true);
          targetBroker.registerAutomationProvider(automation, authority);
        } catch (error) {
          provider.disconnect();
          connection.close?.(3001, 'Automation setup failed');
          recover(provider);
          throw error;
        }
      }
      changed();
      return { proof: authenticated.proof, claims: authenticated.claims, transcript: authenticated.transcript };
    },
    async reconcileProvider(peer: BrokerPeer, values: readonly ProviderTarget[]) {
      const provider = [...providers.values()].find(candidate => candidate.peer.id === peer.id);
      if (provider === undefined || (provider.state !== 'connecting' && provider.state !== 'ready')) throw new BrokerError('PROVIDER_RECOVERING', 'The provider connection is unavailable.', true);
      const checked = checkedTargets(provider, values);
      for (const target of checked) targetMetadata.set(target.id, target);
      provider.state = 'ready';
      for (const session of sessions.values()) session.refreshTargets();
      for (const state of grantCoordinator.inspect()) {
        if (state.request.state !== 'granted' || state.provider?.principalId !== provider.registration.instanceId) continue;
        const selected = checked.filter(target => state.bindings.some(binding => binding.targetId === target.id));
        await reconcileScope(peer, state.request.id, selected);
      }
      changed();
      return snapshot();
    },
    claimRequest(peer: BrokerPeer, requestId: string) {
      const provider = currentProvider(peer);
      const request = grantCoordinator.getRequest(requestId);
      if (request === undefined || accessLevels.indexOf(provider.registration.maximumLevel) < accessLevels.indexOf(request.capabilities.level ?? 'observe'))
        throw new BrokerError('ACCESS_DENIED', 'This provider cannot satisfy the requested access level.');
      const claim = grantCoordinator.claim(requestId, providerAuthority(provider));
      return { claim, request: projectRequest(request) };
    },
    releaseClaim(peer: BrokerPeer, claim: GrantRequestClaim) {
      const provider = currentProvider(peer);
      if (claim.provider.principalId !== provider.registration.instanceId) throw new BrokerError('ACCESS_DENIED', 'The claim belongs to another provider.');
      grantCoordinator.release(claim);
    },
    async completeClaim(peer: BrokerPeer, claim: GrantRequestClaim, values: readonly ProviderTarget[]) {
      const provider = currentProvider(peer);
      if (claim.provider.principalId !== provider.registration.instanceId) throw new BrokerError('ACCESS_DENIED', 'The claim belongs to another provider.');
      const request = grantCoordinator.getRequest(claim.requestId);
      if (request === undefined) throw new BrokerError('GRANT_REVOKED', 'The grant request ended.');
      await grantCoordinator.complete(claim, bindingTargets(request, provider, values));
      await refreshSessions();
      const session = sessions.get(request.logicalSessionId);
      const grant = grants().find(candidate => candidate.requestId === request.id);
      if (session === undefined || grant === undefined) throw new BrokerError('GRANT_REVOKED', 'The requesting session ended before approval completed.');
      const pending = pendingRequests.get(request.id);
      pendingRequests.delete(request.id);
      try {
        pending?.resolve(accessResult(grant, session));
      } catch (error) {
        pending?.reject(error);
        throw error;
      }
      changed();
      return snapshot();
    },
    reconcileScope,
    async revokeScope(requestId: string) {
      const request = grantCoordinator.getRequest(requestId);
      await grantCoordinator.cancel(requestId, request?.state === 'granted' ? 'revoked' : 'rejected');
      await refreshSessions();
      changed();
    },
    async revokeGrant(grantId: string) {
      const grant = grants().find(candidate => candidate.id === grantId);
      if (grant === undefined) return false;
      await grantCoordinator.revokeBindings(grant.requestId, [grantId]);
      await refreshSessions();
      changed();
      return true;
    },
    async disconnectProvider(providerId: string, forgetPairing = false) {
      const provider = providers.get(providerId);
      if (provider === undefined) return false;
      provider.state = 'disconnected';
      if (provider.recoveryTimer !== undefined) clearTimeout(provider.recoveryTimer);
      provider.disconnect();
      provider.connection.close?.(4001, 'Provider disconnected');
      targetBroker.revokeAgentTargets(providerAuthority(provider), 'explicit');
      await cancelProviderRequests(provider);
      if (forgetPairing) {
        let credential = identityStore.findByAgentId(provider.registration.instanceId);
        while (credential !== undefined) {
          await identityStore.remove(credential.credentialId);
          credential = identityStore.findByAgentId(provider.registration.instanceId);
        }
      }
      changed();
      return true;
    },
    async disconnectPeer(peerId: string) {
      authentication.forget(peerId);
      registrations.delete(peerId);
      const provider = [...providers.values()].find(candidate => candidate.peer.id === peerId);
      if (provider !== undefined) {
        provider.disconnect();
        recover(provider);
      }
      const session = sessionsByPeer.get(peerId);
      if (session !== undefined) {
        sessionsByPeer.delete(peerId);
        session.disconnect();
        for (const state of grantCoordinator.inspect()) {
          if (state.request.logicalSessionId === session.logicalSessionId && state.request.state !== 'granted') await grantCoordinator.cancel(state.request.id);
        }
        await logicalSessions.disconnect(session.logicalSessionId, peerId);
      }
      changed();
    },
    async terminateSession(peer: BrokerPeer) {
      const session = sessionsByPeer.get(peer.id);
      if (session === undefined) return false;
      await logicalSessions.terminate(session.logicalSessionId);
      await authorityUpdates;
      return true;
    },
    async invoke(peer: BrokerPeer, name: string, input: unknown, context?: CdbToolInvocationContext): Promise<unknown> {
      if (name === 'browser.request_access') return requestAccess(peer, input, context);
      const session = await sessionFor(peer);
      if (object(input) && typeof input.targetRef === 'string') {
        const targetId = session.tools.targetIdForReference(input.targetRef);
        const grant = grants().find(candidate => candidate.principalId === session.principal.id && candidate.targetId === targetId && candidate.state === 'active')
          ?? grants().find(candidate => candidate.principalId === session.principal.id && candidate.targetId === targetId);
        if (grant?.state === 'out-of-scope') throw new BrokerError('TARGET_OUT_OF_SCOPE', 'The tab is outside this grant’s approved origin.', true);
        if (grant?.state === 'recovering') throw new BrokerError('PROVIDER_RECOVERING', 'The browser provider is recovering.', true);
      }
      const tool = session.tools.definitions.find(candidate => candidate.name === name);
      if (tool === undefined) throw new BrokerError('ACCESS_DENIED', 'Unknown browser tool.');
      const result = await tool.invoke(input, context);
      const content = result.content.find(candidate => candidate.type === 'text');
      let value: unknown = content?.text;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch { /** Plain tool text remains text. */ }
      }
      if (result.isError === true) {
        throw new BrokerError(
          object(value) && typeof value.code === 'string' ? value.code : 'MCP_TOOL_FAILED',
          object(value) && typeof value.message === 'string' ? value.message : String(value),
          object(value) && value.retryable === true,
          object(value) && typeof value.retryAfterMs === 'number' ? value.retryAfterMs : undefined,
          object(value) && object(value.details) ? value.details : undefined,
        );
      }
      return value;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      authentication.dispose();
      unsubscribeAuthority();
      unsubscribeRequests();
      for (const pending of pendingRequests.values()) pending.reject(new BrokerError('GRANT_REVOKED', 'The broker stopped.'));
      pendingRequests.clear();
      for (const provider of providers.values()) {
        if (provider.recoveryTimer !== undefined) clearTimeout(provider.recoveryTimer);
        provider.disconnect();
        provider.connection.close?.(1001, 'Broker stopped');
      }
      for (const session of sessions.values()) session.dispose();
      await grantCoordinator.dispose();
      await Promise.allSettled(membershipUpdates.values());
      await Promise.all(Array.from(sessions.keys(), async id => logicalSessions.terminate(id)));
      await authorityUpdates;
      logicalSessions.dispose();
      descriptors.dispose();
      targetBroker.dispose();
      sessions.clear();
      sessionsByPeer.clear();
      listeners.clear();
      providers.clear();
      registrations.clear();
      targetMetadata.clear();
    },
  };
}
