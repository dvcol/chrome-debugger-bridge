import type { AcquireLeaseRequest, CdpSubscription } from './broker.js';
import type { CdpCommand, CdpSubscriptionRequest, JsonObject, Lease, PublishedTarget } from './protocol.js';

export interface TargetDirectory {
  acquireLease?: (request: AcquireLeaseRequest) => Lease | Promise<Lease>;
  executeCommand?: (command: CdpCommand) => Promise<{ readonly operationId: string; readonly value: JsonObject }>;
  listTargets: () => readonly PublishedTarget[] | Promise<readonly PublishedTarget[]>;
  subscribe?: (request: CdpSubscriptionRequest) => CdpSubscription | Promise<CdpSubscription>;
}

export interface ChromeDebuggerBridgeClient {
  acquireLease: (request: AcquireLeaseRequest) => Promise<Lease>;
  executeCommand: (command: CdpCommand) => Promise<{ readonly operationId: string; readonly value: JsonObject }>;
  listTargets: () => Promise<readonly PublishedTarget[]>;
  subscribe: (request: CdpSubscriptionRequest) => Promise<CdpSubscription>;
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
  };
}
