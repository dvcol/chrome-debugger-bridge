import type { AuthorityBinding, GrantRequestClaim, JsonValue, Lease, LogicalSessionCredential, TimeoutMilliseconds } from '@dvcol/cdb';
import type { CdbToolDefinition } from '@dvcol/cdb-mcp';
import type { AgentAuthenticationTranscript, BrokerAuthenticationClaims } from '@dvcol/cdb/authentication';

export type NavigationPolicy = 'same-origin' | 'follow-tab';
export type AccessLevel = 'observe' | 'inspect' | 'interact' | 'debug' | 'unsafe';

export interface BrokerCredential {
  readonly agentId: string;
  readonly brokerId: string;
  readonly credential: Uint8Array;
  readonly credentialId: string;
  readonly principalId: string;
  readonly status: 'active' | 'pending';
}

export interface BrokerIdentityStore {
  readonly brokerId: string;
  activate: (record: BrokerCredential) => Promise<BrokerCredential>;
  findByAgentId: (agentId: string) => BrokerCredential | undefined;
  load: (credentialId: string) => BrokerCredential | undefined;
  remove: (credentialId: string) => Promise<void>;
}

export interface BrokerTimingPolicy {
  readonly accessRequestTimeoutMilliseconds: TimeoutMilliseconds;
  readonly clientResumeWindowMilliseconds: TimeoutMilliseconds;
  readonly pairingLifetimeMilliseconds: TimeoutMilliseconds;
  readonly providerRecoveryMilliseconds: TimeoutMilliseconds;
  readonly requestRateLimitMilliseconds: TimeoutMilliseconds;
}

export interface ProviderRegistration {
  readonly id: string;
  readonly instanceId: string;
  readonly name: string;
  readonly version: string;
  readonly maximumLevel: AccessLevel;
}

export interface ProviderState extends ProviderRegistration {
  readonly paired: boolean;
  readonly state: 'connecting' | 'ready' | 'recovering' | 'offline' | 'disconnected';
  readonly targetCount: number;
  readonly recoveryDeadline?: number;
}

export interface ProviderTarget {
  readonly id: string;
  readonly generation: number;
  readonly scopeId: string;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly metadata?: JsonValue;
}

export interface BrokerTarget extends ProviderTarget {
  readonly providerId: string;
  readonly state: 'available' | 'recovering' | 'offline';
}

export interface BrokerPrincipal {
  readonly id: string;
  readonly label: string;
  readonly connectedAt: number;
  readonly metadata?: JsonValue;
}

export interface BrokerRequest {
  readonly id: string;
  readonly principalId: string;
  readonly principalLabel: string;
  readonly level: AccessLevel;
  readonly navigation: NavigationPolicy;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly state: 'pending' | 'claiming';
  readonly requestedTargetId?: string;
  readonly metadata?: JsonValue;
}

export interface BrokerGrant {
  readonly id: string;
  readonly requestId: string;
  readonly principalId: string;
  readonly principalLabel: string;
  readonly providerId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly level: AccessLevel;
  readonly navigation: NavigationPolicy;
  readonly approvedOrigin: string;
  readonly createdAt: number;
  readonly state: 'active' | 'out-of-scope' | 'recovering';
  readonly metadata?: JsonValue;
}

/** Non-secret management state. Agent tools receive only their principal's authorized targets. */
export interface BrokerState {
  readonly revision: number;
  readonly providers: readonly ProviderState[];
  readonly principals: readonly BrokerPrincipal[];
  readonly requests: readonly BrokerRequest[];
  readonly targets: readonly BrokerTarget[];
  readonly grants: readonly BrokerGrant[];
  readonly scopes: readonly (BrokerRequest & { readonly providerId: string })[];
  readonly leases: readonly (Lease & { readonly principalId: string })[];
}

export interface ProviderPairingOffer {
  readonly brokerId: string;
  readonly code: string;
  readonly expiresAt: string | null;
}

export interface ProviderAuthenticationInput {
  readonly credentialId: string;
  readonly clientNonce: string;
  readonly pairing?: { readonly code: string; readonly credential: string };
}

export interface ProviderAuthenticationResult {
  readonly claims: BrokerAuthenticationClaims;
  readonly proof: string;
}

export interface BrowserAccessResult {
  readonly grant: Omit<BrokerGrant, 'targetId' | 'targetGeneration'> & { readonly targetRef: string };
  readonly target: {
    readonly availability: 'available';
    readonly capabilities: { readonly level: AccessLevel };
    readonly targetRef: string;
    readonly type: 'page';
    readonly title?: string;
    readonly url?: string;
  };
}

export interface BrokerPeer {
  /** Set by the authenticated transport adapter, never by tool arguments. */
  readonly id: string;
  readonly label?: string;
  readonly metadata?: JsonValue;
}

export type BrokerTool = Omit<CdbToolDefinition, 'invoke' | 'mcpInputSchema'>;

export type { AgentAuthenticationTranscript, AuthorityBinding, GrantRequestClaim, LogicalSessionCredential };
