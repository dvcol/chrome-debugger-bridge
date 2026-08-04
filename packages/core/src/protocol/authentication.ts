import type { ProtocolSchemaOutput } from './primitives.js';

import * as z from 'zod/mini';

import { protocolVersionRangeSchemaDefinition } from './domain.js';
import {
  exposeProtocolSchema,
  instanceIdSchemaDefinition,
  protocolVersionSchemaDefinition,
  requestIdSchemaDefinition,
  timestampSchemaDefinition,
} from './primitives.js';

const base64UrlSchemaDefinition = z.string().check(
  z.length(43),
  z.regex(/^[\w-]{42}[AEIMQUYcgkosw048]$/),
);
const pairingCodeSchemaDefinition = z.string().check(z.regex(/^\d{6}$/));
const endpointPathSchemaDefinition = z.string().check(
  z.minLength(1),
  z.maxLength(256),
  z.regex(/^\//),
);
const originSchemaDefinition = z.string().check(z.minLength(1), z.maxLength(2_048));

export const agentAuthenticationBeginRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('agent.auth.begin'),
  parameters: z.strictObject({
    agentId: instanceIdSchemaDefinition,
    clientNonce: base64UrlSchemaDefinition,
    credentialId: z.optional(instanceIdSchemaDefinition),
    endpointPath: endpointPathSchemaDefinition,
    expectedBrokerId: z.optional(instanceIdSchemaDefinition),
    origin: originSchemaDefinition,
    protocolVersions: protocolVersionRangeSchemaDefinition,
    role: z.literal('agent'),
  }),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

export const agentAuthenticationBeginResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('agent.auth.begin'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({
    brokerId: instanceIdSchemaDefinition,
    connectionId: instanceIdSchemaDefinition,
    credentialId: z.optional(instanceIdSchemaDefinition),
    endpointPath: endpointPathSchemaDefinition,
    expiresAt: timestampSchemaDefinition,
    pairingRequired: z.boolean(),
    protocolVersion: protocolVersionSchemaDefinition,
    serverNonce: base64UrlSchemaDefinition,
  }),
});

export const agentPairingFinishRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('agent.pair.finish'),
  parameters: z.strictObject({
    connectionId: instanceIdSchemaDefinition,
    pairingCode: pairingCodeSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

export const agentPairingFinishResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('agent.pair.finish'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({
    brokerId: instanceIdSchemaDefinition,
    credential: base64UrlSchemaDefinition,
    credentialId: instanceIdSchemaDefinition,
  }),
});

export const agentAuthenticationFinishRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('agent.auth.finish'),
  parameters: z.strictObject({
    connectionId: instanceIdSchemaDefinition,
    credentialId: instanceIdSchemaDefinition,
    proof: base64UrlSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

export const agentAuthenticationFinishResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('agent.auth.finish'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({
    brokerProof: base64UrlSchemaDefinition,
    connectionGeneration: z.int().check(z.gte(1)),
    connectionId: instanceIdSchemaDefinition,
    principalId: instanceIdSchemaDefinition,
  }),
});

export const agentAuthenticationErrorResponseSchemaDefinition = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'AUTHENTICATION_FAILED',
      'AUTHENTICATION_REQUIRED',
      'INVALID_MESSAGE',
      'PAIRING_REQUIRED',
      'PROTOCOL_VERSION_UNSUPPORTED',
      'REQUEST_TIMEOUT',
      'TRANSPORT_CLOSED',
    ]),
    message: z.string().check(z.minLength(1), z.maxLength(4_096)),
    retryable: z.boolean(),
  }),
  kind: z.literal('error'),
  method: z.enum(['agent.auth.begin', 'agent.auth.finish', 'agent.pair.finish']),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

export const agentAuthenticationMessageSchemaDefinition = z.union([
  z.discriminatedUnion('method', [
    agentAuthenticationBeginRequestSchemaDefinition,
    agentAuthenticationFinishRequestSchemaDefinition,
    agentPairingFinishRequestSchemaDefinition,
  ]),
  z.discriminatedUnion('method', [
    agentAuthenticationBeginResponseSchemaDefinition,
    agentAuthenticationFinishResponseSchemaDefinition,
    agentPairingFinishResponseSchemaDefinition,
  ]),
  agentAuthenticationErrorResponseSchemaDefinition,
]);

export const agentAuthenticationMessageSchema = exposeProtocolSchema(agentAuthenticationMessageSchemaDefinition);

export type AgentAuthenticationMessage = ProtocolSchemaOutput<typeof agentAuthenticationMessageSchema>;
