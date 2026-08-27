import type { McpChromeDebuggerBridgeClient } from '../src/index.js';

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import {
  createCdbToolSession,
  mountMcpStdio,
  mountMcpStreamableHttp,
  registerCdbTools,
  supportedMcpProtocolVersions,
  supportedMcpSdkVersion,
} from '../src/index.js';

const target = {
  availability: 'available',
  capabilities: { level: 'observe' },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
} as const;

it('registers the CDB surface on an application-owned official MCP server', async () => {
  expect.assertions(6);
  const applicationServer = new McpServer({
    name: 'application',
    version: '1.0.0',
  });
  applicationServer.registerTool(
    'application.health',
    { description: 'Return application health.', inputSchema: z.object({}) },
    async () => ({ content: [{ text: 'healthy', type: 'text' }] }),
  );
  const bridgeClient = {
    async listTargets() {
      return [target];
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  registerCdbTools(applicationServer, { client: bridgeClient });
  const [clientTransport, serverTransport]
    = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'consumer', version: '1.0.0' });
  await applicationServer.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map(tool => tool.name);
    const applicationResult = await client.callTool({
      arguments: {},
      name: 'application.health',
    });
    const targetsResult = await client.callTool({
      arguments: {},
      name: 'browser.list_targets',
    });
    expect(toolNames).toContain('application.health');
    expect(toolNames).toContain('browser.list_targets');
    expect(toolNames).not.toContain('browser.raw_cdp');
    expect(applicationResult.content).toEqual([
      { text: 'healthy', type: 'text' },
    ]);
    expect(targetsResult.content).toEqual([
      {
        text: JSON.stringify([{
          availability: 'available',
          capabilities: { level: 'observe' },
          targetRef: 't1',
          type: 'page',
        }]),
        type: 'text',
      },
    ]);
    expect(targetsResult.isError).toBeUndefined();
  } finally {
    await client.close();
    await applicationServer.close();
  }
});

it('rejects a conflicting CDB registration before adding any CDB tools', () => {
  expect.assertions(2);
  const applicationServer = new McpServer({
    name: 'application',
    version: '1.0.0',
  });
  applicationServer.registerTool(
    'browser.navigate',
    { description: 'Application navigation.', inputSchema: z.object({}) },
    async () => ({ content: [] }),
  );
  const bridgeClient = {
    async listTargets() {
      return [target];
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  expect(() =>
    registerCdbTools(applicationServer, { client: bridgeClient }),
  ).toThrow('browser.navigate is already registered');
  expect(
    Object.keys(
      (
        applicationServer as unknown as {
          readonly _registeredTools: Record<string, unknown>;
        }
      )._registeredTools,
    ),
  ).toEqual(['browser.navigate']);
});

it('preserves a successful navigation when its temporary lease was fenced during navigation', async () => {
  expect.assertions(4);
  const renewedTarget = { ...target, generation: 2 };
  let listCount = 0;
  const releaseLease = vi.fn(async () => {
    throw Object.assign(new Error('The target generation is stale.'), {
      code: 'TARGET_GENERATION_STALE',
    });
  });
  const commandResult = {
    operationId: '30000000-0000-4000-8000-000000000001',
    value: { frameId: 'frame-1' },
  };
  const bridgeClient = {
    async acquireLease() {
      return {
        expiresAt: '2030-01-01T00:00:00.000Z',
        id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        issuedAt: '2026-08-26T00:00:00.000Z',
        methods: ['Page.navigate'],
        mode: 'exclusive-control' as const,
        targetGeneration: target.generation,
        targetId: target.id,
      };
    },
    async cancelCommand() {},
    async executeCommand() {
      return commandResult;
    },
    async listTargets() {
      listCount += 1;
      return listCount === 1 ? [target] : [renewedTarget];
    },
    releaseLease,
    async subscribe(request: { readonly match: { readonly method: string } }) {
      return {
        close() {},
        droppedCount: 0,
        id: crypto.randomUUID(),
        lastDeliveredSequence: 0,
        overflowed: false,
        targetGeneration: target.generation,
        targetId: target.id,
        async* [Symbol.asyncIterator]() {
          if (request.match.method === 'Page.loadEventFired') {
            yield {
              method: request.match.method,
              parameters: { timestamp: 1 },
              sequence: 1,
              subscriptionId: crypto.randomUUID(),
              targetGeneration: target.generation,
              targetId: target.id,
            };
          } else {
            await new Promise(() => {});
          }
        },
      };
    },
    watchTargets() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => new Promise<IteratorResult<never>>(() => {}),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      };
    },
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client: bridgeClient });
  const targetRef = session.projectTarget(target)?.targetRef;
  const navigate = session.definitions.find(
    definition => definition.name === 'browser.navigate',
  );
  if (navigate === undefined || targetRef === undefined)
    throw new Error('browser.navigate was not registered');

  const result = await navigate.invoke({
    targetRef,
    url: 'https://staging-app.contentsquare.com/#/benchmark/dashboard?project=1814',
  });

  expect(releaseLease).toHaveBeenCalledTimes(2);
  expect(result.isError).toBeUndefined();
  expect(result.content[0]).toMatchObject({ type: 'text' });
  expect(JSON.parse((result.content[0] as { readonly text: string }).text)).toMatchObject({
    target: { targetRef: 't1' },
  });
});

it('reads a DOM snapshot artifact without starving the root budget for child sessions', async () => {
  expect.assertions(8);
  const lease = {
    expiresAt: '2030-01-01T00:00:00.000Z',
    id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
    issuedAt: '2026-08-26T00:00:00.000Z',
    methods: ['DOMSnapshot.captureSnapshot'],
    mode: 'shared-read' as const,
    targetGeneration: target.generation,
    targetId: target.id,
  };
  const domSnapshot = {
    documents: [
      {
        documentURL: 9,
        nodes: {
          attributes: [[], [], [], [6, 7], [], [], []],
          backendNodeId: [1, 2, 3, 4, 5, 6, 7],
          nodeName: [0, 1, 2, 3, 4, 10, 4],
          nodeValue: [5, 5, 5, 5, 8, 5, 11],
          parentIndex: [-1, 0, 1, 2, 3, 2, 5],
        },
      },
    ],
    strings: [
      '#document',
      'HTML',
      'BODY',
      'BUTTON',
      '#text',
      '',
      'id',
      'save',
      'Save',
      'https://example.test/',
      'SCRIPT',
      "localStorage.setItem('auth-token', 'secret')",
    ],
  };
  const snapshotBytes = Buffer.from(JSON.stringify(domSnapshot));
  const artifact = {
    expiresAt: '2030-01-01T00:00:00.000Z',
    id: '117c10a7-e0af-40ec-879f-cd87dffaf036',
    length: snapshotBytes.byteLength,
    mediaType: 'application/json',
  };
  const acquireLease = vi.fn(async () => lease);
  const readArtifact = vi.fn(
    async (request: {
      readonly range?: { readonly length: number; readonly offset: number };
    }) => {
      if (request.range === undefined)
        throw new Error('Expected a ranged artifact read.');
      return snapshotBytes.subarray(
        request.range.offset,
        request.range.offset + request.range.length,
      );
    },
  );
  const releaseArtifact = vi.fn(async () => {});
  const releaseLease = vi.fn(async () => {});
  const bridgeClient = {
    acquireLease,
    async executeCommand(command: { readonly method: string }) {
      if (command.method === 'Bridge.listChildSessions')
        return {
          value: {
            sessions: Array.from({ length: 16 }, (_value, index) => ({
              generation: 1,
              id: `iframe-${index}`,
              type: 'iframe',
            })),
          },
        };
      return {
        operationId: '30000000-0000-4000-8000-000000000002',
        value: { artifact },
      };
    },
    readArtifact,
    async listTargets() {
      return [target];
    },
    releaseArtifact,
    releaseLease,
  } as unknown as McpChromeDebuggerBridgeClient;
  const session = createCdbToolSession({ client: bridgeClient });
  const targetRef = session.projectTarget(target)?.targetRef;
  const snapshot = session.definitions.find(
    definition => definition.name === 'browser.snapshot',
  );
  if (snapshot === undefined || targetRef === undefined)
    throw new Error('browser.snapshot was not registered');

  const result = await snapshot.invoke({
    maximumNodes: 6,
    mode: 'dom',
    targetRef,
  });

  expect(acquireLease).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: 'shared-read',
      requestedMethods: ['DOMSnapshot.captureSnapshot'],
    }),
  );
  expect(readArtifact).toHaveBeenCalledOnce();
  expect(releaseArtifact).toHaveBeenCalledWith({
    artifactId: artifact.id,
    leaseId: lease.id,
    targetGeneration: target.generation,
    targetId: target.id,
  });
  expect(releaseLease).toHaveBeenCalledTimes(2);
  expect(result.isError).toBeUndefined();
  const resultContent = result.content[0];
  expect(resultContent?.type).toBe('text');
  if (resultContent?.type !== 'text')
    throw new Error('Expected a text DOM snapshot result.');
  expect(resultContent.text).toContain(
    '- <button id="save"> [backendNodeId=4]\n        - "Save"',
  );
  expect(resultContent.text).not.toContain('auth-token');
});

it('serves target discovery through the official SDK Streamable HTTP client', async () => {
  expect.assertions(42);
  const server = createServer();
  const acquiredLeases: unknown[] = [];
  const cancelledCommands: unknown[] = [];
  const executedMethods: string[] = [];
  const releasedArtifacts: unknown[] = [];
  const releasedLeases: unknown[] = [];
  const subscriptionRequests: unknown[] = [];
  const artifactReads: unknown[] = [];
  const artifactDescriptor = {
    expiresAt: '2030-01-01T00:00:00.000Z',
    id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
    length: 100_000,
    mediaType: 'image/png',
  };
  let closedSubscriptions = 0;
  let rejectPendingInspection: ((reason?: unknown) => void) | undefined;
  let resolvePendingEvent:
    ((result: IteratorResult<never>) => void) | undefined;
  let resolveInspectionStarted: (() => void) | undefined;
  let resolveArtifactReadStarted: (() => void) | undefined;
  let resolveSubscriptionStarted: (() => void) | undefined;
  let navigationCompleted = false;
  const inspectionStarted = new Promise<void>((resolve) => {
    resolveInspectionStarted = resolve;
  });
  const artifactReadStarted = new Promise<void>((resolve) => {
    resolveArtifactReadStarted = resolve;
  });
  let subscriptionStarted = new Promise<void>((resolve) => {
    resolveSubscriptionStarted = resolve;
  });
  const bridgeClient = {
    async cancelCommand(request: unknown) {
      cancelledCommands.push(request);
      rejectPendingInspection?.(
        Object.assign(new Error('Cancelled.'), { code: 'MCP_WAIT_CANCELLED' }),
      );
    },
    async acquireLease(request: unknown) {
      acquiredLeases.push(request);
      return {
        expiresAt: '2030-01-01T00:00:00.000Z',
        id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        mode: 'shared-read' as const,
        targetGeneration: target.generation,
        targetId: target.id,
      };
    },
    async executeCommand(command: {
      readonly method: string;
      readonly parameters?: { readonly expression?: unknown };
    }) {
      if (
        command.method === 'Runtime.evaluate'
        && command.parameters?.expression === 'await-cancellation'
      ) {
        resolveInspectionStarted?.();
        return new Promise<never>((_resolve, reject) => {
          rejectPendingInspection = reject;
        });
      }
      if (
        command.method === 'Runtime.evaluate'
        && command.parameters?.expression === 'cdp-failure'
      )
        throw Object.assign(new Error('Denied.'), {
          code: 'CAPABILITY_DENIED',
        });
      if (command.method === 'Runtime.evaluate')
        return {
          operationId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          value: { result: { type: 'string', value: 'document.title' } },
        };
      executedMethods.push(command.method);
      if (command.method === 'Bridge.listChildSessions')
        return { value: { sessions: [] } };
      if (command.method === 'Network.getResponseBody')
        return {
          operationId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          value: { artifact: artifactDescriptor },
        };
      if (command.method === 'Page.navigate') navigationCompleted = true;
      return {
        operationId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        value: { result: { type: 'string', value: command.method } },
      };
    },
    async listTargets() {
      return [navigationCompleted ? { ...target, generation: 2 } : target];
    },
    async readArtifact(request: unknown, signal?: AbortSignal) {
      artifactReads.push({ request, signalAborted: signal?.aborted });
      if (
        typeof request === 'object'
        && request !== null
        && 'range' in request
        && request.range !== null
        && typeof request.range === 'object'
        && 'offset' in request.range
        && request.range.offset === 8
      )
        return new Uint8Array([1, 2]);
      if (
        typeof request === 'object'
        && request !== null
        && 'range' in request
        && request.range !== null
        && typeof request.range === 'object'
        && 'offset' in request.range
        && request.range.offset === 9
      ) {
        resolveArtifactReadStarted?.();
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('The artifact read was cancelled.')),
            { once: true },
          );
        });
      }
      return new Uint8Array([1, 2]);
    },
    async releaseLease(request: unknown) {
      releasedLeases.push(request);
    },
    async releaseArtifact(request: unknown) {
      releasedArtifacts.push(request);
    },
    async subscribe(request: {
      readonly leaseId: string;
      readonly match: { readonly method: string };
    }) {
      subscriptionRequests.push(request);
      if (request.match.method.startsWith('Page.')) {
        let resolvePendingPageEvent: ((result: IteratorResult<never>) => void) | undefined;
        return {
          close() {
            closedSubscriptions += 1;
            resolvePendingPageEvent?.({ done: true, value: undefined });
          },
          droppedCount: 0,
          id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
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
                      subscriptionId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
                      targetGeneration: target.generation,
                      targetId: target.id,
                    },
                  }
                : new Promise<IteratorResult<never>>((resolve) => {
                    resolvePendingPageEvent = resolve;
                  }),
            };
          },
        };
      }
      if (request.match.method === 'Network.loadingFinished') {
        return {
          close() {
            closedSubscriptions += 1;
            resolvePendingEvent?.({ done: true, value: undefined });
          },
          droppedCount: 0,
          id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          lastDeliveredSequence: 0,
          overflowed: false,
          targetGeneration: target.generation,
          targetId: target.id,
          [Symbol.asyncIterator]() {
            resolveSubscriptionStarted?.();
            return {
              next: async () =>
                new Promise<IteratorResult<never>>((resolve) => {
                  resolvePendingEvent = resolve;
                }),
            };
          },
        };
      }
      return {
        close() {
          closedSubscriptions += 1;
        },
        droppedCount: 0,
        id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        lastDeliveredSequence: 1,
        overflowed: false,
        targetGeneration: target.generation,
        targetId: target.id,
        async* [Symbol.asyncIterator]() {
          yield {
            method: 'Runtime.consoleAPICalled',
            parameters: { type: 'log' },
            sequence: 1,
            subscriptionId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
            targetGeneration: target.generation,
            targetId: target.id,
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
  const mounted = mountMcpStreamableHttp({ client: bridgeClient, server });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected a TCP address.');
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/cdb/mcp`),
  );
  const client = new Client(
    { name: 'mcp-test-client', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual([
      'browser.list_targets',
      'browser.find',
      'browser.acquire',
      'browser.renew',
      'browser.release',
      'browser.release_artifact',
      'browser.read_artifact',
      'browser.inspect',
      'browser.snapshot',
      'browser.screenshot',
      'browser.network_body',
      'browser.evaluate',
      'browser.navigate',
      'browser.back',
      'browser.forward',
      'browser.reload',
      'browser.click',
      'browser.click_at',
      'browser.move_at',
      'browser.scroll_at',
      'browser.drag_at',
      'browser.drag',
      'browser.hover',
      'browser.focus',
      'browser.fill',
      'browser.type',
      'browser.press',
      'browser.scroll_into_view',
      'browser.check',
      'browser.uncheck',
      'browser.select_option',
      'browser.wait_for_navigation',
      'browser.wait_for_dialog',
      'browser.handle_dialog',
      'browser.console',
      'browser.network',
      'browser.wait_for',
    ]);
    expect(
      tools.tools.find(tool => tool.name === 'browser.acquire')?.description,
    ).toContain('"Runtime.evaluate"');
    const result = await client.callTool({
      arguments: {},
      name: 'browser.list_targets',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      {
        text: JSON.stringify([{
          availability: 'available',
          capabilities: { level: 'observe' },
          targetRef: 't1',
          type: 'page',
        }]),
        type: 'text',
      },
    ]);
    const targetRef = 't1';
    const snapshot = await client.callTool({
      arguments: { mode: 'dom', targetRef },
      name: 'browser.snapshot',
    });
    expect(snapshot.isError).toBeUndefined();
    const screenshot = await client.callTool({
      arguments: { targetRef },
      name: 'browser.screenshot',
    });
    expect(screenshot.isError).toBeUndefined();
    expect(screenshot.content).toEqual([
      {
        text: JSON.stringify({
          result: { type: 'string', value: 'Page.captureScreenshot' },
        }),
        type: 'text',
      },
    ]);
    const networkBody = await client.callTool({
      arguments: {
        requestId: 'request-1',
        targetRef,
      },
      name: 'browser.network_body',
    });
    expect(networkBody.isError).toBeUndefined();
    const networkBodyContent = networkBody.content[0];
    if (networkBodyContent?.type !== 'text')
      throw new Error('Expected a text network body result.');
    expect(JSON.parse(networkBodyContent.text)).toEqual({
      artifact: artifactDescriptor,
      lease: {
        expiresAt: '2030-01-01T00:00:00.000Z',
        id: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        mode: 'shared-read',
        targetGeneration: target.generation,
        targetId: target.id,
      },
    });
    const releasedArtifact = await client.callTool({
      arguments: {
        artifactId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        targetGeneration: target.generation,
        targetId: target.id,
      },
      name: 'browser.release_artifact',
    });
    expect(releasedArtifact.isError).toBeUndefined();
    expect(releasedArtifacts).toEqual([
      {
        artifactId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        targetGeneration: target.generation,
        targetId: target.id,
      },
    ]);
    const releasedArtifactLease = await client.callTool({
      arguments: {
        leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        targetGeneration: target.generation,
        targetId: target.id,
      },
      name: 'browser.release',
    });
    expect(releasedArtifactLease.isError).toBeUndefined();
    const artifactRead = await client.callTool({
      arguments: {
        artifactId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        maximumBytes: 2,
        offset: 4,
        targetGeneration: target.generation,
        targetId: target.id,
      },
      name: 'browser.read_artifact',
    });
    expect(artifactRead.isError).toBeUndefined();
    expect(artifactRead.content).toEqual([
      {
        text: JSON.stringify({ bytes: 'AQI=', encoding: 'base64', offset: 4 }),
        type: 'text',
      },
    ]);
    expect(artifactReads).toEqual([
      {
        request: {
          artifactId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          range: { length: 2, offset: 4 },
          targetGeneration: target.generation,
          targetId: target.id,
        },
        signalAborted: false,
      },
    ]);
    const oversizedArtifactRead = await client.callTool({
      arguments: {
        artifactId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        maximumBytes: 1,
        offset: 8,
        targetGeneration: target.generation,
        targetId: target.id,
      },
      name: 'browser.read_artifact',
    });
    expect(oversizedArtifactRead.isError).toBe(true);
    expect(oversizedArtifactRead.content).toEqual([
      {
        text: JSON.stringify({
          code: 'MCP_ARTIFACT_RANGE_INVALID',
          message: 'The artifact range exceeded the requested limit.',
          retryable: false,
        }),
        type: 'text',
      },
    ]);
    const artifactCancellationController = new AbortController();
    const cancelledArtifactRead = client.callTool(
      {
        arguments: {
          artifactId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          maximumBytes: 1,
          offset: 9,
          targetGeneration: target.generation,
          targetId: target.id,
        },
        name: 'browser.read_artifact',
      },
      { signal: artifactCancellationController.signal },
    );
    await artifactReadStarted;
    artifactCancellationController.abort();
    await expect(cancelledArtifactRead).rejects.toThrow();
    const navigation = await client.callTool({
      arguments: {
        targetRef,
        url: 'https://example.test/',
      },
      name: 'browser.navigate',
    });
    expect(navigation.isError).toBeUndefined();
    const click = await client.callTool({
      arguments: {
        targetRef,
        x: 10,
        y: 20,
      },
      name: 'browser.click_at',
    });
    expect(click.isError).toBeUndefined();
    const consoleEvent = await client.callTool({
      arguments: {
        targetRef,
        timeoutMilliseconds: 100,
      },
      name: 'browser.console',
    });
    expect(consoleEvent.isError).toBeUndefined();
    const debugEvent = await client.callTool({
      arguments: {
        leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
        method: 'Debugger.paused',
        targetRef,
        timeoutMilliseconds: 100,
      },
      name: 'browser.wait_for',
    });
    expect(debugEvent.isError).toBeUndefined();
    expect(subscriptionRequests.at(-1)).toMatchObject({
      leaseId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
      match: { method: 'Debugger.paused' },
    });
    const evaluation = await client.callTool({
      arguments: {
        expression: 'document.title',
        targetRef,
      },
      name: 'browser.evaluate',
    });
    expect(evaluation.isError).toBeUndefined();
    expect(evaluation.content).toEqual([
      {
        text: JSON.stringify({
          operationId: '017c10a7-e0af-40ec-879f-cd87dffaf036',
          value: { result: { type: 'string', value: 'document.title' } },
        }),
        type: 'text',
      },
    ]);
    const failedEvaluation = await client.callTool({
      arguments: {
        expression: 'cdp-failure',
        targetRef,
      },
      name: 'browser.evaluate',
    });
    expect(failedEvaluation.isError).toBe(true);
    expect(failedEvaluation.content).toEqual([
      {
        text: JSON.stringify({
          code: 'CAPABILITY_DENIED',
          message: 'Denied.',
          retryable: false,
        }),
        type: 'text',
      },
    ]);
    const evaluationCancellationController = new AbortController();
    const cancelledEvaluation = client.callTool(
      {
        arguments: {
          expression: 'await-cancellation',
          targetRef,
        },
        name: 'browser.evaluate',
      },
      { signal: evaluationCancellationController.signal },
    );
    await inspectionStarted;
    evaluationCancellationController.abort();
    await expect(cancelledEvaluation).rejects.toThrow();
    await expect
      .poll(() => cancelledCommands)
      .toMatchObject([
        { targetGeneration: 2, targetId: target.id },
      ]);
    expect(acquiredLeases).toMatchObject([
      {
        mode: 'shared-read',
        requestedMethods: ['Bridge.listChildSessions'],
      },
      {
        mode: 'shared-read',
        requestedMethods: ['DOMSnapshot.captureSnapshot'],
      },
      { mode: 'shared-read', requestedMethods: ['Page.captureScreenshot'] },
      { mode: 'shared-read', requestedMethods: ['Network.getResponseBody'] },
      {
        mode: 'exclusive-control',
        requestedMethods: [
          'Page.navigate',
          'Page.loadEventFired',
          'Page.navigatedWithinDocument',
          'Page.javascriptDialogOpening',
        ],
      },
      {
        mode: 'exclusive-control',
        requestedMethods: ['Input.dispatchMouseEvent'],
      },
      { mode: 'shared-read', requestedMethods: ['Runtime.consoleAPICalled'] },
      { mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'] },
      { mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'] },
      { mode: 'exclusive-control', requestedMethods: ['Runtime.evaluate'] },
    ]);
    expect(executedMethods).toEqual([
      'Bridge.listChildSessions',
      'DOMSnapshot.captureSnapshot',
      'Page.captureScreenshot',
      'Network.getResponseBody',
      'Page.navigate',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    expect(releasedLeases).toHaveLength(10);
    expect(closedSubscriptions).toBe(4);
    const timedOutWait = await client.callTool({
      arguments: {
        method: 'Network.loadingFinished',
        targetRef,
        timeoutMilliseconds: 10,
      },
      name: 'browser.wait_for',
    });
    await subscriptionStarted;
    expect(timedOutWait.isError).toBe(true);
    expect(timedOutWait.content).toEqual([
      {
        text: JSON.stringify({
          code: 'MCP_WAIT_TIMEOUT',
          message: 'MCP wait timed out.',
          retryable: false,
        }),
        type: 'text',
      },
    ]);
    expect(closedSubscriptions).toBe(5);
    expect(releasedLeases).toHaveLength(11);
    subscriptionStarted = new Promise<void>((resolve) => {
      resolveSubscriptionStarted = resolve;
    });
    const cancellationController = new AbortController();
    const cancelledWait = client.callTool(
      {
        arguments: {
          method: 'Network.loadingFinished',
          targetRef,
          timeoutMilliseconds: 5_000,
        },
        name: 'browser.wait_for',
      },
      { signal: cancellationController.signal },
    );
    await subscriptionStarted;
    cancellationController.abort();
    await expect(cancelledWait).rejects.toThrow();
    await expect.poll(() => closedSubscriptions).toBe(6);
    expect(releasedLeases).toHaveLength(12);
    expect(supportedMcpSdkVersion).toBe('2.0.0');
    expect(supportedMcpProtocolVersions).toEqual(['2026-07-28']);
  } finally {
    await transport.terminateSession();
    await mounted.close();
    await new Promise<void>((resolve, reject) =>
      server.close(error =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
});

it('registers raw CDP only when a trusted host explicitly enables it', async () => {
  expect.assertions(1);
  const server = createServer();
  const mounted = mountMcpStreamableHttp({
    client: {} as McpChromeDebuggerBridgeClient,
    enableRawCdp: true,
    path: '/bridge-mcp',
    server,
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected a TCP address.');
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/bridge-mcp`),
  );
  const client = new Client(
    { name: 'mcp-test-client', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );

  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain(
      'browser.raw_cdp',
    );
  } finally {
    await transport.terminateSession();
    await mounted.close();
    await new Promise<void>((resolve, reject) =>
      server.close(error =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
});

it('owns an injected stdio transport independently from the HTTP adapter', async () => {
  expect.assertions(2);
  let closed = false;
  let started = false;
  const transport = {
    async close() {
      closed = true;
    },
    async send() {},
    async start() {
      started = true;
    },
  };
  const mounted = mountMcpStdio({
    client: {} as McpChromeDebuggerBridgeClient,
    stdio: { transport },
  });
  await expect.poll(() => started).toBe(true);
  await mounted.close();
  expect(closed).toBe(true);
});
