import { expect, it, vi } from 'vitest';

import { defineAgentConnection } from '../src/agent-target-connection.js';
import { createTargetBroker, defineTargetBroker } from '../src/broker.js';
import { defineEmbeddedBridge } from '../src/embedded.js';

it('validates broker configuration without allocating runtime resources', () => {
  expect.assertions(5);
  const generateId = vi.fn();
  const now = vi.fn();
  const definition = { generateId, now, timing: { commandTimeoutMilliseconds: null } };
  expect(defineTargetBroker(definition)).toBe(definition);
  expect(defineEmbeddedBridge(definition)).toBe(definition);
  expect(generateId).not.toHaveBeenCalled();
  expect(now).not.toHaveBeenCalled();
  expect(defineTargetBroker(definition).timing.commandTimeoutMilliseconds).toBeNull();
});

it('shares invalid timing behavior with construction and connection helpers', () => {
  expect.assertions(3);
  const definition = { timing: { commandTimeoutMilliseconds: -1 } };
  expect(() => defineTargetBroker(definition)).toThrow('commandTimeoutMilliseconds');
  expect(() => createTargetBroker(definition)).toThrow('commandTimeoutMilliseconds');
  expect(() => defineAgentConnection({ timing: { heartbeatIntervalMilliseconds: 0 } })).toThrow('heartbeatIntervalMilliseconds');
});
