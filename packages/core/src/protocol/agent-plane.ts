import type { ProtocolSchemaOutput } from './primitives.js';

import * as z from 'zod/mini';

import {
  bridgeErrorSchemaDefinition,
  cdpCancellationSchemaDefinition,
  cdpCommandSchemaDefinition,
  connectionLimitsSchemaDefinition,
  heartbeatParametersSchemaDefinition,
  implementationInfoSchemaDefinition,
  leaseSchemaDefinition,
  protocolVersionRangeSchemaDefinition,
  publishedTargetSchemaDefinition,
  targetRevocationReasonSchemaDefinition,
} from './domain.js';
import {
  exposeProtocolSchema,
  jsonObjectSchemaDefinition,
  nonEmptyStringSchemaDefinition,
  operationIdSchemaDefinition,
  positiveIntegerSchemaDefinition,

  protocolVersionSchemaDefinition,
  requestIdSchemaDefinition,
  sessionIdSchemaDefinition,
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

/** A control-plane liveness probe; it does not carry target or CDP authority. */
const agentHeartbeatRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('agent.heartbeat'),
  parameters: z.strictObject({ connectionGeneration: positiveIntegerSchemaDefinition }),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const cdpExecuteRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('cdp.execute'),
  parameters: z.strictObject({ command: cdpCommandSchemaDefinition, lease: leaseSchemaDefinition }),
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

const agentHeartbeatResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('agent.heartbeat'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({ connectionGeneration: positiveIntegerSchemaDefinition }),
});

const cdpExecuteResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('cdp.execute'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({
    operationId: operationIdSchemaDefinition,
    value: jsonObjectSchemaDefinition,
  }),
});

const agentHelloErrorResponseSchemaDefinition = z.strictObject({
  error: bridgeErrorSchemaDefinition,
  kind: z.literal('error'),
  method: z.literal('agent.hello'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const cdpExecuteErrorResponseSchemaDefinition = z.strictObject({
  error: bridgeErrorSchemaDefinition,
  kind: z.literal('error'),
  method: z.literal('cdp.execute'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const targetPublishedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.publish'),
  parameters: z.strictObject({ target: publishedTargetSchemaDefinition }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetUpdatedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.update'),
  parameters: z.strictObject({ target: publishedTargetSchemaDefinition }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetReconciledNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.reconcile'),
  parameters: z.strictObject({ targets: z.array(publishedTargetSchemaDefinition) }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetRevokedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.revoke'),
  parameters: z.strictObject({
    reason: targetRevocationReasonSchemaDefinition,
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

const cdpSubscriptionDemandNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('cdp.subscription-demand'),
  parameters: z.strictObject({
    active: z.boolean(),
    methodPrefix: nonEmptyStringSchemaDefinition,
    sessionId: z.optional(sessionIdSchemaDefinition),
    targetGeneration: positiveIntegerSchemaDefinition,
    targetId: targetIdSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const cdpEventNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('cdp.event'),
  parameters: z.strictObject({
    method: nonEmptyStringSchemaDefinition,
    parameters: jsonObjectSchemaDefinition,
    sessionId: z.optional(sessionIdSchemaDefinition),
    targetGeneration: positiveIntegerSchemaDefinition,
    targetId: targetIdSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
});

export const agentToBrokerMessageSchemaDefinition = z.union([
  agentHelloRequestSchemaDefinition,
  agentHeartbeatRequestSchemaDefinition,
  cdpExecuteResponseSchemaDefinition,
  cdpExecuteErrorResponseSchemaDefinition,
  z.discriminatedUnion('method', [
    targetPublishedNotificationSchemaDefinition,
    targetReconciledNotificationSchemaDefinition,
    targetUpdatedNotificationSchemaDefinition,
    targetRevokedNotificationSchemaDefinition,
    cdpEventNotificationSchemaDefinition,
  ]),
]);

export const brokerToAgentMessageSchemaDefinition = z.union([
  agentHelloResponseSchemaDefinition,
  agentHeartbeatResponseSchemaDefinition,
  agentHelloErrorResponseSchemaDefinition,
  cdpExecuteRequestSchemaDefinition,
  cdpCancelledNotificationSchemaDefinition,
  cdpSubscriptionDemandNotificationSchemaDefinition,
]);

export const agentPlaneMessageSchemaDefinition = z.union([
  agentToBrokerMessageSchemaDefinition,
  brokerToAgentMessageSchemaDefinition,
]);

export const agentToBrokerMessageSchema = exposeProtocolSchema(agentToBrokerMessageSchemaDefinition);
export const brokerToAgentMessageSchema = exposeProtocolSchema(brokerToAgentMessageSchemaDefinition);
export const agentPlaneMessageSchema = exposeProtocolSchema(agentPlaneMessageSchemaDefinition);

export type AgentToBrokerMessage = ProtocolSchemaOutput<typeof agentToBrokerMessageSchema>;
export type BrokerToAgentMessage = ProtocolSchemaOutput<typeof brokerToAgentMessageSchema>;
export type AgentPlaneMessage = ProtocolSchemaOutput<typeof agentPlaneMessageSchema>;
