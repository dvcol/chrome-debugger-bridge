import type { CredentialStore } from '../src/session.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryAuthorityStore } from '../src/authority.js';
import { createLogicalSessionManager, createMemoryCredentialStore } from '../src/session.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('credential stores', () => {
  async function exerciseCredentialStore(store: CredentialStore): Promise<void> {
    expect.assertions(3);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.set('agent-runner', { credential: 'secret', logicalSessionId: 'session-1' });

    await expect(store.get('agent-runner')).resolves.toStrictEqual({ credential: 'secret', logicalSessionId: 'session-1' });
    expect(listener).toHaveBeenCalledWith({ key: 'agent-runner' });
    await expect(store.delete('agent-runner')).resolves.toBeUndefined();
  }

  it('defaults to asynchronous reactive memory storage', async () => {
    await exerciseCredentialStore(createMemoryCredentialStore());
  });

  it('shares the contract with a serialized persistent implementation', async () => {
    const values = new Map<string, string>();
    const listeners = new Set<Parameters<CredentialStore['subscribe']>[0]>();
    const store: CredentialStore = {
      async delete(key) {
        if (!values.delete(key)) return;
        for (const listener of listeners) listener({ key });
      },
      async get(key) {
        const value = values.get(key);
        if (value === undefined) return undefined;
        const parsed: unknown = JSON.parse(value);
        if (
          typeof parsed !== 'object'
          || parsed === null
          || !('credential' in parsed)
          || typeof parsed.credential !== 'string'
          || !('logicalSessionId' in parsed)
          || typeof parsed.logicalSessionId !== 'string'
        ) throw new TypeError('Invalid persisted credential.');
        return { credential: parsed.credential, logicalSessionId: parsed.logicalSessionId };
      },
      async set(key, credential) {
        values.set(key, JSON.stringify(credential));
        for (const listener of listeners) listener({ key });
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    await exerciseCredentialStore(store);
  });
});

describe('logical sessions', () => {
  it('rotates resume credentials and fences credential replay during takeover', async () => {
    expect.assertions(4);
    const authorityStore = createMemoryAuthorityStore();
    const credentials = ['credential-1', 'credential-2', 'credential-3'];
    const manager = createLogicalSessionManager({
      authorityStore,
      generateCredential: () => credentials.shift()!,
      generateId: () => 'session-1',
    });
    const created = await manager.create({ connectionId: 'connection-1', metadata: { launchId: 'launch-1' }, principalId: 'principal-1' });
    const resumed = await manager.resume({ connectionId: 'connection-2', logicalSessionId: created.logicalSessionId, resumeCredential: created.resumeCredential });

    expect(created).toStrictEqual({ connectionGeneration: 1, logicalSessionId: 'session-1', resumeCredential: 'credential-1' });
    expect(resumed).toStrictEqual({ connectionGeneration: 2, logicalSessionId: 'session-1', resumeCredential: 'credential-2' });
    await expect(manager.resume({ connectionId: 'connection-3', logicalSessionId: created.logicalSessionId, resumeCredential: created.resumeCredential }))
      .rejects
      .toMatchObject({ code: 'SESSION_CREDENTIAL_INVALID' });
    await expect(authorityStore.get(created.logicalSessionId)).resolves.toMatchObject({ activeConnectionId: 'connection-2', metadata: { launchId: 'launch-1' } });
  });

  it('expires a disconnected session after the configured resume window', async () => {
    expect.assertions(2);
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const authorityStore = createMemoryAuthorityStore();
    const manager = createLogicalSessionManager({
      authorityStore,
      generateCredential: () => 'credential',
      generateId: () => 'session-1',
      timing: { resumeWindowMilliseconds: 50 },
    });
    await manager.create({ connectionId: 'connection-1', principalId: 'principal-1' });
    await manager.disconnect('session-1', 'connection-1');

    expect(await authorityStore.get('session-1')).not.toHaveProperty('activeConnectionId');
    await vi.advanceTimersByTimeAsync(50);
    await expect(authorityStore.get('session-1')).resolves.toBeUndefined();
  });

  it('retains a disconnected session when resume expiration is disabled', async () => {
    expect.assertions(1);
    vi.useFakeTimers();
    const authorityStore = createMemoryAuthorityStore();
    const manager = createLogicalSessionManager({
      authorityStore,
      generateCredential: () => 'credential',
      generateId: () => 'session-1',
      timing: { resumeWindowMilliseconds: null },
    });
    await manager.create({ connectionId: 'connection-1', principalId: 'principal-1' });
    await manager.disconnect('session-1', 'connection-1');
    await vi.advanceTimersByTimeAsync(86_400_000);

    await expect(authorityStore.get('session-1')).resolves.toMatchObject({ resumeExpiresAt: null });
  });

  it('expires immediately when the resume window is zero', async () => {
    expect.assertions(1);
    vi.useFakeTimers();
    const authorityStore = createMemoryAuthorityStore();
    const manager = createLogicalSessionManager({
      authorityStore,
      generateCredential: () => 'credential',
      generateId: () => 'session-1',
      timing: { resumeWindowMilliseconds: 0 },
    });
    await manager.create({ connectionId: 'connection-1', principalId: 'principal-1' });
    await manager.disconnect('session-1', 'connection-1');
    await vi.runAllTimersAsync();

    await expect(authorityStore.get('session-1')).resolves.toBeUndefined();
  });

  it('rejects runtime metadata that JSON would silently coerce', async () => {
    expect.assertions(1);
    const manager = createLogicalSessionManager({
      authorityStore: createMemoryAuthorityStore(),
      generateCredential: () => 'credential',
      generateId: () => 'session-1',
    });

    await expect(manager.create({
      connectionId: 'connection-1',
      metadata: { invalid: Number.NaN },
      principalId: 'principal-1',
    })).rejects.toThrow('JSON-compatible');
  });
});
