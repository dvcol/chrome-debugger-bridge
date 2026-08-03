import type { ProtocolSchemaOutput } from './primitives.js';

import * as z from 'zod/mini';

import {
  bridgeErrorSchemaDefinition,
  cdpCancellationSchemaDefinition,
  cdpCommandResultSchemaDefinition,
  cdpCommandSchemaDefinition,
  cdpEventSchemaDefinition,
  connectionLimitsSchemaDefinition,
  heartbeatParametersSchemaDefinition,
  implementationInfoSchemaDefinition,
  protocolVersionRangeSchemaDefinition,
  publishedTargetSchemaDefinition,
} from './domain.js';
import {
  exposeProtocolSchema,
  nonEmptyStringSchemaDefinition,
  positiveIntegerSchemaDefinition,

  protocolVersionSchemaDefinition,
  requestIdSchemaDefinition,
  targetIdSchemaDefinition,
} from './primitives.js';

const agentImplementationInfoSchemaDefinition = z.strictObject({
  ...implementationInfoSchemaDefinition.shape,
  role: z.literal('agent'),
});

const brokerImplementationInfoSchemaDefinition = z.strictObject({
  ...implementationInfoSchemaDefinition.shape,
  role: z.literal('broker'),
});

const agentHelloRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('agent.hello'),
  parameters: z.strictObject({
    connectionGeneration: positiveIntegerSchemaDefinition,
    features: z.array(nonEmptyStringSchemaDefinition).check(z.maxLength(256)),
    heartbeat: heartbeatParametersSchemaDefinition,
    implementation: agentImplementationInfoSchemaDefinition,
    limits: connectionLimitsSchemaDefinition,
    protocolVersions: protocolVersionRangeSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const cdpExecuteRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('cdp.execute'),
  parameters: cdpCommandSchemaDefinition,
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const agentHelloResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('agent.hello'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({
    broker: brokerImplementationInfoSchemaDefinition,
    connectionGeneration: positiveIntegerSchemaDefinition,
    features: z.array(nonEmptyStringSchemaDefinition).check(z.maxLength(256)),
    heartbeat: heartbeatParametersSchemaDefinition,
    limits: connectionLimitsSchemaDefinition,
    protocolVersion: protocolVersionSchemaDefinition,
  }),
});

const cdpExecuteResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('cdp.execute'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: cdpCommandResultSchemaDefinition,
});

const agentErrorResponseSchemaDefinition = z.strictObject({
  error: bridgeErrorSchemaDefinition,
  kind: z.literal('error'),
  method: z.enum(['agent.hello', 'cdp.execute']),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const targetPublishedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.publish'),
  parameters: z.strictObject({ target: publishedTargetSchemaDefinition }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetRevokedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.revoke'),
  parameters: z.strictObject({
    reason: z.enum(['closed', 'explicit']),
    targetGeneration: positiveIntegerSchemaDefinition,
    targetId: targetIdSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const cdpCancelledNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('cdp.cancel'),
  parameters: cdpCancellationSchemaDefinition,
  protocolVersion: protocolVersionSchemaDefinition,
});

const cdpEventNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('cdp.event'),
  parameters: cdpEventSchemaDefinition,
  protocolVersion: protocolVersionSchemaDefinition,
});

export const agentPlaneMessageSchemaDefinition = z.union([
  z.discriminatedUnion('method', [agentHelloRequestSchemaDefinition, cdpExecuteRequestSchemaDefinition]),
  z.discriminatedUnion('method', [agentHelloResponseSchemaDefinition, cdpExecuteResponseSchemaDefinition]),
  agentErrorResponseSchemaDefinition,
  z.discriminatedUnion('method', [
    targetPublishedNotificationSchemaDefinition,
    targetRevokedNotificationSchemaDefinition,
    cdpCancelledNotificationSchemaDefinition,
    cdpEventNotificationSchemaDefinition,
  ]),
]);

export const agentPlaneMessageSchema = exposeProtocolSchema(agentPlaneMessageSchemaDefinition);

export type AgentPlaneMessage = ProtocolSchemaOutput<typeof agentPlaneMessageSchema>;
