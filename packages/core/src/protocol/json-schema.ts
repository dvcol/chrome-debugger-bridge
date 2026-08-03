import * as z from 'zod/mini';

import { agentPlaneMessageSchemaDefinition } from './agent-plane.js';
import { clientPlaneMessageSchemaDefinition } from './client-plane.js';

const protocolMessageSchemaDefinition = z.union([
  agentPlaneMessageSchemaDefinition,
  clientPlaneMessageSchemaDefinition,
]);

export function createProtocolJsonSchema(): Record<string, unknown> {
  return {
    $id: 'urn:dvcol:chrome-debugger-bridge:protocol:1',
    ...z.toJSONSchema(protocolMessageSchemaDefinition),
  };
}
