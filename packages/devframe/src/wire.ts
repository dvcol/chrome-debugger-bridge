import type { BrokerToAgentMessage } from '@dvcol/cdb';
import type { BrokerState } from '@dvcol/cdb-broker/contract';
import type { DevframeScopedClientRpc } from 'devframe/client';
import type {} from 'devframe/types';

/** Only the existing scoped RPC operations are required, not Devframe's transport or context internals. */
export interface CdbDevframeClient {
  scope: (namespace: string) => { readonly rpc: Pick<DevframeScopedClientRpc, 'call' | 'callEvent' | 'sharedState'> & {
    register: (definition: Pick<Parameters<DevframeScopedClientRpc['register']>[0], 'name' | 'type' | 'handler'>) => void;
  }; };
}

export const cdbServiceScope = 'cdb:broker';

export type CdbReply<Value> = { readonly ok: true; readonly value: Value } | {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean; readonly retryAfterMilliseconds?: number; readonly details?: Readonly<Record<string, unknown>> };
};

export interface CdbProviderFrame {
  readonly channelId: string;
  readonly message: BrokerToAgentMessage;
}

export interface CdbProviderClosure {
  readonly channelId: string;
  readonly code: number;
  readonly reason: string;
}

interface CdbRpcClientFunctions {
  'cdb:broker:provider-frame': (frame: CdbProviderFrame) => void;
  'cdb:broker:provider-closed': (closure: CdbProviderClosure) => void;
  'cdb:broker:state-changed': (state: BrokerState) => void;
}

declare module 'devframe' {
  interface DevframeRpcClientFunctions extends CdbRpcClientFunctions {}
  interface DevframeServicesScopeRegistry {
    '@dvcol/cdb-devframe': typeof cdbServiceScope;
  }
}

/** DevTools Kit 0.6.1 consumes this legacy type entry. */
declare module 'devframe/types' {
  interface DevframeRpcClientFunctions extends CdbRpcClientFunctions {}
}
