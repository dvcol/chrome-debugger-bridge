import type { AcquireLeaseRequest, ChromeDebuggerBridgeClient, ReleaseLeaseRequest, RenewLeaseRequest } from '@dvcol/chrome-debugger-bridge';
import type { CdpSubscription } from '@dvcol/chrome-debugger-bridge/broker';
import type { CdpCommand, CdpSubscriptionRequest, JsonObject, Lease, PublishedTarget } from '@dvcol/chrome-debugger-bridge/protocol';

import { createChromeDebuggerBridgeClient } from '@dvcol/chrome-debugger-bridge';
import { createBirpc } from 'birpc';

export interface DevframeRpcChannel {
  off?: (listener: (message: unknown) => void) => void;
  on: (listener: (message: unknown) => void) => void;
  post: (message: unknown) => void;
}

interface DevframeBridgeRpc {
  acquireLease: (request: AcquireLeaseRequest) => Promise<Lease>;
  executeCommand: (command: CdpCommand) => Promise<{ readonly operationId: string; readonly value: JsonObject }>;
  listTargets: () => Promise<readonly PublishedTarget[]>;
  releaseLease: (request: ReleaseLeaseRequest) => Promise<void>;
  renewLease: (request: RenewLeaseRequest) => Promise<Lease>;
  subscribe: (request: CdpSubscriptionRequest) => Promise<CdpSubscription>;
}

/** Adapts an isolated Devframe birpc channel to the stable transport-neutral client facade. */
export function createDevframeBridgeClient(channel: DevframeRpcChannel): ChromeDebuggerBridgeClient {
  const rpc = createBirpc<DevframeBridgeRpc>({}, {
    on(listener) {
      channel.on(listener);
    },
    ...(channel.off === undefined
      ? {}
      : { off(listener) {
          channel.off?.(listener);
        } }),
    post(message) {
      channel.post(message);
    },
  });
  return createChromeDebuggerBridgeClient({
    acquireLease: rpc.acquireLease,
    executeCommand: rpc.executeCommand,
    listTargets: rpc.listTargets,
    releaseLease: rpc.releaseLease,
    renewLease: rpc.renewLease,
    subscribe: rpc.subscribe,
  });
}
