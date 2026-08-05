import type { AcquireLeaseRequest, ArtifactAccessRequest, CdpSubscription, ReleaseLeaseRequest, RenewLeaseRequest } from './broker.js';
import type { CdpCommand, CdpCommandResult, CdpSubscriptionRequest, Lease, PublishedTarget, TargetRevocationReason } from './protocol.js';

export type TargetChange
  = | { readonly kind: 'published'; readonly sequence: number; readonly target: PublishedTarget }
    | { readonly kind: 'revoked'; readonly reason: TargetRevocationReason; readonly sequence: number; readonly targetGeneration: number; readonly targetId: string }
    | { readonly kind: 'snapshot'; readonly sequence: number; readonly targets: readonly PublishedTarget[] }
    | { readonly kind: 'updated'; readonly sequence: number; readonly target: PublishedTarget };

export type { TargetRevocationReason } from './protocol.js';

export interface TargetDirectory {
  acquireLease?: (request: AcquireLeaseRequest) => Lease | Promise<Lease>;
  executeCommand?: (command: CdpCommand) => Promise<CdpCommandResult>;
  listTargets: () => readonly PublishedTarget[] | Promise<readonly PublishedTarget[]>;
  releaseLease?: (request: ReleaseLeaseRequest) => void | Promise<void>;
  readArtifact?: (request: ArtifactAccessRequest) => Uint8Array | Promise<Uint8Array>;
  releaseArtifact?: (request: ArtifactAccessRequest) => void | Promise<void>;
  renewLease?: (request: RenewLeaseRequest) => Lease | Promise<Lease>;
  watchTargets?: () => AsyncIterable<TargetChange>;
  subscribe?: (request: CdpSubscriptionRequest) => CdpSubscription | Promise<CdpSubscription>;
}

export interface ChromeDebuggerBridgeClient {
  acquireLease: (request: AcquireLeaseRequest) => Promise<Lease>;
  executeCommand: (command: CdpCommand) => Promise<CdpCommandResult>;
  listTargets: () => Promise<readonly PublishedTarget[]>;
  releaseLease: (request: ReleaseLeaseRequest) => Promise<void>;
  readArtifact: (request: ArtifactAccessRequest) => Promise<Uint8Array>;
  releaseArtifact: (request: ArtifactAccessRequest) => Promise<void>;
  renewLease: (request: RenewLeaseRequest) => Promise<Lease>;
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
    async releaseLease(request) {
      if (directory.releaseLease === undefined) throw new Error('The target directory does not support leases.');
      await directory.releaseLease(request);
    },
    async readArtifact(request) {
      if (directory.readArtifact === undefined) throw new Error('The target directory does not support artifacts.');
      return directory.readArtifact(request);
    },
    async releaseArtifact(request) {
      if (directory.releaseArtifact === undefined) throw new Error('The target directory does not support artifacts.');
      await directory.releaseArtifact(request);
    },
    async renewLease(request) {
      if (directory.renewLease === undefined) throw new Error('The target directory does not support leases.');
      return directory.renewLease(request);
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
