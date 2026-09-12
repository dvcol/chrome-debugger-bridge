import type { AgentToBrokerMessage, BrokerToAgentMessage, GrantRequestClaim } from '@dvcol/cdb';
import type { BrokerRequest, BrokerState, ProviderRegistration, ProviderTarget } from '@dvcol/cdb-broker/contract';

/** An authenticated provider channel. Closing it never implies closing the host transport. */
export interface ProviderConnection {
  readonly registration: ProviderRegistration;
  readonly brokerId: string;
  readonly generation: number;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  close: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: BrokerToAgentMessage) => void) => () => void;
  send: (message: AgentToBrokerMessage) => Promise<void>;
  snapshot: () => Promise<BrokerState>;
  claim: (requestId: string) => Promise<{ readonly claim: GrantRequestClaim; readonly request: BrokerRequest }>;
  release: (claim: GrantRequestClaim) => Promise<void>;
  approve: (claim: GrantRequestClaim, targets: readonly ProviderTarget[]) => Promise<BrokerState>;
  reconcile: (targets: readonly ProviderTarget[]) => Promise<BrokerState>;
  reconcileScope: (requestId: string, targets: readonly ProviderTarget[]) => Promise<void>;
  revokeScope: (requestId: string) => Promise<void>;
  watch: (listener: (state: BrokerState) => void) => Promise<() => void>;
}
