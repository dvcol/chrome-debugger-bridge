import type { CdpCommand, Lease } from '@dvcol/cdb';

import type { McpChromeDebuggerBridgeClient } from '../src/index.js';

import { expect, it } from 'vitest';

import { createCdbToolSession } from '../src/index.js';

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
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const navigate = session.definitions.find(tool => tool.name === 'browser.navigate');
  if (navigate === undefined || targetRef === undefined) throw new Error('browser.navigate is missing');

  const result = await navigate.invoke({
    targetRef,
    url: 'https://next.example.test/',
  });
  const payload = JSON.parse((result.content[0] as { readonly text: string }).text) as {
    readonly target: { readonly targetRef: string };
  };

  expect(result.isError).toBeUndefined();
  expect(payload.target.targetRef).toBe('t1');
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
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const navigate = session.definitions.find(tool => tool.name === 'browser.navigate');
  if (navigate === undefined || targetRef === undefined) throw new Error('browser.navigate is missing');

  const result = await navigate.invoke({
    targetRef,
    url: 'https://next.example.test/',
  });
  const payload = JSON.parse((result.content[0] as { readonly text: string }).text) as {
    readonly milestone: { readonly method: string };
    readonly target: { readonly targetRef: string };
  };

  expect(result.isError).toBeUndefined();
  expect(payload.target.targetRef).toBe('t1');
  expect(payload.milestone.method).toBe('Page.loadEventFired');
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
  const session = createCdbToolSession({ client });
  const targetRef = session.projectTarget(target)?.targetRef;
  const navigate = session.definitions.find(tool => tool.name === 'browser.navigate');
  if (navigate === undefined || targetRef === undefined) throw new Error('browser.navigate is missing');

  const result = await navigate.invoke({
    targetRef,
    timeoutMilliseconds: 1,
    url: 'https://next.example.test/',
  });

  expect(result.isError).toBe(true);
  expect(JSON.parse((result.content[0] as { readonly text: string }).text)).toMatchObject({
    code: 'MCP_TARGET_RENEWAL_TIMEOUT',
    retryable: true,
  });
});
