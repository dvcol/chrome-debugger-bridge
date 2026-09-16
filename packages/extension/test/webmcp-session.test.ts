import type { CapabilityGrant, JsonObject } from '@dvcol/cdb';

import type { SelectedTabPublisher } from '../src/index.js';

import { Buffer } from 'node:buffer';

import { createChromeDebuggerBridgeClient, createClientFacadeAdapter, createTargetBroker, webMcpMethods } from '@dvcol/cdb';
import { createCdbToolSession } from '@dvcol/cdb-mcp';
import { afterEach, expect, it, vi } from 'vitest';

import { createSelectedTabPublisher } from '../src/index.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function harness(level: CapabilityGrant['level'] = 'interact', maximumInlineResultBytes = 65_536) {
  const broker = createTargetBroker({ maximumInlineResultBytes });
  const state = { output: 'done', unsupported: false, complete: true, loaderId: 'first' };
  const dispatched = Promise.withResolvers<void>();
  let publisher: SelectedTabPublisher;
  const sendCommand = vi.fn(async (_target: unknown, method: string): Promise<JsonObject> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: state.loaderId, url: 'https://example.test/' } } };
    if (method === 'WebMCP.enable') {
      if (state.unsupported) throw new Error('Method not found');
      publisher.debuggerEvent({ tabId: 42 }, 'WebMCP.toolsAdded', { tools: [{ frameId: 'main', name: 'hidden', description: 'Private catalogue item', annotations: { readOnly: true } }] });
    }
    if (method === 'WebMCP.invokeTool') {
      dispatched.resolve();
      if (state.complete) publisher.debuggerEvent({ tabId: 42 }, 'WebMCP.toolResponded', { invocationId: 'native-invocation', status: 'Completed', output: state.output });
      return { invocationId: 'native-invocation' };
    }
    return {};
  });
  publisher = createSelectedTabPublisher({
    capabilities: { level: 'unsafe' },
    chromeDebugger: { attach() {}, detach() {}, sendCommand },
    scopeId: crypto.randomUUID(),
    webMcp: { discovery: { exclude: ['hidden'] } },
    publishTarget: target => broker.publishTarget(target),
    updateTarget: target => broker.updateTarget(target),
    revokeTarget: target => broker.revokeTarget(target.id, target.generation),
    registerTargetExecutor: (target, executor) => broker.registerTargetExecutor(target, executor),
  });
  const target = await publisher.publish({ tabId: 42, incognito: false, url: 'https://example.test/' });
  function principal(capabilityLevel = level) {
    const authority = { connectionId: crypto.randomUUID(), principalId: crypto.randomUUID(), targetGrants: [{ bindingId: crypto.randomUUID(), capabilities: { level: capabilityLevel }, targetId: target.id, targetGeneration: target.generation }] };
    broker.connectClient(authority);
    const client = {
      ...createChromeDebuggerBridgeClient(createClientFacadeAdapter({
        acquireLease: request => broker.acquireLease(request, authority),
        executeCommand: async command => broker.executeCommand(command, authority),
        listTargets: () => broker.listTargets(authority),
        releaseLease: request => broker.releaseLease(request, authority),
        renewLease: request => broker.renewLease(request, authority),
        readArtifact: request => broker.readArtifact(request, authority),
        releaseArtifact: request => broker.releaseArtifact(request, authority),
        subscribe: async request => broker.subscribe(request, authority),
        watchTargets: () => broker.watchTargets(authority),
      })),
      async cancelCommand(request: { operationId: string }) {
        broker.cancelCommand(request.operationId, authority);
      },
    };
    const session = createCdbToolSession({ client });
    session.projectTarget(target);
    disposals.push(async () => {
      session.dispose();
      broker.disconnectClient(authority);
    });
    function definition(name: string) {
      const tool = session.definitions.find(candidate => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing ${name}`);
      return tool;
    }
    async function invoke(name: string, input: Record<string, unknown> = {}, signal = new AbortController().signal) {
      const result = await definition(name).invoke({ targetRef: 't1', ...input }, { signal });
      const content = result.content[0];
      if (content?.type !== 'text') throw new Error('Expected text');
      return { error: result.isError, value: JSON.parse(content.text) as Record<string, unknown> };
    }
    return { client, session, invoke, definition, authority };
  }
  disposals.push(async () => {
    await publisher.revoke();
    broker.dispose();
  });
  return { ...principal(), principal, broker, publisher, target, state, sendCommand, dispatched: dispatched.promise };
}

it('keeps native discovery and direct invocation behind the granted access level', async () => {
  expect.assertions(6);
  const fixture = await harness('inspect');
  expect((await fixture.invoke('browser.list_webmcp_tools')).value).toMatchObject({ tools: [], enabled: true });
  expect((await fixture.invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} })).error).toBe(true);
  const actor = fixture.principal('interact');
  expect((await actor.invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} })).value).toEqual({ status: 'completed', output: 'done' });
  expect(fixture.sendCommand.mock.calls.filter(([, method]) => method === 'WebMCP.invokeTool')).toHaveLength(1);
  expect(fixture.sendCommand.mock.calls.some(([, method]) => method === 'Runtime.evaluate')).toBe(false);
  expect(fixture.broker.listLeases(actor.authority)).toHaveLength(0);
});

it('reserves native commands even at unsafe access and requires an exclusive invocation lease', async () => {
  expect.assertions(3);
  const fixture = await harness('unsafe');
  const request = { durationMilliseconds: 30_000, targetId: fixture.target.id, targetGeneration: fixture.target.generation };
  await expect(fixture.client.acquireLease({ ...request, requestedMethods: ['WebMCP.invokeTool'] })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  await expect(fixture.client.acquireLease({ ...request, requestedMethods: [webMcpMethods.invoke], mode: 'shared-read' })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  const lease = await fixture.client.acquireLease({ ...request, requestedMethods: [webMcpMethods.invoke], mode: 'exclusive-control' });
  expect((await fixture.principal().invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} })).error).toBe(true);
  await fixture.client.releaseLease({ ...request, leaseId: lease.id });
});

it('retains bounded artifacts for the owning semantic session and releases their leases', async () => {
  expect.assertions(7);
  const fixture = await harness('interact', 256);
  fixture.state.output = 'large result '.repeat(100);
  const result = await fixture.invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} });
  expect(result.error).toBeUndefined();
  expect(result.value).toMatchObject({ artifact: { mediaType: 'application/json' }, targetRef: 't1' });
  expect(JSON.stringify(result.value)).not.toMatch(/targetGeneration|targetId/);
  const artifact = result.value.artifact as { id: string };
  const request = { artifactId: artifact.id, leaseId: String(result.value.leaseId) };
  expect((await fixture.principal().invoke('browser.read_artifact', request)).error).toBe(true);
  const read = await fixture.invoke('browser.read_artifact', request);
  const payload: unknown = JSON.parse(Buffer.from(String(read.value.bytes), 'base64').toString());
  expect(payload).toMatchObject({ output: fixture.state.output });
  expect((await fixture.invoke('browser.release_artifact', request)).value).toEqual({ released: true });
  expect(fixture.broker.listLeases(fixture.authority)).toHaveLength(0);
});

it('drops retained artifacts on session disposal', async () => {
  expect.assertions(2);
  const fixture = await harness('interact', 256);
  fixture.state.output = 'x'.repeat(1_000);
  await fixture.invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} });
  expect(fixture.broker.listLeases(fixture.authority)).toHaveLength(1);
  fixture.session.dispose();
  expect(fixture.broker.listLeases(fixture.authority)).toHaveLength(0);
});

it('preserves feature-unsupported failures and rejects frame selection before dispatch', async () => {
  expect.assertions(3);
  const fixture = await harness();
  fixture.state.unsupported = true;
  expect((await fixture.invoke('browser.list_webmcp_tools')).value).toMatchObject({ code: 'FEATURE_UNSUPPORTED' });
  await expect(fixture.invoke('browser.list_webmcp_tools', { frameId: 'child' })).rejects.toThrow();
  expect(fixture.sendCommand.mock.calls.some(([, method]) => method === 'WebMCP.invokeTool')).toBe(false);
});

it('reports cancellation after dispatch as unknown outcome without replaying the tool', async () => {
  expect.assertions(3);
  const fixture = await harness();
  fixture.state.complete = false;
  const cancellation = new AbortController();
  const invoking = fixture.invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} }, cancellation.signal);
  await fixture.dispatched;
  cancellation.abort();
  expect((await invoking).value).toMatchObject({ code: 'WEBMCP_OUTCOME_UNKNOWN' });
  expect(fixture.sendCommand.mock.calls.filter(([, method]) => method === 'WebMCP.invokeTool')).toHaveLength(1);
  expect(fixture.broker.listLeases(fixture.authority)).toHaveLength(0);
});

it('exposes the typed client methods through the same authorized broker command path', async () => {
  expect.assertions(2);
  const fixture = await harness();
  const authority = { targetId: fixture.target.id, targetGeneration: fixture.target.generation };
  const listingLease = await fixture.client.acquireLease({ ...authority, requestedMethods: [webMcpMethods.list], durationMilliseconds: 30_000 });
  expect((await fixture.client.listWebMcpTools({ ...authority, leaseId: listingLease.id, operationId: crypto.randomUUID() })).value).toMatchObject({ tools: [], enabled: true });
  await fixture.client.releaseLease({ ...authority, leaseId: listingLease.id });
  const invocationLease = await fixture.client.acquireLease({ ...authority, requestedMethods: [webMcpMethods.invoke], durationMilliseconds: 30_000, mode: 'exclusive-control' });
  expect((await fixture.client.invokeWebMcpTools({ ...authority, leaseId: invocationLease.id, operationId: crypto.randomUUID(), toolName: 'hidden', input: {} })).value).toEqual({ status: 'completed', output: 'done' });
  await fixture.client.releaseLease({ ...authority, leaseId: invocationLease.id });
});

it('fences a late invocation response after replacing the session client', async () => {
  expect.assertions(2);
  const fixture = await harness();
  fixture.state.complete = false;
  const invoking = fixture.invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} });
  await fixture.dispatched;
  fixture.session.rebindClient(fixture.client);
  fixture.publisher.debuggerEvent({ tabId: 42 }, 'WebMCP.toolResponded', { invocationId: 'native-invocation', status: 'Completed', output: 'late' });
  expect((await invoking).value).toMatchObject({ code: 'WEBMCP_OUTCOME_UNKNOWN' });
  expect(fixture.broker.listLeases(fixture.authority)).toHaveLength(0);
});

it('reports a lost provider response after dispatch without replaying an invocation', async () => {
  expect.assertions(3);
  const fixture = await harness();
  const execute = vi.fn(async () => {
    throw new Error('Provider transport closed after send');
  });
  fixture.broker.registerTargetExecutor(fixture.target, { execute });
  expect((await fixture.invoke('browser.invoke_webmcp_tools', { toolName: 'hidden', input: {} })).value).toMatchObject({ code: 'WEBMCP_OUTCOME_UNKNOWN', retryable: false });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(fixture.broker.listLeases(fixture.authority)).toHaveLength(0);
});
