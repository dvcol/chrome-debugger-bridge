import { expect, it } from 'vitest';

import { agentAuthenticationMessageSchema } from '../src/protocol.js';

const validAuthenticationBegin = {
  kind: 'request',
  method: 'agent.auth.begin',
  parameters: {
    agentId: '10000000-0000-4000-8000-000000000001',
    clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    endpointPath: '/cdb/agent',
    origin: 'chrome-extension://bridge-test',
    protocolVersions: { maximum: 1, minimum: 1 },
    role: 'agent',
  },
  protocolVersion: 1,
  requestId: '70000000-0000-4000-8000-000000000001',
} as const;

it('validates strict role-bound authentication envelopes and exact proof encoding', async () => {
  expect.assertions(6);
  const validResult = await agentAuthenticationMessageSchema['~standard'].validate(validAuthenticationBegin);
  const roleConfusionResult = await agentAuthenticationMessageSchema['~standard'].validate({
    ...validAuthenticationBegin,
    parameters: { ...validAuthenticationBegin.parameters, role: 'client' },
  });
  const unknownFieldResult = await agentAuthenticationMessageSchema['~standard'].validate({
    ...validAuthenticationBegin,
    parameters: { ...validAuthenticationBegin.parameters, credential: 'must-not-pass' },
  });
  const shortProofResult = await agentAuthenticationMessageSchema['~standard'].validate({
    kind: 'request',
    method: 'agent.auth.finish',
    parameters: {
      connectionId: '20000000-0000-4000-8000-000000000001',
      credentialId: '30000000-0000-4000-8000-000000000001',
      proof: 'too-short',
    },
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000002',
  });
  const noncanonicalProofResult = await agentAuthenticationMessageSchema['~standard'].validate({
    kind: 'request',
    method: 'agent.auth.finish',
    parameters: {
      connectionId: '20000000-0000-4000-8000-000000000001',
      credentialId: '30000000-0000-4000-8000-000000000001',
      proof: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
    protocolVersion: 1,
    requestId: '70000000-0000-4000-8000-000000000003',
  });

  expect(validResult).toHaveProperty('value');
  expect(roleConfusionResult).toHaveProperty('issues');
  expect(unknownFieldResult).toHaveProperty('issues');
  expect(shortProofResult).toHaveProperty('issues');
  expect(noncanonicalProofResult).toHaveProperty('issues');
  expect(Object.keys(agentAuthenticationMessageSchema)).toEqual(['~standard']);
});
