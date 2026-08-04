import type { StandardSchemaV1 } from '@standard-schema/spec';

import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  agentPlaneMessageSchema,
  agentToBrokerMessageSchema,
  brokerToAgentMessageSchema,
  brokerToClientMessageSchema,
  clientPlaneMessageSchema,
  clientToBrokerMessageSchema,
} from '../src/protocol.js';
import { createProtocolJsonSchema } from '../src/protocol/json-schema.js';

const agentInstanceId = '10000000-0000-4000-8000-000000000001';
const brokerInstanceId = '10000000-0000-4000-8000-000000000002';
const leaseId = '20000000-0000-4000-8000-000000000001';
const operationId = '30000000-0000-4000-8000-000000000001';
const scopeId = '40000000-0000-4000-8000-000000000001';
const subscriptionId = '50000000-0000-4000-8000-000000000001';
const targetId = '60000000-0000-4000-8000-000000000001';
const issuedAt = '2026-08-03T10:00:00.000Z';
const expiresAt = '2026-08-03T10:01:00.000Z';

const publishedTarget = {
  availability: 'available',
  capabilities: { methods: ['Runtime.evaluate'] },
  generation: 1,
  id: targetId,
  scopeId,
  title: 'Example target',
  type: 'page',
  url: 'https://example.com/',
} as const;

const lease = {
  expiresAt,
  id: leaseId,
  issuedAt,
  methods: ['Runtime.evaluate'],
  mode: 'shared-read',
  targetGeneration: 1,
  targetId,
} as const;

const agentHelloResponse = {
  kind: 'response',
  method: 'agent.hello',
  protocolVersion: 1,
  requestId: '70000000-0000-4000-8000-000000000013',
  result: {
    broker: {
      instanceId: brokerInstanceId,
      name: 'test-broker',
      role: 'broker',
      version: '0.0.0',
    },
    connectionGeneration: 1,
    features: ['bridge.cdp.read'],
    heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
    limits: {
      maximumArtifactBytes: 16_777_216,
      maximumInlineResultBytes: 65_536,
      maximumMessageBytes: 1_048_576,
    },
    protocolVersion: 1,
  },
} as const;

async function validateWithSchema<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<Schema>> {
  const result = await schema['~standard'].validate(value);
  if ('issues' in result) {
    throw new Error(`Protocol fixture failed validation: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

async function validateClientMessage(value: unknown) {
  return validateWithSchema(clientPlaneMessageSchema, value);
}

async function validateAgentMessage(value: unknown) {
  return validateWithSchema(agentPlaneMessageSchema, value);
}

describe('protocol schemas', () => {
  it('enforces message direction on both authenticated planes', async () => {
    expect.assertions(4);
    const brokerInfoRequest = {
      kind: 'request',
      method: 'broker.info',
      parameters: {},
      protocolVersion: 1,
      requestId: '70000000-0000-4000-8000-000000000014',
    };

    expect(await brokerToAgentMessageSchema['~standard'].validate(agentHelloResponse)).toHaveProperty('value');
    expect(await agentToBrokerMessageSchema['~standard'].validate(agentHelloResponse)).toHaveProperty('issues');
    expect(await clientToBrokerMessageSchema['~standard'].validate(brokerInfoRequest)).toHaveProperty('value');
    expect(await brokerToClientMessageSchema['~standard'].validate(brokerInfoRequest)).toHaveProperty('issues');
  });

  it('validates the minimal handshake, target, lease, CDP, cancellation, revocation, and error envelopes', async () => {
    expect.assertions(14);

    const messages = [
      {
        kind: 'request',
        method: 'agent.hello',
        parameters: {
          connectionGeneration: 1,
          features: ['bridge.cdp.read'],
          heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
          implementation: {
            instanceId: agentInstanceId,
            name: 'test-agent',
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
      },
      agentHelloResponse,
      {
        kind: 'notification',
        method: 'targets.publish',
        parameters: { target: publishedTarget },
        protocolVersion: 1,
      },
      {
        kind: 'notification',
        method: 'targets.update',
        parameters: { target: { ...publishedTarget, title: 'Updated target' } },
        protocolVersion: 1,
      },
      {
        kind: 'response',
        method: 'leases.acquire',
        protocolVersion: 1,
        requestId: '70000000-0000-4000-8000-000000000002',
        result: { lease },
      },
      {
        kind: 'request',
        method: 'cdp.send',
        parameters: {
          leaseId,
          method: 'Runtime.evaluate',
          operationId,
          parameters: { expression: 'document.title' },
          targetGeneration: 1,
          targetId,
        },
        protocolVersion: 1,
        requestId: '70000000-0000-4000-8000-000000000003',
      },
      {
        kind: 'response',
        method: 'cdp.execute',
        protocolVersion: 1,
        requestId: '70000000-0000-4000-8000-000000000004',
        result: { operationId, value: { result: { type: 'string', value: 'Example target' } } },
      },
      {
        kind: 'notification',
        method: 'cdp.event',
        parameters: {
          method: 'Runtime.consoleAPICalled',
          parameters: { args: [{ type: 'string', value: 'ready' }] },
          sequence: 1,
          subscriptionId,
          targetGeneration: 1,
          targetId,
        },
        protocolVersion: 1,
      },
      {
        kind: 'notification',
        method: 'cdp.cancel',
        parameters: { operationId, targetGeneration: 1, targetId },
        protocolVersion: 1,
      },
      {
        kind: 'notification',
        method: 'targets.revoke',
        parameters: { reason: 'policy-invalid', targetGeneration: 1, targetId },
        protocolVersion: 1,
      },
      {
        kind: 'notification',
        method: 'targets.updated',
        parameters: { target: { ...publishedTarget, title: 'Updated target' } },
        protocolVersion: 1,
      },
      {
        error: {
          code: 'CDP_COMMAND_FAILED',
          details: { method: 'Runtime.evaluate' },
          message: 'The command failed.',
          retryable: false,
        },
        kind: 'error',
        method: 'cdp.send',
        protocolVersion: 1,
        requestId: '70000000-0000-4000-8000-000000000005',
      },
    ];

    const schemas = [
      agentPlaneMessageSchema,
      agentPlaneMessageSchema,
      agentPlaneMessageSchema,
      agentPlaneMessageSchema,
      clientPlaneMessageSchema,
      clientPlaneMessageSchema,
      agentPlaneMessageSchema,
      clientPlaneMessageSchema,
      agentPlaneMessageSchema,
      agentPlaneMessageSchema,
      clientPlaneMessageSchema,
      clientPlaneMessageSchema,
    ] as const;

    for (const [index, message] of messages.entries()) {
      const result = await schemas[index]?.['~standard'].validate(message);
      expect(result).toHaveProperty('value');
    }
    expect(Object.keys(agentPlaneMessageSchema)).toEqual(['~standard']);
    expect(Object.keys(clientPlaneMessageSchema)).toEqual(['~standard']);
  });

  it('rejects unknown security fields while allowing JSON extension keys only in named payloads', async () => {
    expect.assertions(7);

    const baseCommand = {
      kind: 'request',
      method: 'cdp.send',
      parameters: {
        leaseId,
        method: 'Runtime.evaluate',
        operationId,
        parameters: {
          awaitPromise: true,
          customExtension: { nested: ['allowed', 1, true, null] },
          expression: 'document.title',
        },
        targetGeneration: 1,
        targetId,
      },
      protocolVersion: 1,
      requestId: '70000000-0000-4000-8000-000000000006',
    };

    const validCommandResult = await clientPlaneMessageSchema['~standard'].validate(baseCommand);
    const unknownEnvelopeResult = await clientPlaneMessageSchema['~standard'].validate({
      ...baseCommand,
      credential: 'must-not-be-accepted',
    });
    const rawChromeIdentifierResult = await agentPlaneMessageSchema['~standard'].validate({
      kind: 'notification',
      method: 'targets.publish',
      parameters: { target: { ...publishedTarget, tabId: 42 } },
      protocolVersion: 1,
    });
    const roleConfusionResult = await agentPlaneMessageSchema['~standard'].validate({
      kind: 'request',
      method: 'agent.hello',
      parameters: {
        connectionGeneration: 1,
        features: [],
        heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
        implementation: {
          instanceId: agentInstanceId,
          name: 'confused-client',
          role: 'client',
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
      requestId: '70000000-0000-4000-8000-000000000010',
    });
    const brokerRoleConfusionResult = await agentPlaneMessageSchema['~standard'].validate({
      ...agentHelloResponse,
      result: {
        ...agentHelloResponse.result,
        broker: { ...agentHelloResponse.result.broker, role: 'agent' },
      },
    });
    const extensibleResult = await clientPlaneMessageSchema['~standard'].validate({
      kind: 'response',
      method: 'cdp.send',
      protocolVersion: 1,
      requestId: '70000000-0000-4000-8000-000000000006',
      result: {
        operationId,
        value: { nested: { implementationDefined: ['allowed'] } },
      },
    });
    const extensibleErrorResult = await clientPlaneMessageSchema['~standard'].validate({
      error: {
        code: 'TARGET_REVOKED',
        details: { policyDefinedReason: { category: 'explicit' } },
        message: 'The target was revoked.',
        retryable: false,
      },
      kind: 'error',
      method: 'cdp.send',
      protocolVersion: 1,
      requestId: '70000000-0000-4000-8000-000000000006',
    });

    expect(validCommandResult).toHaveProperty('value');
    expect(unknownEnvelopeResult).toHaveProperty('issues');
    expect(rawChromeIdentifierResult).toHaveProperty('issues');
    expect(roleConfusionResult).toHaveProperty('issues');
    expect(brokerRoleConfusionResult).toHaveProperty('issues');
    expect(extensibleResult).toHaveProperty('value');
    expect(extensibleErrorResult).toHaveProperty('value');
  });

  it('generates the published Draft 2020-12 schema from the runtime definitions', () => {
    expect.assertions(7);

    const jsonSchema = createProtocolJsonSchema();
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validateProtocolMessage = ajv.compile(jsonSchema);
    const validHello = {
      kind: 'request',
      method: 'agent.hello',
      parameters: {
        connectionGeneration: 1,
        features: ['bridge.cdp.read'],
        heartbeat: { intervalMilliseconds: 15_000, timeoutMilliseconds: 45_000 },
        implementation: {
          instanceId: agentInstanceId,
          name: 'test-agent',
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
      requestId: '70000000-0000-4000-8000-000000000011',
    };
    const forwardCompatibleCommand = {
      kind: 'request',
      method: 'cdp.send',
      parameters: {
        leaseId,
        method: 'Runtime.evaluate',
        operationId,
        parameters: { futureCdpParameter: { nested: [true, 1, null] } },
        targetGeneration: 1,
        targetId,
      },
      protocolVersion: 1,
      requestId: '70000000-0000-4000-8000-000000000012',
    };
    const validAuthenticationBegin = {
      kind: 'request',
      method: 'agent.auth.begin',
      parameters: {
        agentId: agentInstanceId,
        clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        endpointPath: '/__chrome_debugger_bridge/agent',
        origin: 'chrome-extension://abcdefghijklmnop',
        protocolVersions: { maximum: 1, minimum: 1 },
        role: 'agent',
      },
      protocolVersion: 1,
      requestId: '70000000-0000-4000-8000-000000000013',
    };

    expect(jsonSchema.$id).toBe('urn:dvcol:chrome-debugger-bridge:protocol:1');
    expect(jsonSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(validateProtocolMessage(validHello)).toBe(true);
    expect(validateProtocolMessage({ ...validHello, credential: 'rejected' })).toBe(false);
    expect(validateProtocolMessage({
      ...validHello,
      parameters: {
        ...validHello.parameters,
        implementation: { ...validHello.parameters.implementation, role: 'client' },
      },
    })).toBe(false);
    expect(validateProtocolMessage(forwardCompatibleCommand)).toBe(true);
    expect(validateProtocolMessage(validAuthenticationBegin)).toBe(true);
  });

  it('completes one validated in-memory broker and client command round trip', async () => {
    expect.assertions(4);

    interface InMemoryProtocolChannel {
      request: (message: unknown) => Promise<unknown>;
    }

    function createInMemoryProtocolChannel(
      handleRequest: (message: unknown) => Promise<unknown>,
    ): InMemoryProtocolChannel {
      return {
        async request(message) {
          const response = await handleRequest(structuredClone(message));
          return structuredClone(response);
        },
      };
    }

    let forwardedAgentRequest: unknown;

    async function executeAgentCommand(rawMessage: unknown): Promise<unknown> {
      forwardedAgentRequest = rawMessage;
      const message = await validateAgentMessage(rawMessage);
      if (message.kind !== 'request' || message.method !== 'cdp.execute') {
        throw new Error('The test agent received an unsupported message.');
      }
      return validateAgentMessage({
        kind: 'response',
        method: 'cdp.execute',
        protocolVersion: 1,
        requestId: message.requestId,
        result: {
          operationId: message.parameters.operationId,
          value: { result: { type: 'string', value: 'Example target' } },
        },
      });
    }

    const agentChannel = createInMemoryProtocolChannel(executeAgentCommand);

    async function handleBrokerRequest(rawMessage: unknown): Promise<unknown> {
      const message = await validateClientMessage(rawMessage);
      if (message.kind !== 'request') {
        throw new Error('The test broker received a non-request message.');
      }
      if (message.method === 'targets.list') {
        return validateClientMessage({
          kind: 'response',
          method: 'targets.list',
          protocolVersion: 1,
          requestId: message.requestId,
          result: { targets: [publishedTarget] },
        });
      }
      if (message.method === 'leases.acquire') {
        return validateClientMessage({
          kind: 'response',
          method: 'leases.acquire',
          protocolVersion: 1,
          requestId: message.requestId,
          result: { lease },
        });
      }
      if (message.method === 'cdp.send') {
        const agentResponse = await agentChannel.request({
          kind: 'request',
          method: 'cdp.execute',
          parameters: message.parameters,
          protocolVersion: 1,
          requestId: message.requestId,
        });
        const validatedAgentResponse = await validateAgentMessage(agentResponse);
        if (validatedAgentResponse.kind !== 'response' || validatedAgentResponse.method !== 'cdp.execute') {
          throw new Error('The test agent returned an unsupported response.');
        }
        return validateClientMessage({
          kind: 'response',
          method: 'cdp.send',
          protocolVersion: 1,
          requestId: message.requestId,
          result: validatedAgentResponse.result,
        });
      }
      throw new Error(`The test broker does not implement ${message.method}.`);
    }

    const brokerChannel = createInMemoryProtocolChannel(handleBrokerRequest);
    const inMemoryClient = {
      async acquireLease() {
        return validateClientMessage(await brokerChannel.request({
          kind: 'request',
          method: 'leases.acquire',
          parameters: {
            durationMilliseconds: 60_000,
            mode: 'shared-read',
            requestedMethods: ['Runtime.evaluate'],
            targetGeneration: 1,
            targetId,
          },
          protocolVersion: 1,
          requestId: '70000000-0000-4000-8000-000000000008',
        }));
      },
      async listTargets() {
        return validateClientMessage(await brokerChannel.request({
          kind: 'request',
          method: 'targets.list',
          parameters: {},
          protocolVersion: 1,
          requestId: '70000000-0000-4000-8000-000000000007',
        }));
      },
      async sendCdpCommand() {
        return validateClientMessage(await brokerChannel.request({
          kind: 'request',
          method: 'cdp.send',
          parameters: {
            leaseId,
            method: 'Runtime.evaluate',
            operationId,
            parameters: { expression: 'document.title' },
            targetGeneration: 1,
            targetId,
          },
          protocolVersion: 1,
          requestId: '70000000-0000-4000-8000-000000000009',
        }));
      },
    };

    const targetsResponse = await inMemoryClient.listTargets();
    const leaseResponse = await inMemoryClient.acquireLease();
    const commandResponse = await inMemoryClient.sendCdpCommand();

    expect(targetsResponse).toMatchObject({ result: { targets: [{ id: targetId }] } });
    expect(leaseResponse).toMatchObject({ result: { lease: { id: leaseId } } });
    expect(commandResponse).toMatchObject({
      result: { operationId, value: { result: { value: 'Example target' } } },
    });
    expect(forwardedAgentRequest).toMatchObject({ parameters: { targetId } });
  });
});
