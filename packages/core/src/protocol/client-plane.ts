import type { ProtocolSchemaOutput } from './primitives.js';

import * as z from 'zod/mini';

import {
  bridgeErrorSchemaDefinition,
  cdpCommandResultSchemaDefinition,
  cdpCommandSchemaDefinition,
  cdpEventSchemaDefinition,
  cdpSubscriptionOverflowSchemaDefinition,
  cdpSubscriptionRequestSchemaDefinition,
  connectionLimitsSchemaDefinition,
  implementationInfoSchemaDefinition,
  leaseModeSchemaDefinition,
  leaseSchemaDefinition,
  publishedTargetSchemaDefinition,
  targetRevocationReasonSchemaDefinition,
} from './domain.js';
import {
  exposeProtocolSchema,
  nonEmptyStringSchemaDefinition,
  positiveIntegerSchemaDefinition,
  protocolVersionSchemaDefinition,
  requestIdSchemaDefinition,
  subscriptionIdSchemaDefinition,
  targetIdSchemaDefinition,
} from './primitives.js';

const brokerImplementationInfoSchemaDefinition = z.strictObject({
  ...implementationInfoSchemaDefinition.shape,
  role: z.literal('broker'),
});

const brokerInfoRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('broker.info'),
  parameters: z.strictObject({}),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const targetsListRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('targets.list'),
  parameters: z.strictObject({}),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const leaseAcquireRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('leases.acquire'),
  parameters: z.strictObject({
    durationMilliseconds: positiveIntegerSchemaDefinition,
    mode: leaseModeSchemaDefinition,
    requestedMethods: z.array(nonEmptyStringSchemaDefinition).check(z.maxLength(256)),
    targetGeneration: positiveIntegerSchemaDefinition,
    targetId: targetIdSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const cdpSendRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('cdp.send'),
  parameters: cdpCommandSchemaDefinition,
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const cdpSubscribeRequestEnvelopeSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('cdp.subscribe'),
  parameters: cdpSubscriptionRequestSchemaDefinition,
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const cdpUnsubscribeRequestSchemaDefinition = z.strictObject({
  kind: z.literal('request'),
  method: z.literal('cdp.unsubscribe'),
  parameters: z.strictObject({ subscriptionId: subscriptionIdSchemaDefinition }),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const brokerInfoResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('broker.info'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({
    broker: brokerImplementationInfoSchemaDefinition,
    features: z.array(nonEmptyStringSchemaDefinition).check(z.maxLength(256)),
    limits: connectionLimitsSchemaDefinition,
    protocolVersion: protocolVersionSchemaDefinition,
  }),
});

const targetsListResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('targets.list'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({
    targets: z.array(publishedTargetSchemaDefinition),
  }),
});

const leaseAcquireResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('leases.acquire'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({ lease: leaseSchemaDefinition }),
});

const cdpSendResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('cdp.send'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: cdpCommandResultSchemaDefinition,
});

const cdpSubscribeResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('cdp.subscribe'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({ subscriptionId: subscriptionIdSchemaDefinition }),
});

const cdpUnsubscribeResponseSchemaDefinition = z.strictObject({
  kind: z.literal('response'),
  method: z.literal('cdp.unsubscribe'),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
  result: z.strictObject({}),
});

const clientErrorResponseSchemaDefinition = z.strictObject({
  error: bridgeErrorSchemaDefinition,
  kind: z.literal('error'),
  method: z.enum([
    'broker.info',
    'cdp.send',
    'cdp.subscribe',
    'cdp.unsubscribe',
    'leases.acquire',
    'targets.list',
  ]),
  protocolVersion: protocolVersionSchemaDefinition,
  requestId: requestIdSchemaDefinition,
});

const cdpEventNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('cdp.event'),
  parameters: cdpEventSchemaDefinition,
  protocolVersion: protocolVersionSchemaDefinition,
});

const subscriptionOverflowNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('subscriptions.overflow'),
  parameters: cdpSubscriptionOverflowSchemaDefinition,
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetPublishedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.published'),
  parameters: z.strictObject({ target: publishedTargetSchemaDefinition }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetSnapshotNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.snapshot'),
  parameters: z.strictObject({
    sequence: z.int().check(z.gte(0)),
    targets: z.array(publishedTargetSchemaDefinition),
  }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetUpdatedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.updated'),
  parameters: z.strictObject({ target: publishedTargetSchemaDefinition }),
  protocolVersion: protocolVersionSchemaDefinition,
});

const targetRevokedNotificationSchemaDefinition = z.strictObject({
  kind: z.literal('notification'),
  method: z.literal('targets.revoked'),
  parameters: z.strictObject({
    reason: targetRevocationReasonSchemaDefinition,
    targetGeneration: positiveIntegerSchemaDefinition,
    targetId: targetIdSchemaDefinition,
  }),
  protocolVersion: protocolVersionSchemaDefinition,
});

export const clientToBrokerMessageSchemaDefinition = z.discriminatedUnion('method', [
  brokerInfoRequestSchemaDefinition,
  targetsListRequestSchemaDefinition,
  leaseAcquireRequestSchemaDefinition,
  cdpSendRequestSchemaDefinition,
  cdpSubscribeRequestEnvelopeSchemaDefinition,
  cdpUnsubscribeRequestSchemaDefinition,
]);

export const brokerToClientMessageSchemaDefinition = z.union([
  z.discriminatedUnion('method', [
    brokerInfoResponseSchemaDefinition,
    targetsListResponseSchemaDefinition,
    leaseAcquireResponseSchemaDefinition,
    cdpSendResponseSchemaDefinition,
    cdpSubscribeResponseSchemaDefinition,
    cdpUnsubscribeResponseSchemaDefinition,
  ]),
  clientErrorResponseSchemaDefinition,
  z.discriminatedUnion('method', [
    cdpEventNotificationSchemaDefinition,
    subscriptionOverflowNotificationSchemaDefinition,
    targetPublishedNotificationSchemaDefinition,
    targetSnapshotNotificationSchemaDefinition,
    targetUpdatedNotificationSchemaDefinition,
    targetRevokedNotificationSchemaDefinition,
  ]),
]);

export const clientPlaneMessageSchemaDefinition = z.union([
  clientToBrokerMessageSchemaDefinition,
  brokerToClientMessageSchemaDefinition,
]);

export const clientToBrokerMessageSchema = exposeProtocolSchema(clientToBrokerMessageSchemaDefinition);
export const brokerToClientMessageSchema = exposeProtocolSchema(brokerToClientMessageSchemaDefinition);
export const clientPlaneMessageSchema = exposeProtocolSchema(clientPlaneMessageSchemaDefinition);

export type ClientToBrokerMessage = ProtocolSchemaOutput<typeof clientToBrokerMessageSchema>;
export type BrokerToClientMessage = ProtocolSchemaOutput<typeof brokerToClientMessageSchema>;
export type ClientPlaneMessage = ProtocolSchemaOutput<typeof clientPlaneMessageSchema>;
