import type { CdpCommand, Lease } from '@dvcol/cdb';

import type { McpChromeDebuggerBridgeClient } from '../src/index.js';

import { expect, it, vi } from 'vitest';

import { createCdbToolDefinitions } from '../src/index.js';

const target = {
  availability: 'available',
  capabilities: { level: 'unsafe' as const },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
} as const;

function lease(methods: readonly string[]): Lease {
  return {
    expiresAt: '2030-01-01T00:00:00.000Z',
    id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
    issuedAt: '2026-08-26T00:00:00.000Z',
    methods: [...methods],
    mode: 'exclusive-control',
    targetGeneration: target.generation,
    targetId: target.id,
  };
}

it('dispatches balanced multi-clicks with encoded modifiers under one lease', async () => {
  expect.assertions(4);
  const commands: CdpCommand[] = [];
  const acquireLease = vi.fn(async (request: { readonly requestedMethods: readonly string[] }) => lease(request.requestedMethods));
  const releaseLease = vi.fn(async () => {});
  const client = {
    acquireLease,
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      commands.push(command);
      return { operationId: command.operationId, value: {} };
    },
    releaseLease,
  } as unknown as McpChromeDebuggerBridgeClient;
  const click = createCdbToolDefinitions({ client }).find(tool => tool.name === 'browser.click');
  if (click === undefined) throw new Error('browser.click is missing');

  const result = await click.invoke({
    button: 'right',
    clickCount: 2,
    modifiers: ['control', 'shift'],
    targetGeneration: target.generation,
    targetId: target.id,
    x: 20,
    y: 30,
  });

  expect(result.isError).toBeUndefined();
  expect(commands.map(command => command.parameters)).toEqual([
    { button: 'right', clickCount: 1, modifiers: 10, type: 'mousePressed', x: 20, y: 30 },
    { button: 'right', clickCount: 1, modifiers: 10, type: 'mouseReleased', x: 20, y: 30 },
    { button: 'right', clickCount: 2, modifiers: 10, type: 'mousePressed', x: 20, y: 30 },
    { button: 'right', clickCount: 2, modifiers: 10, type: 'mouseReleased', x: 20, y: 30 },
  ]);
  expect(acquireLease).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'exclusive-control',
    requestedMethods: ['Input.dispatchMouseEvent'],
  }));
  expect(releaseLease).toHaveBeenCalledOnce();
});

it('releases a pressed drag button and cancels dragging when the request is aborted', async () => {
  expect.assertions(5);
  const commands: CdpCommand[] = [];
  let rejectPendingMove: ((error: Error) => void) | undefined;
  let resolvePendingMoveStarted: (() => void) | undefined;
  const pendingMoveStarted = new Promise<void>((resolve) => {
    resolvePendingMoveStarted = resolve;
  });
  const releaseLease = vi.fn(async () => {});
  const cancelCommand = vi.fn(async () => {
    rejectPendingMove?.(new Error('cancelled'));
  });
  let movedWhilePressed = false;
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    cancelCommand,
    async executeCommand(command: CdpCommand) {
      commands.push(command);
      if (
        command.method === 'Input.dispatchMouseEvent'
        && command.parameters?.type === 'mouseMoved'
        && command.parameters.buttons === 1
        && !movedWhilePressed
      ) {
        movedWhilePressed = true;
        resolvePendingMoveStarted?.();
        return new Promise<never>((_resolve, reject) => {
          rejectPendingMove = reject;
        });
      }
      return { operationId: command.operationId, value: {} };
    },
    releaseLease,
  } as unknown as McpChromeDebuggerBridgeClient;
  const drag = createCdbToolDefinitions({ client }).find(tool => tool.name === 'browser.drag');
  if (drag === undefined) throw new Error('browser.drag is missing');
  const controller = new AbortController();
  const resultPromise = drag.invoke({
    path: [{ x: 1, y: 2 }, { x: 10, y: 20 }],
    targetGeneration: target.generation,
    targetId: target.id,
  }, { signal: controller.signal });
  await pendingMoveStarted;
  controller.abort();
  const result = await resultPromise;

  expect(result.isError).toBe(true);
  expect(cancelCommand).toHaveBeenCalledOnce();
  expect(commands.some(command => command.parameters?.type === 'mouseReleased')).toBe(true);
  expect(commands.some(command => command.method === 'Input.cancelDragging')).toBe(true);
  expect(releaseLease).toHaveBeenCalledOnce();
});

it('resolves and hit-tests a child-session node immediately before clicking it', async () => {
  expect.assertions(6);
  const commands: CdpCommand[] = [];
  const releaseLease = vi.fn(async () => {});
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      commands.push(command);
      if (command.method === 'DOM.describeNode') return { value: { node: { nodeName: 'BUTTON' } } };
      if (command.method === 'DOM.resolveNode') return { value: { object: { objectId: 'node-object' } } };
      if (command.method === 'Runtime.callFunctionOn')
        return { value: { result: { value: { connected: true, disabled: false, editable: false, viewportHeight: 600, viewportWidth: 800, visible: true } } } };
      if (command.method === 'DOM.getContentQuads')
        return { value: { quads: [[10.2, 10.2, 50.8, 10.2, 50.8, 30.8, 10.2, 30.8]] } };
      if (command.method === 'DOM.getNodeForLocation') return { value: { backendNodeId: 7 } };
      return { value: {} };
    },
    releaseLease,
  } as unknown as McpChromeDebuggerBridgeClient;
  const clickNode = createCdbToolDefinitions({ client }).find(tool => tool.name === 'browser.click_node');
  if (clickNode === undefined) throw new Error('browser.click_node is missing');
  const sessionId = 'c5f7a25e-810e-41a7-97d0-ae4636c5e4e5';

  const result = await clickNode.invoke({
    node: { backendNodeId: 7, sessionId },
    targetGeneration: target.generation,
    targetId: target.id,
  });

  expect(result.isError).toBeUndefined();
  expect(commands.every(command => command.sessionId === sessionId)).toBe(true);
  expect(commands.map(command => command.method)).toContain('DOM.scrollIntoViewIfNeeded');
  expect(commands.map(command => command.method)).toContain('DOM.getNodeForLocation');
  expect(commands.filter(command => command.method === 'Input.dispatchMouseEvent').map(command => command.parameters)).toEqual([
    { button: 'left', clickCount: 1, modifiers: 0, type: 'mousePressed', x: 31, y: 21 },
    { button: 'left', clickCount: 1, modifiers: 0, type: 'mouseReleased', x: 31, y: 21 },
  ]);
  expect(releaseLease).toHaveBeenCalledOnce();
});

it('returns a stable structured error before input when a node is hidden', async () => {
  expect.assertions(3);
  const methods: string[] = [];
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      methods.push(command.method);
      if (command.method === 'DOM.resolveNode') return { value: { object: { objectId: 'node-object' } } };
      if (command.method === 'Runtime.callFunctionOn')
        return { value: { result: { value: { connected: true, disabled: false, editable: false, viewportHeight: 600, viewportWidth: 800, visible: false } } } };
      return { value: {} };
    },
    async releaseLease() {},
  } as unknown as McpChromeDebuggerBridgeClient;
  const hoverNode = createCdbToolDefinitions({ client }).find(tool => tool.name === 'browser.hover_node');
  if (hoverNode === undefined) throw new Error('browser.hover_node is missing');

  const result = await hoverNode.invoke({
    node: { backendNodeId: 7 },
    targetGeneration: target.generation,
    targetId: target.id,
  });

  expect(result.isError).toBe(true);
  expect(JSON.parse((result.content[0] as { readonly text: string }).text)).toEqual({
    code: 'MCP_NODE_NOT_VISIBLE',
    details: { backendNodeId: 7 },
    message: 'The snapshot node is not visible.',
    retryable: false,
  });
  expect(methods).not.toContain('Input.dispatchMouseEvent');
});

it('continues a load wait on renewed authority and returns the new generation', async () => {
  expect.assertions(5);
  const renewedTarget = { ...target, generation: 2 };
  const acquiredRequests: unknown[] = [];
  const releasedRequests: unknown[] = [];
  let listCount = 0;
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[]; readonly targetGeneration: number }) {
      acquiredRequests.push(request);
      return {
        ...lease(request.requestedMethods),
        targetGeneration: request.targetGeneration,
      };
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      return { operationId: command.operationId, value: { frameId: 'frame-1', loaderId: 'loader-1' } };
    },
    async listTargets() {
      listCount += 1;
      return listCount === 1 ? [target] : [renewedTarget];
    },
    async releaseLease(request: unknown) {
      releasedRequests.push(request);
    },
    async subscribe(request: { readonly match: { readonly method: string }; readonly targetGeneration: number }) {
      let resolvePendingEvent: ((result: IteratorResult<never>) => void) | undefined;
      return {
        close() {
          resolvePendingEvent?.({ done: true, value: undefined });
        },
        droppedCount: 0,
        id: crypto.randomUUID(),
        lastDeliveredSequence: 0,
        overflowed: false,
        targetGeneration: request.targetGeneration,
        targetId: target.id,
        [Symbol.asyncIterator]() {
          return {
            next: async () => request.targetGeneration === 2 && request.match.method === 'Page.loadEventFired'
              ? {
                  done: false as const,
                  value: {
                    method: request.match.method,
                    parameters: { timestamp: 2 },
                    sequence: 1,
                    subscriptionId: crypto.randomUUID(),
                    targetGeneration: 2,
                    targetId: target.id,
                  },
                }
              : new Promise<IteratorResult<never>>((resolve) => {
                  resolvePendingEvent = resolve;
                }),
          };
        },
      };
    },
    watchTargets() {
      return {
        async* [Symbol.asyncIterator]() {
          yield { kind: 'updated' as const, sequence: 2, target: renewedTarget };
        },
      };
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const navigate = createCdbToolDefinitions({ client }).find(tool => tool.name === 'browser.navigate');
  if (navigate === undefined) throw new Error('browser.navigate is missing');

  const result = await navigate.invoke({
    targetGeneration: target.generation,
    targetId: target.id,
    url: 'https://next.example.test/',
  });
  const payload = JSON.parse((result.content[0] as { readonly text: string }).text) as {
    readonly target: { readonly generation: number };
  };

  expect(result.isError).toBeUndefined();
  expect(payload.target.generation).toBe(2);
  expect(acquiredRequests).toHaveLength(2);
  expect(acquiredRequests).toMatchObject([
    { mode: 'exclusive-control', targetGeneration: 1 },
    { mode: 'shared-read', targetGeneration: 2 },
  ]);
  expect(releasedRequests).toHaveLength(2);
});

it('ignores a stale same-document milestone while a full root navigation renews authority', async () => {
  expect.assertions(3);
  const renewedTarget = { ...target, generation: 2 };
  let authorityRenewed = false;
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[]; readonly targetGeneration: number }) {
      return { ...lease(request.requestedMethods), targetGeneration: request.targetGeneration };
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      return { operationId: command.operationId, value: { frameId: 'frame-1', loaderId: 'loader-2' } };
    },
    async listTargets() {
      return [authorityRenewed ? renewedTarget : target];
    },
    async releaseLease() {},
    async subscribe(request: { readonly match: { readonly method: string }; readonly targetGeneration: number }) {
      let resolvePendingEvent: ((result: IteratorResult<never>) => void) | undefined;
      return {
        close() {
          resolvePendingEvent?.({ done: true, value: undefined });
        },
        droppedCount: 0,
        id: crypto.randomUUID(),
        lastDeliveredSequence: 0,
        overflowed: false,
        targetGeneration: request.targetGeneration,
        targetId: target.id,
        [Symbol.asyncIterator]() {
          return {
            next: async () => request.targetGeneration === 1
              && request.match.method === 'Page.navigatedWithinDocument'
              ? {
                  done: false as const,
                  value: {
                    method: request.match.method,
                    parameters: { frameId: 'frame-1', url: 'https://example.test/previous-route' },
                    sequence: 1,
                    subscriptionId: crypto.randomUUID(),
                    targetGeneration: 1,
                    targetId: target.id,
                  },
                }
              : request.targetGeneration === 2 && request.match.method === 'Page.loadEventFired'
                ? {
                    done: false as const,
                    value: {
                      method: request.match.method,
                      parameters: { timestamp: 2 },
                      sequence: 1,
                      subscriptionId: crypto.randomUUID(),
                      targetGeneration: 2,
                      targetId: target.id,
                    },
                  }
                : new Promise<IteratorResult<never>>((resolve) => {
                    resolvePendingEvent = resolve;
                  }),
          };
        },
      };
    },
    watchTargets() {
      return {
        async* [Symbol.asyncIterator]() {
          await new Promise(resolve => setTimeout(resolve, 5));
          authorityRenewed = true;
          yield { kind: 'updated' as const, sequence: 2, target: renewedTarget };
        },
      };
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const navigate = createCdbToolDefinitions({ client }).find(tool => tool.name === 'browser.navigate');
  if (navigate === undefined) throw new Error('browser.navigate is missing');

  const result = await navigate.invoke({
    targetGeneration: target.generation,
    targetId: target.id,
    url: 'https://next.example.test/',
  });
  const payload = JSON.parse((result.content[0] as { readonly text: string }).text) as {
    readonly milestone: { readonly targetGeneration: number };
    readonly target: { readonly generation: number };
  };

  expect(result.isError).toBeUndefined();
  expect(payload.target.generation).toBe(2);
  expect(payload.milestone.targetGeneration).toBe(2);
});

it('fails a root full-navigation result when renewed authority is not published', async () => {
  expect.assertions(2);
  const client = {
    async acquireLease(request: { readonly requestedMethods: readonly string[] }) {
      return lease(request.requestedMethods);
    },
    async cancelCommand() {},
    async executeCommand(command: CdpCommand) {
      return { operationId: command.operationId, value: { frameId: 'frame-1', loaderId: 'loader-1' } };
    },
    async listTargets() {
      return [target];
    },
    async releaseLease() {},
    async subscribe(request: { readonly match: { readonly method: string } }) {
      return {
        close() {},
        droppedCount: 0,
        id: crypto.randomUUID(),
        lastDeliveredSequence: 0,
        overflowed: false,
        targetGeneration: target.generation,
        targetId: target.id,
        [Symbol.asyncIterator]() {
          return {
            next: async () => request.match.method === 'Page.loadEventFired'
              ? {
                  done: false as const,
                  value: {
                    method: request.match.method,
                    parameters: { timestamp: 1 },
                    sequence: 1,
                    subscriptionId: crypto.randomUUID(),
                    targetGeneration: target.generation,
                    targetId: target.id,
                  },
                }
              : new Promise<IteratorResult<never>>(() => {}),
          };
        },
      };
    },
    watchTargets() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => new Promise<IteratorResult<never>>(() => {}),
            return: async () => ({ done: true as const, value: undefined }),
          };
        },
      };
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const navigate = createCdbToolDefinitions({ client }).find(tool => tool.name === 'browser.navigate');
  if (navigate === undefined) throw new Error('browser.navigate is missing');

  const result = await navigate.invoke({
    targetGeneration: target.generation,
    targetId: target.id,
    timeoutMilliseconds: 1,
    url: 'https://next.example.test/',
  });

  expect(result.isError).toBe(true);
  expect(JSON.parse((result.content[0] as { readonly text: string }).text)).toMatchObject({
    code: 'MCP_TARGET_RENEWAL_TIMEOUT',
    retryable: true,
  });
});
