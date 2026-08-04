import type { ProtocolSchemaOutput } from './primitives.js';

import * as z from 'zod/mini';

import {
  exposeProtocolSchema,
  instanceIdSchemaDefinition,
  jsonObjectSchemaDefinition,
  leaseIdSchemaDefinition,
  nonEmptyStringSchemaDefinition,
  operationIdSchemaDefinition,
  positiveIntegerSchemaDefinition,

  protocolVersionSchemaDefinition,
  scopeIdSchemaDefinition,
  shortTextSchemaDefinition,
  subscriptionIdSchemaDefinition,
  targetIdSchemaDefinition,
  timestampSchemaDefinition,
} from './primitives.js';

export const implementationInfoSchemaDefinition = z.strictObject({
  instanceId: instanceIdSchemaDefinition,
  name: nonEmptyStringSchemaDefinition,
  role: z.enum(['agent', 'broker', 'client']),
  version: nonEmptyStringSchemaDefinition,
});

export const protocolVersionRangeSchemaDefinition = z.strictObject({
  maximum: protocolVersionSchemaDefinition,
  minimum: protocolVersionSchemaDefinition,
});

export const connectionLimitsSchemaDefinition = z.strictObject({
  maximumArtifactBytes: positiveIntegerSchemaDefinition,
  maximumInlineResultBytes: positiveIntegerSchemaDefinition,
  maximumMessageBytes: positiveIntegerSchemaDefinition,
});

export const heartbeatParametersSchemaDefinition = z.strictObject({
  intervalMilliseconds: positiveIntegerSchemaDefinition,
  timeoutMilliseconds: positiveIntegerSchemaDefinition,
});

export const capabilityGrantSchemaDefinition = z.strictObject({
  methods: z.array(nonEmptyStringSchemaDefinition).check(z.maxLength(256)),
});

export const publishedTargetSchemaDefinition = z.strictObject({
  availability: z.literal('available'),
  capabilities: capabilityGrantSchemaDefinition,
  generation: positiveIntegerSchemaDefinition,
  id: targetIdSchemaDefinition,
  scopeId: scopeIdSchemaDefinition,
  title: z.optional(shortTextSchemaDefinition),
  type: z.literal('page'),
  url: z.optional(z.url()),
});

export const targetRevocationReasonSchemaDefinition = z.enum(['closed', 'detached', 'explicit', 'policy-invalid']);

export const leaseSchemaDefinition = z.strictObject({
  expiresAt: timestampSchemaDefinition,
  id: leaseIdSchemaDefinition,
  issuedAt: timestampSchemaDefinition,
  methods: z.array(nonEmptyStringSchemaDefinition).check(z.maxLength(256)),
  mode: z.literal('shared-read'),
  targetGeneration: positiveIntegerSchemaDefinition,
  targetId: targetIdSchemaDefinition,
});

export const cdpCommandSchemaDefinition = z.strictObject({
  leaseId: leaseIdSchemaDefinition,
  method: nonEmptyStringSchemaDefinition,
  operationId: operationIdSchemaDefinition,
  parameters: z.optional(jsonObjectSchemaDefinition),
  targetGeneration: positiveIntegerSchemaDefinition,
  targetId: targetIdSchemaDefinition,
});

export const cdpCommandResultSchemaDefinition = z.strictObject({
  operationId: operationIdSchemaDefinition,
  value: jsonObjectSchemaDefinition,
});

export const cdpCancellationSchemaDefinition = z.strictObject({
  operationId: operationIdSchemaDefinition,
  targetGeneration: positiveIntegerSchemaDefinition,
  targetId: targetIdSchemaDefinition,
});

export const cdpSubscriptionMatchSchemaDefinition = z.union([
  z.strictObject({ method: nonEmptyStringSchemaDefinition }),
  z.strictObject({ methodPrefix: nonEmptyStringSchemaDefinition }),
]);

export const cdpSubscriptionBufferSchemaDefinition = z.strictObject({
  capacity: positiveIntegerSchemaDefinition,
  overflowStrategy: z.enum(['disconnect', 'drop-newest', 'drop-oldest']),
});

export const cdpSubscriptionRequestSchemaDefinition = z.strictObject({
  buffer: cdpSubscriptionBufferSchemaDefinition,
  leaseId: leaseIdSchemaDefinition,
  match: cdpSubscriptionMatchSchemaDefinition,
  targetGeneration: positiveIntegerSchemaDefinition,
  targetId: targetIdSchemaDefinition,
});

export const cdpEventSchemaDefinition = z.strictObject({
  method: nonEmptyStringSchemaDefinition,
  parameters: jsonObjectSchemaDefinition,
  sequence: positiveIntegerSchemaDefinition,
  subscriptionId: subscriptionIdSchemaDefinition,
  targetGeneration: positiveIntegerSchemaDefinition,
  targetId: targetIdSchemaDefinition,
});

export const bridgeErrorCodeSchemaDefinition = z.enum([
  'ARTIFACT_EXPIRED',
  'ARTIFACT_NOT_FOUND',
  'AUTHENTICATION_FAILED',
  'AUTHENTICATION_REQUIRED',
  'CAPABILITY_DENIED',
  'CDP_COMMAND_FAILED',
  'CDP_METHOD_DENIED',
  'FEATURE_UNSUPPORTED',
  'INVALID_MESSAGE',
  'LEASE_CONFLICT',
  'LEASE_EXPIRED',
  'LEASE_REQUIRED',
  'PAIRING_REQUIRED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'REQUEST_CANCELLED',
  'REQUEST_TIMEOUT',
  'SESSION_GENERATION_STALE',
  'SESSION_NOT_FOUND',
  'SUBSCRIPTION_OVERFLOW',
  'TARGET_GENERATION_STALE',
  'TARGET_NOT_FOUND',
  'TARGET_REVOKED',
  'TRANSPORT_CLOSED',
]);

export const bridgeErrorSchemaDefinition = z.strictObject({
  code: bridgeErrorCodeSchemaDefinition,
  details: z.optional(jsonObjectSchemaDefinition),
  message: shortTextSchemaDefinition,
  retryable: z.boolean(),
});

export const implementationInfoSchema = exposeProtocolSchema(implementationInfoSchemaDefinition);
export const protocolVersionRangeSchema = exposeProtocolSchema(protocolVersionRangeSchemaDefinition);
export const connectionLimitsSchema = exposeProtocolSchema(connectionLimitsSchemaDefinition);
export const heartbeatParametersSchema = exposeProtocolSchema(heartbeatParametersSchemaDefinition);
export const capabilityGrantSchema = exposeProtocolSchema(capabilityGrantSchemaDefinition);
export const publishedTargetSchema = exposeProtocolSchema(publishedTargetSchemaDefinition);
export const targetRevocationReasonSchema = exposeProtocolSchema(targetRevocationReasonSchemaDefinition);
export const leaseSchema = exposeProtocolSchema(leaseSchemaDefinition);
export const cdpCommandSchema = exposeProtocolSchema(cdpCommandSchemaDefinition);
export const cdpCommandResultSchema = exposeProtocolSchema(cdpCommandResultSchemaDefinition);
export const cdpCancellationSchema = exposeProtocolSchema(cdpCancellationSchemaDefinition);
export const cdpSubscriptionRequestSchema = exposeProtocolSchema(cdpSubscriptionRequestSchemaDefinition);
export const cdpEventSchema = exposeProtocolSchema(cdpEventSchemaDefinition);
export const bridgeErrorCodeSchema = exposeProtocolSchema(bridgeErrorCodeSchemaDefinition);
export const bridgeErrorSchema = exposeProtocolSchema(bridgeErrorSchemaDefinition);

export type ImplementationInfo = ProtocolSchemaOutput<typeof implementationInfoSchema>;
export type ProtocolVersionRange = ProtocolSchemaOutput<typeof protocolVersionRangeSchema>;
export type ConnectionLimits = ProtocolSchemaOutput<typeof connectionLimitsSchema>;
export type HeartbeatParameters = ProtocolSchemaOutput<typeof heartbeatParametersSchema>;
export type CapabilityGrant = ProtocolSchemaOutput<typeof capabilityGrantSchema>;
export type PublishedTarget = ProtocolSchemaOutput<typeof publishedTargetSchema>;
export type TargetRevocationReason = ProtocolSchemaOutput<typeof targetRevocationReasonSchema>;
export type Lease = ProtocolSchemaOutput<typeof leaseSchema>;
export type CdpCommand = ProtocolSchemaOutput<typeof cdpCommandSchema>;
export type CdpCommandResult = ProtocolSchemaOutput<typeof cdpCommandResultSchema>;
export type CdpCancellation = ProtocolSchemaOutput<typeof cdpCancellationSchema>;
export type CdpSubscriptionRequest = ProtocolSchemaOutput<typeof cdpSubscriptionRequestSchema>;
export type CdpEvent = ProtocolSchemaOutput<typeof cdpEventSchema>;
export type BridgeErrorCode = ProtocolSchemaOutput<typeof bridgeErrorCodeSchema>;
export type BridgeError = ProtocolSchemaOutput<typeof bridgeErrorSchema>;
