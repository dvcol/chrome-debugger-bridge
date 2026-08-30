import type { PublishedTarget } from '../src/protocol.js';

import { describe, expect, it } from 'vitest';

import { createAgentSession } from '../src/agent.js';

function target(generation: number): PublishedTarget {
  return {
    availability: 'available',
    capabilities: { level: 'inspect' },
    generation,
    id: 'target-1',
    scopeId: 'scope-1',
    title: 'Target',
    type: 'page',
  };
}

describe('createAgentSession', () => {
  it('keeps a target reference stable across generation renewal and temporary unavailability', () => {
    expect.assertions(4);
    const session = createAgentSession();
    const first = session.project([target(1)])[0]!;
    session.setUnavailable('target-1');
    const unavailable = session.resolve(first.targetReference);
    const renewed = session.project([target(2)])[0]!;

    expect(first.targetReference).toBe('t1');
    expect(unavailable?.available).toBe(false);
    expect(renewed).toMatchObject({ available: true, targetGeneration: 2, targetReference: 't1' });
    expect(session.resolve('t1')).toStrictEqual(renewed);
  });

  it('deletes references on explicit revocation', () => {
    expect.assertions(1);
    const session = createAgentSession();
    session.project([target(1)]);
    session.revoke('target-1');

    expect(session.resolve('t1')).toBeUndefined();
  });
});
