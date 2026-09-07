import type { ClientAuthority } from '../src/broker.js';
import type { PublishedTarget } from '../src/protocol.js';

import { expect, it } from 'vitest';

import { createTargetBroker } from '../src/broker.js';

it.each(['unchanged', 'unrelated-revocation', 'revoked', 'unavailable', 'narrowed'] as const)(
  'refreshes %s authority without cancelling commands whose leases remain authorized',
  async (change) => {
    expect.assertions(2);
    const target: PublishedTarget = {
      availability: 'available',
      capabilities: { level: 'interact' },
      generation: 1,
      id: 'target-1',
      scopeId: 'scope-1',
      type: 'page',
    };
    const authority = {
      connectionId: 'connection-1',
      principalId: 'principal-1',
      targetGrants: [
        { bindingId: 'binding-1', capabilities: { level: 'interact' }, targetGeneration: 1, targetId: target.id },
        { bindingId: 'binding-2', capabilities: { level: 'interact' }, targetGeneration: 1, targetId: 'target-2' },
      ],
    } satisfies ClientAuthority;
    const broker = createTargetBroker();
    broker.publishTarget(target);
    broker.registerTargetExecutor(target, {
      async execute(_command, signal) {
        broker.refreshClientAuthority({
          ...authority,
          ...(change === 'unavailable' ? { authorityAvailable: false } : {}),
          targetGrants: change === 'revoked'
            ? []
            : change === 'narrowed'
              ? [{ bindingId: 'binding-1', capabilities: { level: 'observe' }, targetGeneration: 1, targetId: target.id }]
              : change === 'unrelated-revocation' ? authority.targetGrants.slice(0, 1) : authority.targetGrants,
        });
        expect(signal.aborted).toBe(!['unchanged', 'unrelated-revocation'].includes(change));
        return { inserted: true };
      },
    });
    const lease = broker.acquireLease({
      durationMilliseconds: 1_000,
      mode: 'exclusive-control',
      requestedMethods: ['Input.insertText'],
      targetGeneration: 1,
      targetId: target.id,
    }, authority);
    try {
      const result = broker.executeCommand({
        leaseId: lease.id,
        method: 'Input.insertText',
        operationId: 'operation-1',
        parameters: { text: 'Example' },
        targetGeneration: 1,
        targetId: target.id,
      }, authority);
      if (['unchanged', 'unrelated-revocation'].includes(change))
        await expect(result).resolves.toMatchObject({ value: { inserted: true } });
      else await expect(result).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    } finally {
      broker.dispose();
    }
  },
);
