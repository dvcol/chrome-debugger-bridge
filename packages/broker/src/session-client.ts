import type { AuthorityRecord, AuthorityStore, TargetBroker } from '@dvcol/cdb';
import type { CdbToolSession, McpChromeDebuggerBridgeClient } from '@dvcol/cdb-mcp';
import type { ClientAuthority } from '@dvcol/cdb/broker';

import type { BrokerDefinition } from './config.js';
import type { BrokerPeer, BrokerPrincipal } from './contract.js';

import { createCdbToolSession } from '@dvcol/cdb-mcp';

import { allowsNavigation } from './config.js';
import { BrokerError } from './error.js';

export interface SessionContext {
  readonly definition: BrokerDefinition;
  readonly authorityStore: AuthorityStore;
  readonly targetBroker: TargetBroker;
  changed: () => void;
  isProviderReady: (providerId: string) => boolean;
  isRequestGranted: (requestId: string) => boolean;
}

export interface BrokerSession {
  readonly authority: ClientAuthority;
  readonly client: McpChromeDebuggerBridgeClient;
  readonly logicalSessionId: string;
  readonly principal: BrokerPrincipal;
  readonly tools: CdbToolSession;
  readonly bindings: AuthorityRecord['bindings'];
  readonly peer: BrokerPeer | undefined;
  bind: (peer: BrokerPeer) => void;
  disconnect: () => void;
  dispose: () => void;
  refresh: () => Promise<void>;
  refreshTargets: () => void;
}

/** Connection and client resources; live grant authority remains in the supplied store. */
export function createBrokerSession(context: SessionContext, principal: BrokerPrincipal, initialRecord: AuthorityRecord): BrokerSession {
  let record: AuthorityRecord | undefined = initialRecord;
  let peer: BrokerPeer | undefined;
  let disposed = false;
  let refreshed = Promise.resolve();
  const logicalSessionId = initialRecord.logicalSessionId;

  function bindingAllowed(binding: AuthorityRecord['bindings'][number]): boolean {
    const metadata = binding.metadata;
    if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    if (typeof metadata.approvedOrigin !== 'string' || typeof metadata.providerId !== 'string' || typeof metadata.requestId !== 'string' || !context.isRequestGranted(metadata.requestId)
      || (metadata.navigation !== 'same-origin' && metadata.navigation !== 'follow-tab')) return false;
    const target = context.targetBroker.listTargets().find(candidate => candidate.id === binding.targetId);
    return context.isProviderReady(metadata.providerId) && target?.generation === binding.targetGeneration
      && (binding.expiresAt == null || Date.parse(binding.expiresAt) > Date.now())
      && allowsNavigation(context.definition, {
        approvedOrigin: metadata.approvedOrigin,
        navigation: metadata.navigation,
        principalId: principal.id,
        targetId: binding.targetId,
        url: target.url,
      });
  }

  const authority: ClientAuthority = {
    get authorityAvailable() {
      return !disposed && record !== undefined && peer !== undefined && record.activeConnectionId === peer.id;
    },
    get connectionId() {
      return peer?.id ?? `disconnected:${logicalSessionId}`;
    },
    displayName: principal.label,
    logicalSessionId,
    principalId: principal.id,
    get targetGrants() {
      return record?.bindings.filter(bindingAllowed) ?? [];
    },
  };

  async function refresh(): Promise<void> {
    refreshed = refreshed.then(async () => {
      if (disposed) return;
      try {
        record = await context.authorityStore.get(logicalSessionId);
      } catch {
        record = undefined;
      }
      context.targetBroker.refreshClientAuthority(authority);
    });
    return refreshed;
  }

  async function authorized<Result>(operation: (authority: ClientAuthority) => Result | Promise<Result>): Promise<Result> {
    await refresh();
    if (!authority.authorityAvailable) throw new BrokerError('GRANT_REVOKED', 'The browser-control session is disconnected or fenced.');
    return operation(authority);
  }

  const client: McpChromeDebuggerBridgeClient = {
    acquireLease: async request => authorized((authority) => {
      const lease = context.targetBroker.acquireLease(request, authority);
      context.changed();
      return lease;
    }),
    cancelAutomation: async request => authorized(authority => context.targetBroker.cancelAutomation(request.operationId, authority)),
    cancelCommand: async request => authorized(authority => context.targetBroker.cancelCommand(request.operationId, authority)),
    executeAutomation: async request => authorized(async authority => context.targetBroker.executeAutomation(request, authority)),
    executeCommand: async request => authorized(async authority => context.targetBroker.executeCommand(request, authority)),
    listTargets: async () => authorized(authority => context.targetBroker.listTargets(authority)),
    readArtifact: async request => authorized(authority => context.targetBroker.readArtifact(request, authority)),
    releaseArtifact: async request => authorized(authority => context.targetBroker.releaseArtifact(request, authority)),
    releaseLease: async request => authorized((authority) => {
      context.targetBroker.releaseLease(request, authority);
      context.changed();
    }),
    renewLease: async request => authorized(authority => context.targetBroker.renewLease(request, authority)),
    subscribe: async request => authorized(async authority => context.targetBroker.subscribe(request, authority)),
    watchTargets: () => context.targetBroker.watchTargets(authority),
  };
  const tools = createCdbToolSession({
    client,
    enableRawCdp: true,
    ...(context.definition.automationProvider === undefined ? {} : { automationProvider: 'registered' }),
  });

  return {
    authority,
    client,
    logicalSessionId,
    principal,
    tools,
    get bindings() {
      return record?.bindings ?? [];
    },
    get peer() {
      return peer;
    },
    bind(nextPeer: BrokerPeer) {
      if (peer !== undefined) context.targetBroker.disconnectClient(authority);
      peer = nextPeer;
      tools.rebindClient(client);
      context.targetBroker.connectClient(authority);
    },
    disconnect() {
      context.targetBroker.disconnectClient(authority);
      peer = undefined;
      tools.rebindClient(client);
    },
    dispose() {
      if (disposed) return;
      context.targetBroker.disconnectClient(authority);
      disposed = true;
      peer = undefined;
      tools.dispose();
    },
    refresh,
    refreshTargets() {
      context.targetBroker.refreshClientAuthority(authority);
    },
  };
}
