import type { CdpCommand, Lease, PublishedTarget } from '@dvcol/cdb';

import type { McpChromeDebuggerBridgeClient } from '../src/index.js';

import { Buffer } from 'node:buffer';

import { expect, it } from 'vitest';

import { createCdbToolSession } from '../src/index.js';

const target: PublishedTarget = {
  availability: 'available',
  capabilities: { level: 'interact' },
  generation: 1,
  id: '42aa339f-5267-4a31-bc88-81c4a1e59aa0',
  scopeId: '7f6d1a3d-e296-47e9-8365-a3af1bd09b08',
  type: 'page',
};

function toolHarness(executeCommand: (command: CdpCommand) => Promise<unknown>) {
  let leases = 0;
  const client = {
    async acquireLease(request: { readonly mode?: Lease['mode']; readonly requestedMethods: readonly string[] }) {
      leases += 1;
      return {
        expiresAt: '2030-01-01T00:00:00.000Z',
        id: '60013aa6-2e2d-4fa1-9e10-8de7c0e811e3',
        issuedAt: '2026-09-06T00:00:00.000Z',
        methods: [...request.requestedMethods],
        mode: request.mode ?? 'shared-read',
        targetGeneration: target.generation,
        targetId: target.id,
      };
    },
    async cancelCommand() {},
    executeCommand,
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
    async subscribe() {
      return { close() {}, [Symbol.asyncIterator]() {
        return { next: async () => new Promise<IteratorResult<never>>(() => {}) };
      } };
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)!.targetRef;
  return {
    client,
    get leases() {
      return leases;
    },
    async invoke(name: string, input: Record<string, unknown> = {}) {
      const definition = session.definitions.find(candidate => candidate.name === name);
      if (definition === undefined) throw new Error(`Missing ${name}`);
      const result = await definition.invoke({ targetRef, ...input });
      const content = result.content[0];
      if (content?.type !== 'text') throw new Error('Expected text content.');
      return { error: result.isError, text: content.text };
    },
    session,
  };
}

it('returns screenshot image content and releases its artifact without exposing diagnostic tools', async () => {
  expect.assertions(5);
  const imageData = Buffer.from('synthetic image bytes').toString('base64');
  const bytes = Buffer.from(JSON.stringify({ data: imageData }));
  const harness = toolHarness(async () => ({ value: { artifact: { id: 'screenshot-artifact', expiresAt: '2030-01-01T00:00:00.000Z', length: bytes.length, mediaType: 'application/json' } } }));
  const released: string[] = [];
  harness.client.readArtifact = async () => bytes;
  harness.client.releaseArtifact = async (request) => {
    released.push(request.artifactId);
  };
  harness.client.releaseLease = async (request) => {
    released.push(request.leaseId);
  };

  const screenshot = harness.session.definitions.find(definition => definition.name === 'browser.screenshot')!;
  const result = await screenshot.invoke({ targetRef: 't1' });

  expect(result.isError).toBeUndefined();
  expect(result.content).toEqual([{ type: 'image', data: imageData, mimeType: 'image/png' }]);
  expect(released).toContain('screenshot-artifact');
  expect(released).toContain('60013aa6-2e2d-4fa1-9e10-8de7c0e811e3');
  expect(harness.session.definitions.some(definition => definition.name === 'browser.read_artifact')).toBe(false);
});

it('finds a control below 200 structural ancestors without spending its output budget on indentation', async () => {
  expect.assertions(3);
  const nodes = Array.from({ length: 201 }, (_unused, index) => ({
    backendDOMNodeId: index + 1,
    childIds: index === 200 ? [] : [`node-${index + 1}`],
    ignored: false,
    name: { value: index === 200 ? 'Save changes' : '' },
    nodeId: `node-${index}`,
    role: { value: index === 200 ? 'button' : 'generic' },
  }));
  const harness = toolHarness(async command => ({ value: command.method === 'Accessibility.getFullAXTree' ? { nodes } : { sessions: [] } }));

  const result = await harness.invoke('browser.snapshot');

  expect(result.error).toBeUndefined();
  expect(result.text).toContain('- button "Save changes" [ref=e1]');
  expect(result.text.length).toBeLessThan(200);
});

it('reports incomplete bounded observations without cutting an element reference in half', async () => {
  expect.assertions(4);
  const nodes = Array.from({ length: 2_000 }, (_unused, index) => ({
    backendDOMNodeId: index + 1,
    childIds: [],
    ignored: false,
    name: { value: `Action ${index}: ${'Long accessible label '.repeat(20)}` },
    nodeId: `node-${index}`,
    role: { value: 'button' },
  }));
  const harness = toolHarness(async command => ({ value: command.method === 'Accessibility.getFullAXTree' ? { nodes } : { sessions: [] } }));

  const result = await harness.invoke('browser.snapshot');

  expect(result.error).toBeUndefined();
  expect(result.text.length).toBeLessThanOrEqual(6_000);
  expect(result.text).toContain('snapshot truncated');
  expect(result.text.split('\n').filter(line => line.includes('[ref=')).every(line => /\[ref=e\d+\]$/u.test(line))).toBe(true);
});

it('includes control state and values needed to verify a form without inspecting every field separately', async () => {
  expect.assertions(4);
  const nodes = [
    { backendDOMNodeId: 1, nodeId: 'name', role: { value: 'textbox' }, name: { value: 'Display name' }, value: { value: 'Ada' }, properties: [{ name: 'required', value: { value: true } }] },
    { backendDOMNodeId: 2, nodeId: 'toggle', role: { value: 'checkbox' }, name: { value: 'Enabled' }, properties: [{ name: 'checked', value: { value: 'false' } }, { name: 'disabled', value: { value: true } }] },
  ];
  const harness = toolHarness(async command => ({ value: command.method === 'Accessibility.getFullAXTree' ? { nodes } : { sessions: [] } }));

  const result = await harness.invoke('browser.snapshot');

  expect(result.text).toContain('value="Ada"');
  expect(result.text).toContain('[required]');
  expect(result.text).toContain('[checked=false]');
  expect(result.text).toContain('[disabled]');
});

it('expands a selected subtree using its previous snapshot reference', async () => {
  expect.assertions(3);
  const nodes = [{ backendDOMNodeId: 17, nodeId: 'group', name: { value: 'Preferences' }, role: { value: 'button' } }];
  const harness = toolHarness(async (command) => {
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes } };
    if (command.method === 'Accessibility.queryAXTree' && command.parameters?.backendNodeId === 17) {
      return { value: { nodes: [{ backendDOMNodeId: 18, nodeId: 'save', name: { value: 'Save preferences' }, role: { value: 'button' } }] } };
    }
    return { value: { sessions: [] } };
  });
  await harness.invoke('browser.snapshot');

  const result = await harness.invoke('browser.snapshot', { root: { ref: 'e1' } });

  expect(result.error).toBeUndefined();
  expect(result.text).toContain('Save preferences');
  expect(result.text).not.toContain('"Preferences"');
});

it('rejects a search that exceeds its complete candidate budget instead of claiming a unique match', async () => {
  expect.assertions(2);
  const harness = toolHarness(async (command) => {
    if (command.method === 'DOM.performSearch') return { value: { searchId: 'wide-search', resultCount: 100_001 } };
    if (command.method === 'DOM.getSearchResults') return { value: { nodeIds: [1] } };
    if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: 1, nodeName: 'BUTTON' } } };
    if (command.method === 'Accessibility.getPartialAXTree') return { value: { nodes: [{ nodeId: 'one', name: { value: 'Only first result' }, role: { value: 'button' } }] } };
    return { value: { sessions: [] } };
  });

  const result = await harness.invoke('browser.find', { locator: { xpath: '//button' } });

  expect(result.error).toBe(true);
  expect(result.text).toContain('MCP_SEARCH_INCOMPLETE');
});

it('re-resolves a locator after replacement before input, while a disposable ref fails stale', async () => {
  expect.assertions(4);
  let searches = 0;
  let inputCount = 0;
  const harness = toolHarness(async (command) => {
    if (command.method === 'DOM.getDocument') return { value: { root: { backendNodeId: 1 } } };
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes: [{ backendDOMNodeId: 41, nodeId: 'old', name: { value: 'Save' }, role: { value: 'button' } }] } };
    if (command.method === 'Accessibility.queryAXTree') {
      searches += 1;
      return { value: { nodes: [{ backendDOMNodeId: searches === 1 ? 41 : 42, nodeId: 'save', name: { value: 'Save' }, role: { value: 'button' } }] } };
    }
    if (command.method === 'DOM.describeNode') {
      if (command.parameters?.backendNodeId === 41) throw new Error('No node with given id found');
      return { value: { node: { backendNodeId: 42 } } };
    }
    if (command.method === 'DOM.getContentQuads') return { value: { quads: [[0, 0, 100, 0, 100, 50, 0, 50]] } };
    if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 42 } };
    if (command.method.startsWith('Input.')) inputCount += 1;
    return { value: { sessions: [] } };
  });
  await harness.invoke('browser.snapshot');
  const stale = await harness.invoke('browser.click', { ref: 'e1', timeoutMilliseconds: 200 });
  const replaced = await harness.invoke('browser.click', { locator: { role: 'button', name: { match: 'exact', value: 'Save' } }, timeoutMilliseconds: 500 });

  expect(stale.text).toContain('MCP_ELEMENT_REF_STALE');
  expect(replaced.error).toBeUndefined();
  expect(searches).toBe(2);
  expect(inputCount).toBe(3);
});

it('reports a rejected fill without replaying input and recognizes string-valued checked states', async () => {
  expect.assertions(4);
  let insertions = 0;
  const harness = toolHarness(async (command) => {
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes: [
      { backendDOMNodeId: 1, nodeId: 'field', name: { value: 'Name' }, role: { value: 'textbox' } },
      { backendDOMNodeId: 2, nodeId: 'check', name: { value: 'Active' }, role: { value: 'checkbox' } },
    ] } };
    if (command.method === 'Accessibility.getPartialAXTree') return { value: { nodes: [{ role: { value: 'textbox' }, value: { value: 'Rejected' }, properties: [{ name: 'checked', value: { value: 'true' } }] }] } };
    if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: command.parameters?.backendNodeId } } };
    if (command.method === 'DOM.getContentQuads') return { value: { quads: [[0, 0, 100, 0, 100, 50, 0, 50]] } };
    if (command.method === 'Input.insertText') insertions += 1;
    if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 1 } };
    return { value: { sessions: [] } };
  });
  await harness.invoke('browser.snapshot');
  const fill = await harness.invoke('browser.fill', { ref: 'e1', text: 'Accepted' });
  const check = await harness.invoke('browser.check', { ref: 'e2' });

  expect(fill.text).toContain('MCP_ACTION_VERIFICATION_FAILED');
  expect(insertions).toBe(1);
  expect(check.error).toBeUndefined();
  expect(JSON.parse(check.text)).toEqual({ changed: false, checked: true });
});

it('applies CSS selectors inside each shadow root without matching selector text in scripts', async () => {
  expect.assertions(3);
  const harness = toolHarness(async (command) => {
    if (command.method === 'DOM.getFlattenedDocument') return { value: { nodes: [{ nodeId: 1, nodeType: 9, children: [
      { nodeId: 2, backendNodeId: 2, nodeName: 'SCRIPT', children: [] },
      { nodeId: 3, backendNodeId: 3, shadowRoots: [{ nodeId: 4, nodeType: 11, shadowRootType: 'closed', children: [{ nodeId: 5, backendNodeId: 5, nodeName: 'BUTTON', attributes: ['id', 'save'] }] }] },
    ] }] } };
    if (command.method === 'DOM.querySelectorAll') return { value: { nodeIds: command.parameters?.nodeId === 4 ? [5] : [] } };
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes: [{ backendDOMNodeId: 5, name: { value: 'Save' }, role: { value: 'button' } }] } };
    if (command.method === 'DOM.performSearch') return { value: { searchId: 'text-match', resultCount: 2 } };
    if (command.method === 'DOM.getSearchResults') return { value: { nodeIds: [2, 5] } };
    return { value: { sessions: [] } };
  });

  const result = await harness.invoke('browser.find', { locator: { css: '#save' } });

  expect(result.error).toBeUndefined();
  expect(JSON.parse(result.text)).toHaveLength(1);
  expect((JSON.parse(result.text) as unknown[])[0]).toMatchObject({ name: 'Save', role: 'button' });
});

it('preserves the failure cause when fill verification becomes unavailable without replaying input', async () => {
  expect.assertions(3);
  let insertions = 0;
  const harness = toolHarness(async (command) => {
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes: [{ backendDOMNodeId: 1, nodeId: 'field', name: { value: 'Name' }, role: { value: 'textbox' } }] } };
    if (command.method === 'Accessibility.getPartialAXTree') {
      if (insertions > 0) throw Object.assign(new Error('Node unavailable after editing'), { code: 'CDP_COMMAND_FAILED' });
      return { value: { nodes: [{ role: { value: 'textbox' } }] } };
    }
    if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: 1 } } };
    if (command.method === 'DOM.getContentQuads') return { value: { quads: [[0, 0, 100, 0, 100, 50, 0, 50]] } };
    if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 1 } };
    if (command.method === 'Input.insertText') insertions += 1;
    return { value: { sessions: [] } };
  });
  await harness.invoke('browser.snapshot');

  const result = await harness.invoke('browser.fill', { ref: 'e1', text: 'Example' });
  const outcome = JSON.parse(result.text) as Record<string, unknown>;

  expect(outcome.code).toBe('MCP_ACTION_OUTCOME_UNKNOWN');
  expect(outcome.details).toMatchObject({ cause: { code: 'CDP_COMMAND_FAILED', message: 'Node unavailable after editing' } });
  expect(insertions).toBe(1);
});

it('executes ordered element actions in one batch lease and stops after an uncertain dispatch', async () => {
  expect.assertions(7);
  let inputCount = 0;
  const harness = toolHarness(async (command) => {
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes: [{ backendDOMNodeId: 1, nodeId: 'save', name: { value: 'Save' }, role: { value: 'button' } }] } };
    if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: 1 } } };
    if (command.method === 'DOM.getContentQuads') return { value: { quads: [[0, 0, 100, 0, 100, 50, 0, 50]] } };
    if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 1 } };
    if (command.method === 'Input.dispatchMouseEvent') {
      inputCount += 1;
      if (inputCount === 4) throw new Error('Connection lost after dispatch');
    }
    return { value: { sessions: [] } };
  });
  await harness.invoke('browser.snapshot');
  const leasesBefore = harness.leases;

  const result = await harness.invoke('browser.batch', { actions: [{ action: 'click', ref: 'e1' }, { action: 'click', ref: 'e1' }, { action: 'click', ref: 'e1' }] });
  const outcome = JSON.parse(result.text) as Record<string, unknown>;

  expect(harness.leases - leasesBefore).toBe(1);
  expect(outcome.code).toBe('MCP_ACTION_OUTCOME_UNKNOWN');
  expect(outcome.retryable).toBe(false);
  expect(outcome.details).toMatchObject({ completed: [{ index: 0, action: 'click' }] });
  expect(outcome.details).toMatchObject({ failedStep: 1 });
  expect(outcome.details).toMatchObject({ uncertain: true });
  expect(inputCount).toBe(4);
});

it('keeps raw authority and debug execution out of the default compact catalogue', () => {
  expect.assertions(3);
  const session = createCdbToolSession({ client: {} as McpChromeDebuggerBridgeClient });
  const catalogue = session.definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

  expect(catalogue.some(tool => ['browser.acquire', 'browser.raw_cdp', 'browser.evaluate', 'browser.read_artifact'].includes(tool.name))).toBe(false);
  expect(JSON.stringify(catalogue).length).toBeLessThan(70_000);
  expect(catalogue.find(tool => tool.name === 'browser.batch')).toBeDefined();
});

it('reports the complete match count when limiting returned references', async () => {
  expect.assertions(3);
  const harness = toolHarness(async (command) => {
    if (command.method === 'DOM.getDocument') return { value: { root: { backendNodeId: 1 } } };
    if (command.method === 'Accessibility.queryAXTree') return { value: { nodes: Array.from({ length: 3 }, (_unused, index) => ({ backendDOMNodeId: index + 1, nodeId: `button-${index}`, name: { value: 'Save' }, role: { value: 'button' } })) } };
    return { value: { sessions: [] } };
  });

  const result = await harness.invoke('browser.find', { locator: { role: 'button' }, maximumMatches: 1 });
  const outcome = JSON.parse(result.text) as Record<string, unknown>;

  expect(outcome.totalMatches).toBe(3);
  expect(outcome.truncated).toBe(true);
  expect(outcome.matches).toHaveLength(1);
});

it.each([
  { depth: 1, breadth: 1 },
  { depth: 200, breadth: 1 },
  { depth: 200, breadth: 10_000 },
  { depth: 1_000, breadth: 100_000 },
])('bounds observations across $depth levels and $breadth controls without losing the first deep control', async ({ depth, breadth }) => {
  expect.assertions(4);
  const nodes = [
    ...Array.from({ length: depth }, (_unused, index) => ({ backendDOMNodeId: index + 1, childIds: index === depth - 1 ? Array.from({ length: breadth }, (_item, child) => `control-${child}`) : [`wrapper-${index + 1}`], ignored: index % 2 === 0, nodeId: `wrapper-${index}`, role: { value: 'generic' } })),
    ...Array.from({ length: breadth }, (_unused, index) => ({ backendDOMNodeId: depth + index + 1, childIds: [], name: { value: `Control ${index}` }, nodeId: `control-${index}`, role: { value: 'button' } })),
  ];
  const harness = toolHarness(async command => ({ value: command.method === 'Accessibility.getFullAXTree' ? { nodes } : { sessions: [] } }));

  const result = await harness.invoke('browser.snapshot');

  expect(result.error).toBeUndefined();
  expect(result.text).toContain('button "Control 0" [ref=e1]');
  expect(result.text.length).toBeLessThanOrEqual(6_000);
  expect(result.text.includes('snapshot truncated')).toBe(breadth > 1);
});

it.each([
  { state: 'disabled', code: 'MCP_ELEMENT_DISABLED', tool: 'browser.click', properties: [{ name: 'disabled', value: { value: true } }] },
  { state: 'readonly', code: 'MCP_ELEMENT_NOT_EDITABLE', tool: 'browser.fill', properties: [{ name: 'readonly', value: { value: true } }] },
  { state: 'hidden', code: 'MCP_ELEMENT_HIDDEN', tool: 'browser.click', properties: [] },
  { state: 'covered', code: 'MCP_ELEMENT_COVERED', tool: 'browser.click', properties: [] },
  { state: 'moving', code: 'MCP_ELEMENT_UNSTABLE', tool: 'browser.click', properties: [] },
])('does not dispatch input into a $state control', async ({ state, code, tool, properties }) => {
  expect.assertions(2);
  let inputCount = 0;
  let geometryCount = 0;
  const harness = toolHarness(async (command) => {
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes: [{ backendDOMNodeId: 1, nodeId: 'control', name: { value: 'Control' }, role: { value: 'textbox' } }] } };
    if (command.method === 'Accessibility.getPartialAXTree') return { value: { nodes: [{ role: { value: 'textbox' }, properties }] } };
    if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: 1 } } };
    if (command.method === 'DOM.getContentQuads') {
      geometryCount += 1;
      const offset = state === 'moving' ? geometryCount * 10 : 0;
      return { value: { quads: state === 'hidden' ? [] : [[offset, 0, offset + 100, 0, offset + 100, 50, offset, 50]] } };
    }
    if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: state === 'covered' ? 99 : 1 } };
    if (command.method.startsWith('Input.')) inputCount += 1;
    return { value: { sessions: [] } };
  });
  await harness.invoke('browser.snapshot');

  const result = await harness.invoke(tool, { ref: 'e1', text: 'Sample', timeoutMilliseconds: 1 });

  expect(result.text).toContain(code);
  expect(inputCount).toBe(0);
});

it('checks an indeterminate control and verifies the resulting checked state', async () => {
  expect.assertions(2);
  let checked = 'mixed';
  const harness = toolHarness(async (command) => {
    if (command.method === 'Accessibility.getFullAXTree') return { value: { nodes: [{ backendDOMNodeId: 1, nodeId: 'toggle', name: { value: 'Selected' }, role: { value: 'checkbox' } }] } };
    if (command.method === 'Accessibility.getPartialAXTree') return { value: { nodes: [{ role: { value: 'checkbox' }, properties: [{ name: 'checked', value: { value: checked } }] }] } };
    if (command.method === 'DOM.describeNode') return { value: { node: { backendNodeId: 1 } } };
    if (command.method === 'DOM.getContentQuads') return { value: { quads: [[0, 0, 100, 0, 100, 50, 0, 50]] } };
    if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 1 } };
    if (command.method === 'Input.dispatchMouseEvent' && command.parameters?.type === 'mouseReleased') checked = 'true';
    return { value: { sessions: [] } };
  });
  await harness.invoke('browser.snapshot');

  const result = await harness.invoke('browser.check', { ref: 'e1' });

  expect(result.error).toBeUndefined();
  expect(JSON.parse(result.text)).toEqual({ changed: true, checked: true });
});
