import type { AutomationExecutionRequest, CdpCommand, Lease, PublishedTarget } from '@dvcol/cdb';

import type { McpChromeDebuggerBridgeClient } from '../src/index.js';

import { Buffer } from 'node:buffer';

import { expect, it } from 'vitest';

import { createCdbToolSession } from '../src/index.js';

const targetId = 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5';
const childSessionId = 'c5f7a25e-810e-41a7-97d0-ae4636c5e4e5';

const target: PublishedTarget = {
  availability: 'available',
  capabilities: { level: 'unsafe' },
  generation: 1,
  id: targetId,
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
};

function lease(methods: readonly string[]): Lease {
  return {
    expiresAt: '2030-01-01T00:00:00.000Z',
    id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
    issuedAt: '2026-08-26T00:00:00.000Z',
    methods: [...methods],
    mode: 'shared-read',
    targetGeneration: target.generation,
    targetId,
  };
}

function text(result: Awaited<ReturnType<ReturnType<typeof createCdbToolSession>['definitions'][number]['invoke']>>): string {
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Expected text tool content.');
  return content.text;
}

it('keeps authority epochs out of every semantic input schema', () => {
  expect.assertions(3);
  const rawToolNames = new Set([
    'browser.acquire',
    'browser.list_target_authorities',
    'browser.raw_cdp',
    'browser.read_artifact',
    'browser.release',
    'browser.release_artifact',
    'browser.renew',
  ]);
  const session = createCdbToolSession({ client: {} as McpChromeDebuggerBridgeClient, enableRawCdp: true });
  const semanticSchemas = session.definitions
    .filter(definition => !rawToolNames.has(definition.name))
    .map(definition => JSON.stringify(definition.inputSchema));

  expect(semanticSchemas.some(schema => schema.includes('targetGeneration'))).toBe(false);
  expect(semanticSchemas.some(schema => schema.includes('targetId'))).toBe(false);
  const rawCdpSchema = JSON.stringify(session.definitions.find(definition => definition.name === 'browser.raw_cdp')?.inputSchema);
  expect(rawCdpSchema.includes('targetGeneration') && rawCdpSchema.includes('targetId')).toBe(true);
});

it('bounds an expanded interactive snapshot while keeping short actionable refs', async () => {
  expect.assertions(5);
  const nodes = Array.from({ length: 2_000 }, (_value, index) => ({
    backendDOMNodeId: index + 1,
    childIds: [],
    ignored: false,
    name: { value: `Action ${index + 1}` },
    nodeId: `node-${index + 1}`,
    role: { value: 'button' },
  }));
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Bridge.listChildSessions') return { value: { sessions: [] } };
      if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes } };
      return { value: {} };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const snapshot = session.definitions.find(definition => definition.name === 'browser.snapshot');
  if (targetRef === undefined || snapshot === undefined) throw new Error('browser.snapshot is missing.');

  const result = await snapshot.invoke({ maximumCharacters: 60_000, targetRef });
  const snapshotText = text(result);

  expect(result.isError).toBeUndefined();
  expect(snapshotText.length).toBeLessThanOrEqual(60_000);
  expect(snapshotText.match(/\[ref=e\d+\]/gu)).toHaveLength(500);
  expect(snapshotText).toContain('[ref=e500]');
  expect(snapshotText).not.toContain('[ref=e501]');
});

it('includes named table cells and headers in interactive snapshots', async () => {
  expect.assertions(5);
  const accessibilityTree = Buffer.from(JSON.stringify({
    nodes: [
      { backendDOMNodeId: 1, childIds: [], ignored: false, name: { value: 'Hero Banner CTA' }, nodeId: 'cell', role: { value: 'cell' } },
      { backendDOMNodeId: 2, childIds: [], ignored: false, name: { value: 'Status' }, nodeId: 'columnheader', role: { value: 'columnheader' } },
      { backendDOMNodeId: 3, childIds: [], ignored: false, name: { value: 'Experiment' }, nodeId: 'rowheader', role: { value: 'rowheader' } },
      { backendDOMNodeId: 4, childIds: [], ignored: false, name: { value: 'Grid value' }, nodeId: 'gridcell', role: { value: 'gridcell' } },
    ],
  }));
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Bridge.listChildSessions') return { value: { sessions: [] } };
      if (command.method === 'Accessibility.getFullAXTree') {
        return {
          value: {
            artifact: {
              expiresAt: '2030-01-01T00:00:00.000Z',
              id: 'accessibility-tree',
              length: accessibilityTree.byteLength,
              mediaType: 'application/json',
            },
          },
        };
      }
      return { value: {} };
    },
    async listTargets() {
      return [target];
    },
    async readArtifact() {
      return accessibilityTree;
    },
    async releaseArtifact() {},
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const snapshot = session.definitions.find(definition => definition.name === 'browser.snapshot');
  if (targetRef === undefined || snapshot === undefined) throw new Error('browser.snapshot is missing.');

  const result = await snapshot.invoke({ targetRef });
  const snapshotText = text(result);

  expect(result.isError).toBeUndefined();
  expect(snapshotText).toContain('- cell "Hero Banner CTA" [ref=e1]');
  expect(snapshotText).toContain('- columnheader "Status" [ref=e2]');
  expect(snapshotText).toContain('- rowheader "Experiment" [ref=e3]');
  expect(snapshotText).toContain('- gridcell "Grid value" [ref=e4]');
});

it('routes an opted-in semantic session through one registered automation provider call per operation', async () => {
  expect.assertions(9);
  const automationRequests: AutomationExecutionRequest[] = [];
  const leaseRequests: Array<{ readonly mode?: Lease['mode']; readonly requestedMethods: readonly string[] }> = [];
  const client = {
    async acquireLease(request: { readonly mode?: Lease['mode']; readonly requestedMethods: readonly string[] }) {
      leaseRequests.push(request);
      return { ...lease(request.requestedMethods), mode: request.mode ?? 'shared-read' };
    },
    async cancelAutomation() {},
    async cancelCommand() {},
    async executeAutomation(request: AutomationExecutionRequest) {
      automationRequests.push(request);
      if (request.operation.kind === 'snapshot') {
        return {
          elements: [{ id: 'provider-handle-1', metadata: { providerReference: 'e44', role: 'cell' } }],
          metrics: {
            cdbTransportDurationMilliseconds: 1,
            cdpCommandCount: 2,
            chromeDurationMilliseconds: 3,
            providerDurationMilliseconds: 4,
            totalDurationMilliseconds: 5,
          },
          operationId: request.operationId,
          provider: { capabilities: { actions: ['click'], operations: ['action', 'find', 'snapshot'], snapshotModes: ['interactive'] }, id: 'playwright', version: 'test' },
          snapshotId: 'snapshot-1',
          value: { snapshot: '- cell "Hero Banner CTA" [ref=e44]' },
        };
      }
      return {
        metrics: {
          cdbTransportDurationMilliseconds: 1,
          cdpCommandCount: 3,
          chromeDurationMilliseconds: 4,
          providerDurationMilliseconds: 5,
          totalDurationMilliseconds: 6,
        },
        operationId: request.operationId,
        provider: { capabilities: { actions: ['click'], operations: ['action'], snapshotModes: [] }, id: 'playwright', version: 'test' },
        value: { completed: true },
      };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ automationProvider: 'registered', client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const snapshot = session.definitions.find(definition => definition.name === 'browser.snapshot');
  const click = session.definitions.find(definition => definition.name === 'browser.click');
  if (targetRef === undefined || snapshot === undefined || click === undefined)
    throw new Error('The semantic tools are missing.');

  const snapshotResult = await snapshot.invoke({ targetRef });
  const clickResult = await click.invoke({ ref: 'e1', targetRef });

  expect(snapshotResult.isError).toBeUndefined();
  expect(text(snapshotResult)).toContain('- cell "Hero Banner CTA" [ref=e1]');
  expect(clickResult.isError).toBeUndefined();
  expect(JSON.parse(text(clickResult))).toStrictEqual({ completed: true });
  expect(automationRequests).toHaveLength(2);
  expect(automationRequests[0]?.operation).toMatchObject({ kind: 'snapshot', mode: 'interactive' });
  expect(automationRequests[1]?.operation).toMatchObject({ action: 'click', elementHandleId: 'provider-handle-1', kind: 'action' });
  expect(leaseRequests.map(request => request.mode)).toStrictEqual(['shared-read', 'exclusive-control']);
  expect(leaseRequests.every(request => request.requestedMethods.length === 0)).toBe(true);
});

it('projects structured provider failures into semantic MCP errors', async () => {
  expect.assertions(3);
  const client = {
    async acquireLease(request: { readonly mode?: Lease['mode']; readonly requestedMethods: readonly string[] }) {
      return { ...lease(request.requestedMethods), mode: request.mode ?? 'shared-read' };
    },
    async cancelAutomation() {},
    async cancelCommand() {},
    async executeAutomation() {
      const error = new Error('Another element intercepts pointer events.') as Error & {
        code: string;
        details: Record<string, unknown>;
        retryable: boolean;
      };
      error.code = 'CDP_COMMAND_FAILED';
      error.details = {
        automationCode: 'AUTOMATION_ELEMENT_COVERED',
        providerId: 'playwright',
      };
      error.retryable = true;
      throw error;
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ automationProvider: 'registered', client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const click = session.definitions.find(definition => definition.name === 'browser.click');
  if (targetRef === undefined || click === undefined) throw new Error('The click tool is missing.');

  const result = await click.invoke({ locator: { role: 'button' }, targetRef });
  const failure: unknown = JSON.parse(text(result));
  const failureMessage = failure !== null
    && typeof failure === 'object'
    && 'message' in failure
    ? failure.message
    : undefined;

  expect(result.isError).toBe(true);
  expect(failure).toMatchObject({
    code: 'MCP_ELEMENT_COVERED',
    details: { automationCode: 'AUTOMATION_ELEMENT_COVERED', providerId: 'playwright' },
    retryable: true,
  });
  expect(failureMessage).toBe('Another element intercepts pointer events.');
});

it('reads an artifact-backed accessibility tree before formatting the interactive snapshot', async () => {
  expect.assertions(5);
  const accessibilityTree = Buffer.from(JSON.stringify({
    nodes: [{
      backendDOMNodeId: 7,
      childIds: [],
      ignored: false,
      name: { value: 'Experiments' },
      nodeId: 'experiments',
      role: { value: 'link' },
    }],
  }));
  const releasedArtifacts: string[] = [];
  const releasedLeases: string[] = [];
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Bridge.listChildSessions') return { value: { sessions: [] } };
      if (command.method === 'Accessibility.getFullAXTree') {
        return {
          value: {
            artifact: {
              expiresAt: '2030-01-01T00:00:00.000Z',
              id: 'accessibility-tree',
              length: accessibilityTree.byteLength,
              mediaType: 'application/json',
            },
          },
        };
      }
      return { value: {} };
    },
    async listTargets() {
      return [target];
    },
    async readArtifact() {
      return accessibilityTree;
    },
    async releaseArtifact(request: { readonly artifactId: string }) {
      releasedArtifacts.push(request.artifactId);
    },
    async releaseLease(request: { readonly leaseId: string }) {
      releasedLeases.push(request.leaseId);
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const snapshot = session.definitions.find(definition => definition.name === 'browser.snapshot');
  if (targetRef === undefined || snapshot === undefined) throw new Error('browser.snapshot is missing.');

  const result = await snapshot.invoke({ targetRef });

  expect(result.isError).toBeUndefined();
  expect(text(result)).toContain('- link "Experiments" [ref=e1]');
  expect(releasedArtifacts).toEqual(['accessibility-tree']);
  expect(releasedLeases).toHaveLength(3);
  expect(releasedLeases.every(leaseId => leaseId === '017c10a7-e0af-40ec-879f-cd87dffaf036')).toBe(true);
});

it('supports the core Playwright-style locator strategies and XPath through DOM search', async () => {
  expect.assertions(14);
  const commands: CdpCommand[] = [];
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      commands.push(command);
      if (command.method === 'Bridge.listChildSessions') return { value: { sessions: [] } };
      if (command.method === 'Accessibility.queryAXTree' || command.method === 'Accessibility.getFullAXTree')
        return { value: { nodes: [{ backendDOMNodeId: 7, childIds: [], ignored: false, name: { value: 'Save' }, nodeId: 'save', role: { value: 'button' } }] } };
      if (command.method === 'Accessibility.getRootAXNode') return { value: { node: { backendDOMNodeId: 1 } } };
      if (command.method === 'DOM.getDocument') return { value: { root: { backendNodeId: 1 } } };
      if (command.method === 'DOM.getFlattenedDocument')
        return { value: { nodes: [{ nodeId: 1, nodeType: 9, backendNodeId: 1, children: [{ nodeId: 70, backendNodeId: 7, nodeName: 'BUTTON', attributes: ['placeholder', 'Search', 'alt', 'Hero', 'title', 'Save title', 'data-testid', 'save'] }], shadowRoots: [{ nodeId: 2, shadowRootType: 'open' }, { nodeId: 3, shadowRootType: 'closed' }] }] } };
      if (command.method === 'DOM.querySelectorAll') return { value: { nodeIds: [70] } };
      if (command.method === 'DOM.performSearch') return { value: { resultCount: 1, searchId: 'search-1' } };
      if (command.method === 'DOM.getSearchResults') return { value: { nodeIds: [70] } };
      if (command.method === 'DOM.describeNode')
        return { value: { node: { attributes: ['placeholder', 'Search', 'alt', 'Hero', 'title', 'Save title', 'data-testid', 'save'], backendNodeId: 7, nodeName: 'BUTTON' } } };
      if (command.method === 'Accessibility.getPartialAXTree')
        return { value: { nodes: [{ backendDOMNodeId: 7, ignored: false, name: { value: 'Save' }, role: { value: 'button' } }] } };
      return { value: {} };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const find = session.definitions.find(definition => definition.name === 'browser.find');
  if (targetRef === undefined || find === undefined) throw new Error('browser.find is missing.');
  const locators = [
    { name: { match: 'exact', value: 'Save' }, role: 'button' },
    { text: { match: 'substring', value: 'Sav' } },
    { label: { flags: 'i', match: 'regex', pattern: '^save$' } },
    { css: 'button.save' },
    { placeholder: { match: 'exact', value: 'Search' } },
    { altText: { match: 'exact', value: 'Hero' } },
    { title: { match: 'exact', value: 'Save title' } },
    { testId: { match: 'exact', value: 'save' } },
    { xpath: '//button[normalize-space(.)="Save"]' },
  ] as const;
  const references: string[] = [];
  for (const locator of locators) {
    const result = await find.invoke({ locator, targetRef });
    expect(result.isError).toBeUndefined();
    references.push((JSON.parse(text(result)) as Array<{ readonly ref: string }>)[0]?.ref ?? '');
  }

  expect(references).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
  expect(commands.filter(command => command.method === 'DOM.getDocument').every(command =>
    [0, -1].includes(Number(command.parameters?.depth)) && command.parameters?.pierce === true)).toBe(true);
  expect(commands.filter(command => command.method === 'DOM.performSearch').every(command =>
    command.parameters?.includeUserAgentShadowDOM === false)).toBe(true);
  expect(commands.some(command => command.method === 'DOM.performSearch'
    && command.parameters?.query === '//button[normalize-space(.)="Save"]')).toBe(true);
  expect(commands.filter(command => command.method === 'DOM.performSearch'
    && command.parameters?.query === '//button[normalize-space(.)="Save"]')).toHaveLength(1);
});

it('scopes locators through an OOPIF frame chain', async () => {
  expect.assertions(4);
  const commands: CdpCommand[] = [];
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      commands.push(command);
      if (command.method === 'Bridge.listChildSessions')
        return { value: { sessions: [{ frameId: 'frame-target', generation: 1, id: childSessionId, type: 'iframe' }] } };
      if (command.method === 'Accessibility.getRootAXNode') return { value: { node: { backendDOMNodeId: 1 } } };
      if (command.method === 'DOM.getDocument')
        return { value: { root: { backendNodeId: command.sessionId === undefined ? 1 : 2 } } };
      if (command.method === 'Accessibility.queryAXTree' && command.sessionId === undefined)
        return { value: { nodes: [{ backendDOMNodeId: 20, childIds: [], ignored: false, name: { value: 'Analytics frame' }, nodeId: 'frame', role: { value: 'iframe' } }] } };
      if (command.method === 'Accessibility.queryAXTree' && command.sessionId === childSessionId)
        return { value: { nodes: [{ backendDOMNodeId: 30, childIds: [], ignored: false, name: { value: 'Experiments' }, nodeId: 'experiments', role: { value: 'link' } }] } };
      if (command.method === 'DOM.describeNode')
        return { value: { node: { backendNodeId: 20, frameId: 'frame-target', nodeName: 'IFRAME' } } };
      return { value: {} };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const find = session.definitions.find(definition => definition.name === 'browser.find');
  if (targetRef === undefined || find === undefined) throw new Error('browser.find is missing.');

  const result = await find.invoke({
    locator: {
      frameChain: [{ name: { match: 'exact', value: 'Analytics frame' }, role: 'iframe' }],
      name: { match: 'exact', value: 'Experiments' },
      role: 'link',
    },
    targetRef,
  });

  expect(result.isError).toBeUndefined();
  expect(JSON.parse(text(result))).toEqual([{ name: 'Experiments', ref: 'e1', role: 'link' }]);
  expect(commands.filter(command => command.method === 'Accessibility.queryAXTree').map(command => command.sessionId))
    .toEqual([undefined, childSessionId]);
  expect(commands.find(command => command.method === 'DOM.describeNode')?.sessionId).toBeUndefined();
});

it('scopes locators through a same-process iframe document', async () => {
  expect.assertions(3);
  let accessibilityTreeCalls = 0;
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Bridge.listChildSessions') return { value: { sessions: [] } };
      if (command.method === 'Accessibility.getRootAXNode') return { value: { node: { backendDOMNodeId: 1 } } };
      if (command.method === 'DOM.getDocument') return { value: { root: { backendNodeId: 1 } } };
      if (command.method === 'Accessibility.queryAXTree') {
        accessibilityTreeCalls += 1;
        return accessibilityTreeCalls === 1
          ? { value: { nodes: [{ backendDOMNodeId: 20, childIds: [], ignored: false, name: { value: 'Local frame' }, nodeId: 'frame', role: { value: 'iframe' } }] } }
          : { value: { nodes: [{ backendDOMNodeId: 30, childIds: [], ignored: false, name: { value: 'Save' }, nodeId: 'save', role: { value: 'button' } }] } };
      }
      if (command.method === 'DOM.describeNode' && command.parameters?.backendNodeId === 20)
        return { value: { node: { backendNodeId: 20, contentDocument: { backendNodeId: 25 }, nodeName: 'IFRAME' } } };
      if (command.method === 'DOM.getFlattenedDocument')
        return { value: { nodes: [{ nodeId: 25, backendNodeId: 25, children: [{ nodeId: 30, backendNodeId: 30 }] }] } };
      return { value: {} };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const find = session.definitions.find(definition => definition.name === 'browser.find');
  if (targetRef === undefined || find === undefined) throw new Error('browser.find is missing.');

  const result = await find.invoke({
    locator: {
      frameChain: [{ name: { match: 'exact', value: 'Local frame' }, role: 'iframe' }],
      name: { match: 'exact', value: 'Save' },
      role: 'button',
    },
    targetRef,
  });

  expect(result.isError).toBeUndefined();
  expect(JSON.parse(text(result))).toEqual([{ name: 'Save', ref: 'e1', role: 'button' }]);
  expect(accessibilityTreeCalls).toBe(2);
});

it('applies descendant, has-text, exclusion, and nth filters against DOM ancestry', async () => {
  expect.assertions(7);
  let containmentReads = 0;
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Accessibility.getRootAXNode') return { value: { node: { backendDOMNodeId: 1 } } };
      if (command.method === 'DOM.getDocument') return { value: { root: { backendNodeId: 1 } } };
      if (command.method === 'Accessibility.queryAXTree')
        return {
          value: {
            nodes: [
              { backendDOMNodeId: 10, childIds: [], ignored: false, name: { value: 'Card A' }, nodeId: 'card-a', role: { value: 'group' } },
              { backendDOMNodeId: 11, childIds: [], ignored: false, name: { value: 'Save' }, nodeId: 'save', role: { value: 'button' } },
              { backendDOMNodeId: 12, childIds: [], ignored: false, name: { value: 'Active' }, nodeId: 'active', role: { value: 'StaticText' } },
              { backendDOMNodeId: 20, childIds: [], ignored: false, name: { value: 'Card B' }, nodeId: 'card-b', role: { value: 'group' } },
              { backendDOMNodeId: 21, childIds: [], ignored: false, name: { value: 'Delete' }, nodeId: 'delete', role: { value: 'button' } },
            ],
          },
        };
      if (command.method === 'DOM.getFlattenedDocument') {
        containmentReads += 1;
        return { value: { nodes: [
          { backendNodeId: 10, nodeId: 10, shadowRoots: [{ backendNodeId: 15, nodeId: 15, shadowRootType: 'closed' }] },
          { backendNodeId: 11, nodeId: 11, parentId: 15 },
          { backendNodeId: 12, nodeId: 12, parentId: 15 },
          { backendNodeId: 20, nodeId: 20 },
          { backendNodeId: 21, nodeId: 21, parentId: 20 },
        ] } };
      }
      return { value: command.method === 'Bridge.listChildSessions' ? { sessions: [] } : {} };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const find = session.definitions.find(definition => definition.name === 'browser.find');
  if (targetRef === undefined || find === undefined) throw new Error('browser.find is missing.');

  const filtered = await find.invoke({
    locator: {
      exclude: { name: { match: 'exact', value: 'Delete' }, role: 'button' },
      has: { name: { match: 'exact', value: 'Save' }, role: 'button' },
      hasText: { match: 'exact', value: 'Active' },
      role: 'group',
    },
    targetRef,
  });
  expect(filtered.isError).toBeUndefined();
  expect(JSON.parse(text(filtered))).toEqual([{ name: 'Card A', ref: 'e1', role: 'group' }]);

  const descendant = await find.invoke({
    locator: { descendants: [{ role: 'button' }], nth: 1, role: 'group' },
    targetRef,
  });
  expect(descendant.isError).toBeUndefined();
  expect(JSON.parse(text(descendant))).toEqual([{ name: 'Delete', ref: 'e2', role: 'button' }]);

  const ambiguous = await find.invoke({ locator: { role: 'button' }, targetRef });
  expect(ambiguous.isError).toBeUndefined();
  expect(JSON.parse(text(ambiguous))).toHaveLength(2);
  expect(containmentReads).toBe(2);
});

it('re-resolves a locator once when authority renews before input dispatch', async () => {
  expect.assertions(4);
  let generation = 1;
  let staleThrown = false;
  const commands: CdpCommand[] = [];
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[]; readonly targetGeneration: number }) {
      return { ...lease(request.requestedMethods), targetGeneration: request.targetGeneration };
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      commands.push(command);
      if (command.method === 'Accessibility.getRootAXNode') return { value: { node: { backendDOMNodeId: 1 } } };
      if (command.method === 'DOM.getDocument') return { value: { root: { backendNodeId: 1 } } };
      if (command.method === 'Accessibility.queryAXTree' && !staleThrown) {
        staleThrown = true;
        generation = 2;
        throw Object.assign(new Error('The target generation changed.'), { code: 'TARGET_GENERATION_STALE' });
      }
      if (command.method === 'Accessibility.queryAXTree')
        return { value: { nodes: [{ backendDOMNodeId: 7, childIds: [], ignored: false, name: { value: 'Save' }, nodeId: 'save', role: { value: 'button' } }] } };
      if (command.method === 'Accessibility.getPartialAXTree')
        return { value: { nodes: [{ backendDOMNodeId: 7, properties: [], role: { value: 'button' } }] } };
      if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: 7 } } };
      if (command.method === 'DOM.getContentQuads') return { value: { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] } };
      if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 7 } };
      return { value: {} };
    },
    async listTargets() {
      return [{ ...target, generation }];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const click = session.definitions.find(definition => definition.name === 'browser.click');
  if (targetRef === undefined || click === undefined) throw new Error('browser.click is missing.');

  const result = await click.invoke({
    locator: { name: { match: 'exact', value: 'Save' }, role: 'button' },
    targetRef,
  });

  expect(result.isError).toBeUndefined();
  expect(commands.filter(command => command.method === 'Accessibility.queryAXTree')).toHaveLength(2);
  expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent')).toHaveLength(3);
  expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent').every(command =>
    command.targetGeneration === 2)).toBe(true);
});

it('never replays a locator action after pointer input may have dispatched', async () => {
  expect.assertions(3);
  const pointerCommands: CdpCommand[] = [];
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      if (command.method === 'Bridge.listChildSessions') return { value: { sessions: [] } };
      if (command.method === 'Accessibility.getRootAXNode') return { value: { node: { backendDOMNodeId: 1 } } };
      if (command.method === 'DOM.getDocument') return { value: { root: { backendNodeId: 1 } } };
      if (command.method === 'Accessibility.queryAXTree')
        return { value: { nodes: [{ backendDOMNodeId: 7, childIds: [], ignored: false, name: { value: 'Save' }, nodeId: 'save', role: { value: 'button' } }] } };
      if (command.method === 'Accessibility.getPartialAXTree')
        return { value: { nodes: [{ backendDOMNodeId: 7, properties: [], role: { value: 'button' } }] } };
      if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: 7 } } };
      if (command.method === 'DOM.getContentQuads') return { value: { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] } };
      if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 7 } };
      if (command.method === 'Input.dispatchMouseEvent') {
        pointerCommands.push(command);
        if (command.parameters?.type === 'mousePressed')
          throw Object.assign(new Error('The target generation changed.'), { code: 'TARGET_GENERATION_STALE' });
      }
      return { value: {} };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const click = session.definitions.find(definition => definition.name === 'browser.click');
  if (targetRef === undefined || click === undefined) throw new Error('browser.click is missing.');

  const result = await click.invoke({
    locator: { name: { match: 'exact', value: 'Save' }, role: 'button' },
    targetRef,
  });

  expect(result.isError).toBe(true);
  expect(JSON.parse(text(result))).toMatchObject({ code: 'MCP_ACTION_OUTCOME_UNKNOWN' });
  expect(pointerCommands.map(command => command.parameters?.type)).toEqual(['mouseMoved', 'mousePressed']);
});
