import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as z from 'zod/mini';

export type ProtocolSchemaOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;

export type JsonValueShape = boolean | null | number | string | JsonValueShape[] | JsonObjectShape;

export interface JsonObjectShape {
  [propertyName: string]: JsonValueShape;
}

export function exposeProtocolSchema<Schema extends StandardSchemaV1>(
  schema: Schema,
): StandardSchemaV1<StandardSchemaV1.InferInput<Schema>, StandardSchemaV1.InferOutput<Schema>> {
  const standardProperties = schema['~standard'];
  return {
    '~standard': {
      validate: standardProperties.validate,
      vendor: standardProperties.vendor,
      version: standardProperties.version,
    },
  };
}

export const protocolVersionSchemaDefinition = z.literal(1);
export const positiveIntegerSchemaDefinition = z.int().check(z.gte(1));
export const nonEmptyStringSchemaDefinition = z.string().check(z.minLength(1), z.maxLength(256));
export const shortTextSchemaDefinition = z.string().check(z.minLength(1), z.maxLength(4_096));
export const requestIdSchemaDefinition = z.uuid();
export const targetIdSchemaDefinition = z.uuid();
export const scopeIdSchemaDefinition = z.uuid();
export const leaseIdSchemaDefinition = z.uuid();
export const subscriptionIdSchemaDefinition = z.uuid();
export const operationIdSchemaDefinition = z.uuid();
export const instanceIdSchemaDefinition = z.uuid();
export const timestampSchemaDefinition = z.iso.datetime({ offset: true });
export const jsonValueSchemaDefinition: z.ZodMiniType<JsonValueShape> = z.json();
export const jsonObjectSchemaDefinition: z.ZodMiniType<JsonObjectShape> = z.record(
  z.string(),
  jsonValueSchemaDefinition,
);

export const protocolVersionSchema = exposeProtocolSchema(protocolVersionSchemaDefinition);
export const requestIdSchema = exposeProtocolSchema(requestIdSchemaDefinition);
export const targetIdSchema = exposeProtocolSchema(targetIdSchemaDefinition);
export const scopeIdSchema = exposeProtocolSchema(scopeIdSchemaDefinition);
export const leaseIdSchema = exposeProtocolSchema(leaseIdSchemaDefinition);
export const subscriptionIdSchema = exposeProtocolSchema(subscriptionIdSchemaDefinition);
export const operationIdSchema = exposeProtocolSchema(operationIdSchemaDefinition);
export const instanceIdSchema = exposeProtocolSchema(instanceIdSchemaDefinition);
export const timestampSchema = exposeProtocolSchema(timestampSchemaDefinition);
export const jsonValueSchema = exposeProtocolSchema(jsonValueSchemaDefinition);
/** Validates forward-compatible JSON objects used only by named CDP payload and safe error-detail fields. */
export const jsonObjectSchema = exposeProtocolSchema(jsonObjectSchemaDefinition);

export type ProtocolVersion = ProtocolSchemaOutput<typeof protocolVersionSchema>;
export type RequestId = ProtocolSchemaOutput<typeof requestIdSchema>;
export type TargetId = ProtocolSchemaOutput<typeof targetIdSchema>;
export type ScopeId = ProtocolSchemaOutput<typeof scopeIdSchema>;
export type LeaseId = ProtocolSchemaOutput<typeof leaseIdSchema>;
export type SubscriptionId = ProtocolSchemaOutput<typeof subscriptionIdSchema>;
export type OperationId = ProtocolSchemaOutput<typeof operationIdSchema>;
export type InstanceId = ProtocolSchemaOutput<typeof instanceIdSchema>;
export type Timestamp = ProtocolSchemaOutput<typeof timestampSchema>;
export type JsonValue = ProtocolSchemaOutput<typeof jsonValueSchema>;
export type JsonObject = ProtocolSchemaOutput<typeof jsonObjectSchema>;
