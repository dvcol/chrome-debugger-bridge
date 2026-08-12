import type {
  AgentAuthenticationMessage,
  AgentPlaneMessage,
  ClientPlaneMessage,
} from '@dvcol/chrome-debugger-bridge/protocol';

import {
  agentAuthenticationMessageSchema,
  agentPlaneMessageSchema,
  clientPlaneMessageSchema,
} from '@dvcol/chrome-debugger-bridge/protocol';
import protocolJsonSchema from '@dvcol/chrome-debugger-bridge/protocol.schema.json' with { type: 'json' };

type Equal<Left, Right>
  = (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
        ? true
        : false
    : false;

type Expect<Value extends true> = Value;

type AgentValidationResult = Awaited<ReturnType<typeof agentPlaneMessageSchema['~standard']['validate']>>;
type AgentValidationOutput = Extract<AgentValidationResult, { value: unknown }>['value'];
type AgentOutputMatchesPublicType = Expect<Equal<AgentValidationOutput, AgentPlaneMessage>>;

type ClientValidationResult = Awaited<ReturnType<typeof clientPlaneMessageSchema['~standard']['validate']>>;
type ClientValidationOutput = Extract<ClientValidationResult, { value: unknown }>['value'];
type ClientOutputMatchesPublicType = Expect<Equal<ClientValidationOutput, ClientPlaneMessage>>;

type AgentHelloRequest = Extract<AgentPlaneMessage, { kind: 'request'; method: 'agent.hello' }>;
type AgentHelloRoleIsLiteral = Expect<Equal<AgentHelloRequest['parameters']['implementation']['role'], 'agent'>>;
type AgentSchemaExposesStandardInterface = Expect<Equal<keyof typeof agentPlaneMessageSchema, '~standard'>>;

const agentHelloRequest: AgentHelloRequest = {
  kind: 'request',
  method: 'agent.hello',
  parameters: {
    connectionGeneration: 1,
    features: ['bridge.cdp.read'],
    heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
    implementation: {
      instanceId: '10000000-0000-4000-8000-000000000001',
      name: 'package-consumer',
      role: 'agent',
      version: '0.0.0',
    },
    limits: {
      maximumArtifactBytes: 16_777_216,
      maximumInlineResultBytes: 65_536,
      maximumMessageBytes: 1_048_576,
    },
    protocolVersions: { maximum: 1, minimum: 1 },
  },
  protocolVersion: 1,
  requestId: '70000000-0000-4000-8000-000000000001',
};

void agentPlaneMessageSchema['~standard'].validate(agentHelloRequest);
void agentAuthenticationMessageSchema['~standard'].validate({
  kind: 'request',
  method: 'agent.auth.begin',
  parameters: {
    agentId: '10000000-0000-4000-8000-000000000001',
    clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    endpointPath: '/cdb/agent',
    origin: 'chrome-extension://package-consumer',
    protocolVersions: { maximum: 1, minimum: 1 },
    role: 'agent',
  },
  protocolVersion: 1,
  requestId: '70000000-0000-4000-8000-000000000003',
} satisfies AgentAuthenticationMessage);
void clientPlaneMessageSchema['~standard'].validate({
  kind: 'request',
  method: 'targets.list',
  parameters: {},
  protocolVersion: 1,
  requestId: '70000000-0000-4000-8000-000000000002',
} satisfies ClientPlaneMessage);
void protocolJsonSchema;

void (0 as unknown as AgentOutputMatchesPublicType);
void (0 as unknown as ClientOutputMatchesPublicType);
void (0 as unknown as AgentHelloRoleIsLiteral);
void (0 as unknown as AgentSchemaExposesStandardInterface);
