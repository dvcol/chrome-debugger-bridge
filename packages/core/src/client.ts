import type { AcquireLeaseRequest, CdpSubscription } from './broker.js';
import type { CdpCommand, CdpSubscriptionRequest, JsonObject, Lease, PublishedTarget, TargetRevocationReason } from './protocol.js';

export type TargetChange
  = | { readonly kind: 'published'; readonly sequence: number; readonly target: PublishedTarget }
    | { readonly kind: 'revoked'; readonly reason: TargetRevocationReason; readonly sequence: number; readonly targetGeneration: number; readonly targetId: string }
    | { readonly kind: 'snapshot'; readonly sequence: number; readonly targets: readonly PublishedTarget[] }
    | { readonly kind: 'updated'; readonly sequence: number; readonly target: PublishedTarget };

export type { TargetRevocationReason } from './protocol.js';

export interface TargetDirectory {
  acquireLease?: (request: AcquireLeaseRequest) => Lease | Promise<Lease>;
  executeCommand?: (command: CdpCommand) => Promise<{ readonly operationId: string; readonly value: JsonObject }>;
  listTargets: () => readonly PublishedTarget[] | Promise<readonly PublishedTarget[]>;
  watchTargets?: () => AsyncIterable<TargetChange>;
  subscribe?: (request: CdpSubscriptionRequest) => CdpSubscription | Promise<CdpSubscription>;
}

export interface ChromeDebuggerBridgeClient {
  acquireLease: (request: AcquireLeaseRequest) => Promise<Lease>;
  executeCommand: (command: CdpCommand) => Promise<{ readonly operationId: string; readonly value: JsonObject }>;
  listTargets: () => Promise<readonly PublishedTarget[]>;
  subscribe: (request: CdpSubscriptionRequest) => Promise<CdpSubscription>;
  watchTargets: () => AsyncIterable<TargetChange>;
}

/** Creates a transport-neutral client facade; Node and browser adapters supply the directory. */
export function createChromeDebuggerBridgeClient(directory: TargetDirectory): ChromeDebuggerBridgeClient {
  return {
    async acquireLease(request) {
      if (directory.acquireLease === undefined) {
        throw new Error('The target directory does not support leases.');
      }
      return directory.acquireLease(request);
    },
    async executeCommand(command) {
      if (directory.executeCommand === undefined) {
        throw new Error('The target directory does not support CDP commands.');
      }
      return directory.executeCommand(command);
    },
    async listTargets() {
      return directory.listTargets();
    },
    async subscribe(request) {
      if (directory.subscribe === undefined) throw new Error('The target directory does not support subscriptions.');
      return directory.subscribe(request);
    },
    watchTargets() {
      if (directory.watchTargets === undefined) throw new Error('The target directory does not support target watching.');
      return directory.watchTargets();
    },
  };
}
