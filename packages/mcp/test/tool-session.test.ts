import type { CdpCommand, Lease, PublishedTarget } from '@dvcol/cdb';

import type { McpChromeDebuggerBridgeClient } from '../src/index.js';

import { expect, it, vi } from 'vitest';

import { createCdbToolSession } from '../src/index.js';

const targetId = 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5';
const scopeId = '76f667f1-cf48-4664-9c41-ffab0ed11b55';

function publishedTarget(generation: number): PublishedTarget {
  return {
    availability: 'available',
    capabilities: { level: 'interact' },
    generation,
    id: targetId,
    scopeId,
    title: 'Experimentation List',
    type: 'page',
    url: 'https://example.test/experimentations',
  };
}

function lease(generation: number, methods: readonly string[]): Lease {
  return {
    expiresAt: '2030-01-01T00:00:00.000Z',
    id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
    issuedAt: '2026-08-26T00:00:00.000Z',
    methods: [...methods],
    mode: 'shared-read',
    targetGeneration: generation,
    targetId,
  };
}

it('keeps target refs stable across generation renewal and emits disposable element refs', async () => {
  expect.assertions(11);
  let currentGeneration = 1;
  const acquiredLeases: Array<{ readonly targetGeneration: number }> = [];
  const client = {
    async acquireLease(request: {
      readonly requestedMethods: readonly string[];
      readonly targetGeneration: number;
    }) {
      acquiredLeases.push(request);
      return lease(request.targetGeneration, request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Bridge.listChildSessions')
        return { operationId: command.operationId, value: { sessions: [] } };
      if (command.method === 'Accessibility.getFullAXTree') {
        return {
          operationId: command.operationId,
          value: {
            nodes: [
              {
                backendDOMNodeId: 7,
                childIds: [],
                ignored: false,
                name: { type: 'computedString', value: 'Experiments' },
                nodeId: 'ax-1',
                properties: [],
                role: { type: 'role', value: 'link' },
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.method}`);
    },
    async listTargets() {
      return [publishedTarget(currentGeneration)];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const listTargets = session.definitions.find(tool => tool.name === 'browser.list_targets');
  const snapshot = session.definitions.find(tool => tool.name === 'browser.snapshot');
  if (listTargets === undefined || snapshot === undefined)
    throw new Error('The semantic discovery tools are missing.');

  const firstListing = await listTargets.invoke({});
  const firstTargets = JSON.parse((firstListing.content[0] as { readonly text: string }).text) as unknown[];
  expect(firstTargets).toEqual([
    {
      availability: 'available',
      capabilities: { level: 'interact' },
      targetRef: 't1',
      title: 'Experimentation List',
      type: 'page',
      url: 'https://example.test/experimentations',
    },
  ]);
  expect(JSON.stringify(firstTargets)).not.toContain(targetId);
  expect(JSON.stringify(firstTargets)).not.toContain('generation');

  const firstSnapshot = await snapshot.invoke({ targetRef: 't1' });
  expect(firstSnapshot.isError).toBeUndefined();
  expect((firstSnapshot.content[0] as { readonly text: string }).text).toContain('- link "Experiments" [ref=e1]');

  currentGeneration = 2;
  const secondListing = await listTargets.invoke({});
  expect(JSON.parse((secondListing.content[0] as { readonly text: string }).text)).toMatchObject([
    { targetRef: 't1' },
  ]);
  const secondSnapshot = await snapshot.invoke({ targetRef: 't1' });
  expect((secondSnapshot.content[0] as { readonly text: string }).text).toContain('[ref=e2]');
  expect(acquiredLeases.map(request => request.targetGeneration)).toEqual([1, 1, 2, 2]);

  session.dispose();
  const disposedResult = await snapshot.invoke({ targetRef: 't1' });
  expect(disposedResult.isError).toBe(true);
  expect(JSON.parse((disposedResult.content[0] as { readonly text: string }).text)).toMatchObject({
    code: 'MCP_TOOL_SESSION_DISPOSED',
  });
  expect(session.projectTarget(publishedTarget(3))).toBeUndefined();
});

it('does not share target references between principal-owned sessions', () => {
  expect.assertions(4);
  const client = {} as McpChromeDebuggerBridgeClient;
  const firstSession = createCdbToolSession({ client });
  const secondSession = createCdbToolSession({ client });

  expect(firstSession.projectTarget(publishedTarget(1))?.targetRef).toBe('t1');
  expect(firstSession.projectTarget({ ...publishedTarget(1), id: crypto.randomUUID() })?.targetRef).toBe('t2');
  expect(secondSession.projectTarget(publishedTarget(1))?.targetRef).toBe('t1');
  expect(vi.isMockFunction(secondSession.dispose)).toBe(false);
});

it('preserves a target reference during provider recovery and removes it only on host revocation', async () => {
  expect.assertions(6);
  let available = true;
  const client = {
    async listTargets() {
      return available ? [publishedTarget(1)] : [];
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const listTargets = session.definitions.find(tool => tool.name === 'browser.list_targets');
  if (listTargets === undefined) throw new Error('The target-listing tool is missing.');

  expect(session.projectTarget(publishedTarget(1))?.targetRef).toBe('t1');
  expect(session.targetIdForReference('t1')).toBe(targetId);
  available = false;
  expect(JSON.parse(((await listTargets.invoke({})).content[0] as { readonly text: string }).text)).toEqual([]);
  expect(session.targetIdForReference('t1')).toBe(targetId);
  available = true;
  expect(session.projectTarget(publishedTarget(2))?.targetRef).toBe('t1');

  session.revokeTarget(targetId);
  expect(session.targetIdForReference('t1')).toBeUndefined();
});

it('finds by semantic locator and clicks through a fresh ref without exposing authority epochs', async () => {
  expect.assertions(11);
  const commands: CdpCommand[] = [];
  const client = {
    async acquireLease(request: {
      readonly requestedMethods: readonly string[];
      readonly targetGeneration: number;
    }) {
      return { ...lease(request.targetGeneration, request.requestedMethods), mode: 'exclusive-control' as const };
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      commands.push(command);
      if (command.method === 'Bridge.listChildSessions')
        return { operationId: command.operationId, value: { sessions: [] } };
      if (command.method === 'DOM.getDocument') {
        return { operationId: command.operationId, value: { root: { backendNodeId: 1 } } };
      }
      if (command.method === 'Accessibility.queryAXTree') {
        return {
          operationId: command.operationId,
          value: {
            nodes: [
              {
                backendDOMNodeId: 7,
                childIds: [],
                ignored: false,
                name: { value: 'Experiments' },
                nodeId: 'ax-link',
                properties: [],
                role: { value: 'link' },
              },
              {
                backendDOMNodeId: 8,
                childIds: [],
                ignored: false,
                name: { value: 'Benchmarks' },
                nodeId: 'ax-other-link',
                properties: [],
                role: { value: 'link' },
              },
            ],
          },
        };
      }
      if (command.method === 'Accessibility.getPartialAXTree') {
        return {
          operationId: command.operationId,
          value: {
            nodes: [{ backendDOMNodeId: 7, ignored: false, properties: [], role: { value: 'link' } }],
          },
        };
      }
      if (command.method === 'DOM.scrollIntoViewIfNeeded')
        return { operationId: command.operationId, value: {} };
      if (command.method === 'DOM.getContentQuads')
        return { operationId: command.operationId, value: { quads: [[10, 10, 50, 10, 50, 30, 10, 30]] } };
      if (command.method === 'DOM.getNodeForLocation')
        return { operationId: command.operationId, value: { backendNodeId: 7 } };
      if (command.method === 'DOM.describeNode')
        return { operationId: command.operationId, value: { node: { backendNodeId: 7, nodeName: 'A' } } };
      return { operationId: command.operationId, value: {} };
    },
    async listTargets() {
      return [publishedTarget(1)];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const projected = session.projectTarget(publishedTarget(1));
  const find = session.definitions.find(tool => tool.name === 'browser.find');
  const click = session.definitions.find(tool => tool.name === 'browser.click');
  const clickAt = session.definitions.find(tool => tool.name === 'browser.click_at');
  if (projected === undefined || find === undefined || click === undefined || clickAt === undefined)
    throw new Error('The semantic locator tools are missing.');

  const findResult = await find.invoke({
    locator: { name: { match: 'exact', value: 'Experiments' }, role: 'link' },
    targetRef: projected.targetRef,
  });
  expect(findResult.isError).toBeUndefined();
  const matches = JSON.parse((findResult.content[0] as { readonly text: string }).text) as unknown[];
  expect(matches).toEqual([{ name: 'Experiments', ref: 'e1', role: 'link' }]);
  expect(JSON.stringify(matches)).not.toContain('backendNodeId');
  expect(JSON.stringify(matches)).not.toContain('generation');

  commands.length = 0;
  const clickResult = await click.invoke({ ref: 'e1', targetRef: projected.targetRef });
  expect(clickResult.isError).toBeUndefined();
  expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent').map(command => command.parameters)).toEqual([
    { modifiers: 0, type: 'mouseMoved', x: 30, y: 20 },
    { button: 'left', clickCount: 1, modifiers: 0, type: 'mousePressed', x: 30, y: 20 },
    { button: 'left', clickCount: 1, modifiers: 0, type: 'mouseReleased', x: 30, y: 20 },
  ]);
  expect(commands.map(command => command.method)).not.toContain('Runtime.evaluate');
  expect(commands.map(command => command.method)).not.toContain('Runtime.callFunctionOn');
  expect(click.mcpInputSchema.safeParse({
    ref: 'e1',
    targetGeneration: 1,
    targetId,
  }).success).toBe(false);
  expect(clickAt.mcpInputSchema.safeParse({
    targetRef: projected.targetRef,
    x: 1,
    y: 2,
  }).success).toBe(true);
  expect(commands.filter(command => command.method === 'DOM.getContentQuads')).toHaveLength(2);
});

it('rejects an element ref after its document generation has renewed', async () => {
  expect.assertions(2);
  let currentGeneration = 1;
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[]; readonly targetGeneration: number }) {
      return lease(request.targetGeneration, request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Bridge.listChildSessions')
        return { operationId: command.operationId, value: { sessions: [] } };
      if (command.method === 'Accessibility.getFullAXTree')
        return { operationId: command.operationId, value: { nodes: [{ backendDOMNodeId: 7, childIds: [], ignored: false, name: { value: 'Save' }, nodeId: 'save', properties: [], role: { value: 'button' } }] } };
      return { operationId: command.operationId, value: {} };
    },
    async listTargets() {
      return [publishedTarget(currentGeneration)];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(publishedTarget(1))?.targetRef;
  const snapshot = session.definitions.find(tool => tool.name === 'browser.snapshot');
  const click = session.definitions.find(tool => tool.name === 'browser.click');
  if (targetRef === undefined || snapshot === undefined || click === undefined)
    throw new Error('The semantic tools are missing.');
  await snapshot.invoke({ targetRef });
  currentGeneration = 2;

  const result = await click.invoke({ ref: 'e1', targetRef });

  expect(result.isError).toBe(true);
  expect(JSON.parse((result.content[0] as { readonly text: string }).text)).toMatchObject({
    code: 'MCP_ELEMENT_REF_STALE',
  });
});
