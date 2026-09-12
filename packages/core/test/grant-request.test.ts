import type { AuthorityBinding, PublishedTarget } from '../src/index.js';

import { afterEach, expect, it, vi } from 'vitest';

import { createGrantRequestCoordinator, createMemoryAuthorityStore } from '../src/index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const provider = { connectionGeneration: 1, principalId: 'provider-installation' };
const target: PublishedTarget = {
  availability: 'available',
  capabilities: { level: 'debug' },
  generation: 1,
  id: '075289f0-0ce1-459f-82ed-40eb76a1b010',
  scopeId: '075289f0-0ce1-459f-82ed-40eb76a1b011',
  type: 'page',
};
const unrelatedBinding: AuthorityBinding = {
  bindingId: 'unrelated-binding',
  capabilities: { level: 'observe' },
  targetGeneration: 1,
  targetId: '075289f0-0ce1-459f-82ed-40eb76a1b012',
};

function setup() {
  const authorityStore = createMemoryAuthorityStore([{
    activeConnectionId: 'client-connection',
    bindings: [unrelatedBinding],
    connectionGeneration: 1,
    logicalSessionId: 'session',
    principalId: 'client',
  }]);
  const targets = new Map([[target.id, { providerPrincipalId: provider.principalId, target }]]);
  const providerGenerations = new Map([[provider.principalId, 1]]);
  const coordinator = createGrantRequestCoordinator({
    authorityStore,
    targetDirectory: {
      getProviderConnectionGeneration: principalId => providerGenerations.get(principalId),
      getTarget: targetId => targets.get(targetId),
    },
  });
  return { authorityStore, coordinator, providerGenerations, targets };
}

it('commits exact approved authority once without replacing unrelated grants', async () => {
  expect.assertions(5);
  const { authorityStore, coordinator } = setup();
  const request = await coordinator.request({
    capabilities: { level: 'interact' },
    logicalSessionId: 'session',
    principalId: 'client',
  });
  const claim = coordinator.claim(request.id, provider);
  const bindings = await coordinator.complete(claim, [{ targetGeneration: target.generation, targetId: target.id }]);

  expect(bindings).toEqual([expect.objectContaining({
    capabilities: { level: 'interact' },
    targetGeneration: 1,
    targetId: target.id,
  })]);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding, ...bindings]);
  expect(coordinator.getRequest(request.id)?.state).toBe('granted');
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_CLAIM_INVALID' });
  await coordinator.dispose();
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
});

it('rejects targets outside the request, provider ownership, generation, or requested capability', async () => {
  expect.assertions(5);
  const { authorityStore, coordinator, targets } = setup();
  const request = await coordinator.request({
    capabilities: { level: 'interact' },
    logicalSessionId: 'session',
    principalId: 'client',
    requestedTargetId: target.id,
  });
  const claim = coordinator.claim(request.id, provider);
  const otherTarget = { ...target, id: unrelatedBinding.targetId };
  targets.set(otherTarget.id, { providerPrincipalId: provider.principalId, target: otherTarget });
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: otherTarget.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_TARGET_DENIED' });
  targets.set(target.id, { providerPrincipalId: 'other-provider', target });
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_TARGET_UNAVAILABLE' });
  targets.set(target.id, { providerPrincipalId: provider.principalId, target });
  await expect(coordinator.complete(claim, [{ targetGeneration: 2, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_TARGET_UNAVAILABLE' });
  targets.set(target.id, { providerPrincipalId: provider.principalId, target: { ...target, capabilities: { level: 'inspect' } } });
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_TARGET_DENIED' });
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  await coordinator.dispose();
});

it('reconciles an approved live scope while preserving other grants and unchanged binding identities', async () => {
  expect.assertions(6);
  const { authorityStore, coordinator, providerGenerations, targets } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const releasedClaim = coordinator.claim(request.id, provider);
  coordinator.release(releasedClaim);
  const claim = coordinator.claim(request.id, provider);
  await expect(coordinator.complete(releasedClaim, [{ targetGeneration: 1, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_CLAIM_INVALID' });
  const initial = await coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }]);
  const nextTarget = { ...target, id: '075289f0-0ce1-459f-82ed-40eb76a1b013' };
  targets.set(nextTarget.id, { providerPrincipalId: provider.principalId, target: nextTarget });
  const expanded = await coordinator.reconcile(request.id, provider, [
    { targetGeneration: 1, targetId: target.id },
    { targetGeneration: 1, targetId: nextTarget.id },
  ]);
  expect(expanded[0]?.bindingId).toBe(initial[0]?.bindingId);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding, ...expanded]);
  providerGenerations.set(provider.principalId, 2);
  targets.set(nextTarget.id, { providerPrincipalId: provider.principalId, target: { ...nextTarget, generation: 2 } });
  await expect(coordinator.reconcile(request.id, provider, []))
    .rejects
    .toMatchObject({ code: 'GRANT_PROVIDER_FENCED' });
  const renewed = await coordinator.reconcile(request.id, { ...provider, connectionGeneration: 2 }, [
    { targetGeneration: 2, targetId: nextTarget.id },
  ]);
  expect(renewed[0]?.bindingId).not.toBe(expanded[1]?.bindingId);
  await coordinator.reconcile(request.id, { ...provider, connectionGeneration: 2 }, []);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  await coordinator.dispose();
});

it('revokes the replacement generation when renewal is already committing', async () => {
  expect.assertions(4);
  const { authorityStore, coordinator, targets } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const initial = await coordinator.complete(coordinator.claim(request.id, provider), [{ targetGeneration: 1, targetId: target.id }]);
  targets.set(target.id, { providerPrincipalId: provider.principalId, target: { ...target, generation: 2 } });
  const acknowledgement = Promise.withResolvers<void>();
  const update = authorityStore.update.bind(authorityStore);
  vi.spyOn(authorityStore, 'update').mockImplementationOnce(async (...parameters) => {
    const committed = await update(...parameters);
    await acknowledgement.promise;
    return committed;
  });
  const renewal = coordinator.reconcile(request.id, provider, [{ targetGeneration: 2, targetId: target.id }]);
  const revocation = coordinator.revokeBindings(request.id, [initial[0]!.bindingId]);
  acknowledgement.resolve();
  const [renewed] = await Promise.all([renewal, revocation]);
  expect(renewed[0]?.bindingId).not.toBe(initial[0]?.bindingId);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  expect(await coordinator.reconcile(request.id, provider, [{ targetGeneration: 2, targetId: target.id }])).toEqual([]);
  expect(coordinator.inspect()[0]?.bindings).toEqual([]);
  await coordinator.dispose();
});

it('revokes an authority commit cancelled while its store acknowledgement is pending', async () => {
  expect.assertions(4);
  const { authorityStore, coordinator } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const claim = coordinator.claim(request.id, provider);
  const acknowledgement = Promise.withResolvers<void>();
  const update = authorityStore.update.bind(authorityStore);
  vi.spyOn(authorityStore, 'update').mockImplementationOnce(async (...parameters) => {
    const committed = await update(...parameters);
    await acknowledgement.promise;
    return committed;
  });
  const completion = coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }]);
  const failedCompletion = expect(completion).rejects.toMatchObject({ code: 'GRANT_CLAIM_INVALID' });
  const cancellation = coordinator.cancel(request.id);
  expect(coordinator.getRequest(request.id)).toBeUndefined();
  acknowledgement.resolve();
  await Promise.all([cancellation, failedCompletion]);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  expect(coordinator.getRequest(request.id)).toBeUndefined();
  await coordinator.dispose();
});

it('publishes request expiry and keeps binding expiry separate from the approval deadline', async () => {
  expect.assertions(6);
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const { authorityStore, coordinator } = setup();
  const states: string[] = [];
  const unsubscribe = coordinator.subscribe(change => states.push(change.request?.state ?? 'removed'));
  const expired = await coordinator.request({
    capabilities: { level: 'interact' },
    expiresAt: new Date(1_020).toISOString(),
    logicalSessionId: 'session',
    principalId: 'client',
  });
  const expiredClaim = coordinator.claim(expired.id, provider);
  await vi.advanceTimersByTimeAsync(20);
  expect(coordinator.getRequest(expired.id)).toBeUndefined();
  await expect(coordinator.complete(expiredClaim, [{ targetGeneration: 1, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_CLAIM_INVALID' });
  expect(states).toEqual(['pending', 'claimed', 'removed']);
  const accepted = await coordinator.request({
    bindingExpiresAt: new Date(1_100).toISOString(),
    capabilities: { level: 'interact' },
    expiresAt: new Date(1_040).toISOString(),
    logicalSessionId: 'session',
    principalId: 'client',
  });
  await coordinator.complete(coordinator.claim(accepted.id, provider), [{ targetGeneration: 1, targetId: target.id }]);
  await vi.advanceTimersByTimeAsync(20);
  expect(coordinator.getRequest(accepted.id)?.state).toBe('granted');
  await vi.advanceTimersByTimeAsync(60);
  expect(coordinator.getRequest(accepted.id)).toBeUndefined();
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  unsubscribe();
  await coordinator.dispose();
});

it('rejects malformed requests and empty or duplicate approval targets without granting authority', async () => {
  expect.assertions(5);
  const { authorityStore, coordinator } = setup();
  await expect(coordinator.request({
    capabilities: { level: 'administrator' as 'debug' },
    logicalSessionId: 'session',
    principalId: 'client',
  })).rejects.toMatchObject({ code: 'GRANT_REQUEST_INVALID' });
  await expect(coordinator.request({
    capabilities: { level: 'interact' },
    expiresAt: 'tomorrow',
    logicalSessionId: 'session',
    principalId: 'client',
  })).rejects.toMatchObject({ code: 'GRANT_REQUEST_INVALID' });
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const claim = coordinator.claim(request.id, provider);
  await expect(coordinator.complete(claim, [])).rejects.toMatchObject({ code: 'GRANT_REQUEST_INVALID' });
  await expect(coordinator.complete(claim, [
    { targetGeneration: 1, targetId: target.id },
    { targetGeneration: 1, targetId: target.id },
  ])).rejects.toMatchObject({ code: 'GRANT_REQUEST_INVALID' });
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  await coordinator.dispose();
});

it('retains enough authority identity to retry a failed revocation', async () => {
  expect.assertions(3);
  const { authorityStore, coordinator } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  await coordinator.complete(coordinator.claim(request.id, provider), [{ targetGeneration: 1, targetId: target.id }]);
  vi.spyOn(authorityStore, 'update').mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
  await expect(coordinator.cancel(request.id)).rejects.toMatchObject({ code: 'GRANT_AUTHORITY_UNAVAILABLE', retryable: true });
  expect(coordinator.getRequest(request.id)).toBeUndefined();
  await coordinator.cancel(request.id);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  await coordinator.dispose();
});

it('allows a current provider to replace a fenced claim without accepting the old claim', async () => {
  expect.assertions(4);
  const { coordinator, providerGenerations } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const oldClaim = coordinator.claim(request.id, provider);
  providerGenerations.set(provider.principalId, 2);
  expect(() => coordinator.claim(request.id, provider)).toThrow(expect.objectContaining({ code: 'GRANT_PROVIDER_FENCED' }));
  const currentClaim = coordinator.claim(request.id, { ...provider, connectionGeneration: 2 });
  await expect(coordinator.complete(oldClaim, [{ targetGeneration: 1, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_CLAIM_INVALID' });
  expect(currentClaim.id).not.toBe(oldClaim.id);
  expect(await coordinator.complete(currentClaim, [{ targetGeneration: 1, targetId: target.id }])).toHaveLength(1);
  await coordinator.dispose();
});

it('rechecks the requesting principal when authority commits and refuses a terminated session', async () => {
  expect.assertions(3);
  const { authorityStore, coordinator } = setup();
  await expect(coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'another-client' }))
    .rejects
    .toMatchObject({ code: 'GRANT_SESSION_UNAVAILABLE' });
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const claim = coordinator.claim(request.id, provider);
  await authorityStore.delete('session');
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }]))
    .rejects
    .toMatchObject({ code: 'GRANT_SESSION_UNAVAILABLE' });
  expect(await authorityStore.get('session')).toBeUndefined();
  await coordinator.dispose();
});

it('reconciles granted scope membership during a valid resume window but never completes a disconnected request', async () => {
  expect.assertions(4);
  const { authorityStore, coordinator, targets } = setup();
  const granted = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  await coordinator.complete(coordinator.claim(granted.id, provider), [{ targetGeneration: 1, targetId: target.id }]);
  const pending = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const claim = coordinator.claim(pending.id, provider);
  await authorityStore.update('session', (record) => {
    if (record === undefined) return undefined;
    const { activeConnectionId: _activeConnectionId, ...disconnected } = record;
    return { ...disconnected, resumeExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  });
  targets.set(target.id, { providerPrincipalId: provider.principalId, target: { ...target, generation: 2 } });
  const bindings = await coordinator.reconcile(granted.id, provider, [{ targetGeneration: 2, targetId: target.id }]);
  expect(bindings[0]?.targetGeneration).toBe(2);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding, ...bindings]);
  await expect(coordinator.complete(claim, [{ targetGeneration: 2, targetId: target.id }])).rejects.toMatchObject({ code: 'GRANT_SESSION_UNAVAILABLE' });
  await authorityStore.update('session', record => record === undefined ? undefined : { ...record, resumeExpiresAt: new Date(Date.now() - 1).toISOString() });
  await expect(coordinator.reconcile(granted.id, provider, [])).rejects.toMatchObject({ code: 'GRANT_SESSION_UNAVAILABLE' });
  await coordinator.dispose();
});

it('keeps observer failures outside grant completion and revocation', async () => {
  expect.assertions(5);
  const { authorityStore, coordinator } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const claim = coordinator.claim(request.id, provider);
  const observed: string[] = [];
  coordinator.subscribe(() => {
    throw new Error('The UI observer failed.');
  });
  coordinator.subscribe(change => observed.push(change.request?.state ?? 'removed'));
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }])).resolves.toHaveLength(1);
  expect(coordinator.getRequest(request.id)?.state).toBe('granted');
  await expect(coordinator.cancel(request.id)).resolves.toBeUndefined();
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  expect(observed).toEqual(['granted', 'removed']);
  await coordinator.dispose();
});

it('removes uncertain authority after a failed store acknowledgement before allowing retry', async () => {
  expect.assertions(4);
  const { authorityStore, coordinator } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const claim = coordinator.claim(request.id, provider);
  const update = authorityStore.update.bind(authorityStore);
  vi.spyOn(authorityStore, 'update').mockImplementationOnce(async (...parameters) => {
    await update(...parameters);
    throw new Error('The store committed, but its acknowledgement was lost.');
  });
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }])).rejects.toMatchObject({ code: 'GRANT_AUTHORITY_UNAVAILABLE', retryable: true });
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  const bindings = await coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }]);
  expect(bindings).toHaveLength(1);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding, ...bindings]);
  await coordinator.dispose();
});

it('retains cancellation identity when uncertain reconciliation and compensating revocation both fail', async () => {
  expect.assertions(3);
  const { authorityStore, coordinator } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  await coordinator.complete(coordinator.claim(request.id, provider), [{ targetGeneration: 1, targetId: target.id }]);
  const update = authorityStore.update.bind(authorityStore);
  vi.spyOn(authorityStore, 'update').mockImplementationOnce(async (...parameters) => {
    await update(...parameters);
    throw new Error('The reconciliation acknowledgement was lost.');
  }).mockRejectedValueOnce(new Error('Revocation storage is temporarily unavailable.'));
  await expect(coordinator.reconcile(request.id, provider, [{ targetGeneration: 1, targetId: target.id }])).rejects.toMatchObject({ code: 'GRANT_AUTHORITY_UNAVAILABLE' });
  expect(coordinator.getRequest(request.id)).toBeUndefined();
  await coordinator.cancel(request.id);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  await coordinator.dispose();
});

it('does not let a delayed duplicate cancellation delete a newer request with the same identifier', async () => {
  expect.assertions(3);
  const { authorityStore, coordinator } = setup();
  const original = await coordinator.request({ id: 'reused-request', capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  await coordinator.complete(coordinator.claim(original.id, provider), [{ targetGeneration: 1, targetId: target.id }]);
  const firstAcknowledgement = Promise.withResolvers<void>();
  const secondAcknowledgement = Promise.withResolvers<void>();
  const update = authorityStore.update.bind(authorityStore);
  vi.spyOn(authorityStore, 'update').mockImplementationOnce(async (...parameters) => {
    const record = await update(...parameters);
    await firstAcknowledgement.promise;
    return record;
  }).mockImplementationOnce(async (...parameters) => {
    const record = await update(...parameters);
    await secondAcknowledgement.promise;
    return record;
  });
  const firstCancellation = coordinator.cancel(original.id);
  const secondCancellation = coordinator.cancel(original.id);
  firstAcknowledgement.resolve();
  await firstCancellation;
  const replacement = await coordinator.request({ id: original.id, capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const bindings = await coordinator.complete(coordinator.claim(replacement.id, provider), [{ targetGeneration: 1, targetId: target.id }]);
  secondAcknowledgement.resolve();
  await secondCancellation;
  expect(coordinator.getRequest(replacement.id)?.state).toBe('granted');
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding, ...bindings]);
  await coordinator.dispose();
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
});

it('expires a pending request when its binding deadline arrives before its approval deadline', async () => {
  expect.assertions(2);
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const { coordinator } = setup();
  const request = await coordinator.request({ bindingExpiresAt: new Date(1_000).toISOString(), capabilities: { level: 'interact' }, expiresAt: new Date(2_000).toISOString(), logicalSessionId: 'session', principalId: 'client' });
  expect(() => coordinator.claim(request.id, provider)).toThrow(expect.objectContaining({ code: 'GRANT_REQUEST_EXPIRED' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.getRequest(request.id)).toBeUndefined();
  await coordinator.dispose();
});

it('projects committed request metadata without claim secrets and revokes bindings while the provider is offline', async () => {
  expect.assertions(5);
  const { authorityStore, coordinator, providerGenerations } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client', metadata: { selection: 'live-scope' } });
  const claim = coordinator.claim(request.id, provider);
  const bindings = await coordinator.complete(claim, [{ targetId: target.id, targetGeneration: 1, metadata: { approvedOrigin: 'https://example.test' } }]);
  const view = coordinator.inspect();
  expect(view[0]?.request.metadata).toEqual({ selection: 'live-scope' });
  expect(view[0]?.bindings[0]?.metadata).toEqual({ approvedOrigin: 'https://example.test' });
  expect(JSON.stringify(view)).not.toContain(claim.id);
  providerGenerations.delete(provider.principalId);
  await coordinator.revokeBindings(request.id, [bindings[0]!.bindingId, unrelatedBinding.bindingId]);
  expect((await authorityStore.get('session'))?.bindings).toEqual([unrelatedBinding]);
  expect(coordinator.inspect()[0]?.bindings).toEqual([]);
  await coordinator.dispose();
});

it('publishes the first cancellation reason once and fences a racing approval', async () => {
  expect.assertions(3);
  const { coordinator } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, logicalSessionId: 'session', principalId: 'client' });
  const claim = coordinator.claim(request.id, provider);
  const changed = vi.fn();
  coordinator.subscribe(changed);
  await Promise.all([coordinator.cancel(request.id, 'rejected'), coordinator.cancel(request.id, 'expired')]);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ requestId: request.id, reason: 'rejected' });
  await expect(coordinator.complete(claim, [{ targetGeneration: 1, targetId: target.id }])).rejects.toMatchObject({ code: 'GRANT_CLAIM_INVALID' });
  expect(coordinator.getRequest(request.id)).toBeUndefined();
  await coordinator.dispose();
});

it('publishes expiry separately from ordinary cancellation', async () => {
  expect.assertions(2);
  vi.useFakeTimers();
  const { coordinator } = setup();
  const request = await coordinator.request({ capabilities: { level: 'interact' }, expiresAt: new Date(Date.now() + 100).toISOString(), logicalSessionId: 'session', principalId: 'client' });
  const changed = vi.fn();
  coordinator.subscribe(changed);
  await vi.advanceTimersByTimeAsync(100);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ requestId: request.id, reason: 'expired' });
  expect(coordinator.getRequest(request.id)).toBeUndefined();
  await coordinator.dispose();
});
