import type {
  AgentAuthenticationAdapter,
  AuthenticatedPrincipal,
  ClientAuthenticationAdapter,
  MountedAuthenticatedWebSocketBridge,
} from '@dvcol/cdb-websocket/node';

import {
  connectNodeClientWebSocket,
  mountAuthenticatedWebSocketBridge,
} from '@dvcol/cdb-websocket/node';

type Equal<Left, Right>
  = (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
        ? true
        : false
    : false;

type Expect<Value extends true> = Value;
type PrincipalRoleIsLiteral = Expect<Equal<AuthenticatedPrincipal['role'], 'agent' | 'client'>>;

void connectNodeClientWebSocket;
void mountAuthenticatedWebSocketBridge;
void (0 as unknown as AgentAuthenticationAdapter<AuthenticatedPrincipal>);
void (0 as unknown as ClientAuthenticationAdapter<AuthenticatedPrincipal>);
void (0 as unknown as MountedAuthenticatedWebSocketBridge);
void (0 as unknown as PrincipalRoleIsLiteral);
