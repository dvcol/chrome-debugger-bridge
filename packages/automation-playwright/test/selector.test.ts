import type { AutomationProviderExecutionContext } from '@dvcol/cdb';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlaywrightAutomationProvider, selectorForLocator } from '../src/index.js';

interface RelayTestTransport {
  onmessage?: (message: unknown) => void;
  send: (message: unknown) => void;
}

const { createPlaywrightMock } = vi.hoisted(() => ({
  createPlaywrightMock: vi.fn(),
}));

vi.mock('playwright-core/lib/coreBundle', async (importOriginal) => {
  const original = await importOriginal<typeof import('playwright-core/lib/coreBundle')>();
  return {
    ...original,
    server: {
      ...original.server,
      createPlaywright: createPlaywrightMock,
    },
  };
});

afterEach(() => {
  createPlaywrightMock.mockReset();
});

describe('playwright locator projection', () => {
  it('projects every portable strategy into Playwright selectors', () => {
    expect.assertions(10);

    expect(selectorForLocator({ name: { exact: true, pattern: 'Save' }, role: 'button' }))
      .toBe('internal:role=button[name="Save"s]');
    expect(selectorForLocator({ text: { pattern: 'Hello' } })).toBe('internal:text="Hello"i');
    expect(selectorForLocator({ label: { pattern: 'Email' } })).toBe('internal:label="Email"i');
    expect(selectorForLocator({ placeholder: { pattern: 'Search' } }))
      .toBe('internal:attr=[placeholder="Search"i]');
    expect(selectorForLocator({ altText: { pattern: 'Hero' } })).toBe('internal:attr=[alt="Hero"i]');
    expect(selectorForLocator({ title: { pattern: 'Details' } })).toBe('internal:attr=[title="Details"i]');
    expect(selectorForLocator({ testId: { pattern: 'save' } }))
      .toBe('internal:testid=[data-testid="save"s]');
    expect(selectorForLocator({ testId: { pattern: 'save' } }, 'data-qa'))
      .toBe('internal:testid=[data-qa="save"s]');
    expect(selectorForLocator({ css: 'app-shell button' })).toBe('app-shell button');
    expect(selectorForLocator({ xpath: '//button[normalize-space(.)="Save"]' }))
      .toBe('//button[normalize-space(.)="Save"]');
  });

  it('projects frames, scoping, filters, regular expressions, and visibility', () => {
    expect.assertions(3);

    expect(selectorForLocator({
      descendants: [{ role: 'button' }],
      frameChain: [{ css: 'iframe.analytics' }],
      has: { text: { pattern: 'Save' } },
      hasNotText: { pattern: 'Disabled' },
      nth: 1,
      role: 'group',
      visible: true,
    })).toBe(
      'iframe.analytics >> internal:control=enter-frame >> internal:role=group >> internal:role=button'
      + ' >> internal:has="internal:text=\\"Save\\"i" >> internal:has-not-text="Disabled"i >> nth=1 >> visible=true',
    );
    expect(selectorForLocator({ name: { regex: { flags: 'i', source: '^save$' } }, role: 'button' }))
      .toBe('internal:role=button[name=/^save$/i]');
    expect(() => selectorForLocator({ text: { regex: { flags: 'z', source: 'save' } } }))
      .toThrow('outside the supported bounds');
  });

  it('publishes the synthetic page in a Playwright browser context', async () => {
    expect.assertions(8);

    const frame = {
      ariaSnapshot: vi.fn(async () => ({ snapshot: '- button "Save" [ref=e1]' })),
    };
    const browser = {
      _defaultContext: { pages: () => [{ mainFrame: () => frame }] },
      close: vi.fn(async () => {}),
      contexts: vi.fn(() => []),
    };
    let browserContextId: unknown;
    let rootTargetBrowserContextId: unknown;
    createPlaywrightMock.mockReturnValue({
      chromium: {
        async connectOverCDP(
          _progress: unknown,
          { transport }: { transport: RelayTestTransport },
        ) {
          const attached = Promise.withResolvers<void>();
          const rootTargetInfoReturned = Promise.withResolvers<void>();
          const forwardedResponses: PromiseWithResolvers<void>[] = [];
          for (let index = 0; index < 40; index++)
            forwardedResponses.push(Promise.withResolvers<void>());
          transport.onmessage = (message) => {
            if (
              typeof message === 'object'
              && message !== null
              && 'method' in message
              && message.method === 'Target.attachedToTarget'
            ) {
              const parameters = 'params' in message ? message.params : undefined;
              const targetInfo = typeof parameters === 'object'
                && parameters !== null
                && 'targetInfo' in parameters
                ? parameters.targetInfo
                : undefined;
              browserContextId = typeof targetInfo === 'object'
                && targetInfo !== null
                && 'browserContextId' in targetInfo
                ? targetInfo.browserContextId
                : undefined;
              attached.resolve();
            }
            if (
              typeof message === 'object'
              && message !== null
              && 'id' in message
              && message.id === 2
            ) {
              const result = 'result' in message ? message.result : undefined;
              const targetInfo = typeof result === 'object'
                && result !== null
                && 'targetInfo' in result
                ? result.targetInfo
                : undefined;
              rootTargetBrowserContextId = typeof targetInfo === 'object'
                && targetInfo !== null
                && 'browserContextId' in targetInfo
                ? targetInfo.browserContextId
                : undefined;
              rootTargetInfoReturned.resolve();
            }
            if (
              typeof message === 'object'
              && message !== null
              && 'id' in message
              && typeof message.id === 'number'
              && message.id >= 100
            )
              forwardedResponses[message.id - 100]?.resolve();
          };
          transport.send({ id: 1, method: 'Target.setAutoAttach', params: {} });
          await attached.promise;
          transport.send({ id: 2, method: 'Target.getTargetInfo', params: {} });
          await rootTargetInfoReturned.promise;
          for (let index = 0; index < forwardedResponses.length; index++) {
            transport.send({
              id: 100 + index,
              method: 'Runtime.evaluate',
              params: { expression: String(index) },
            });
          }
          await Promise.all(forwardedResponses.map(async response => response.promise));
          return browser;
        },
      },
    });

    const abortController = new AbortController();
    let concurrentExecuteCdpCalls = 0;
    let maximumConcurrentExecuteCdpCalls = 0;
    const executeCdp = vi.fn(async () => {
      concurrentExecuteCdpCalls += 1;
      maximumConcurrentExecuteCdpCalls = Math.max(
        maximumConcurrentExecuteCdpCalls,
        concurrentExecuteCdpCalls,
      );
      await new Promise(resolve => setTimeout(resolve, 1));
      concurrentExecuteCdpCalls -= 1;
      return {};
    });
    const context = {
      abortSignal: abortController.signal,
      authorityBindingId: 'binding-id',
      connectionId: 'connection-id',
      executeCdp,
      leaseId: 'lease-id',
      onCdpEvent: vi.fn(() => () => {}),
      principalId: 'principal-id',
      setDomainDemand: vi.fn(async () => {}),
      target: {
        availability: 'available',
        capabilities: { level: 'unsafe' },
        generation: 1,
        id: 'target-id',
        scopeId: 'scope-id',
        type: 'page',
        url: 'https://example.test',
      },
    } satisfies AutomationProviderExecutionContext;
    const provider = createPlaywrightAutomationProvider();

    const result = await provider.execute({
      operation: {
        kind: 'snapshot',
        maximumDepth: 5,
        maximumNodes: 50,
        mode: 'interactive',
      },
      operationId: 'operation-id',
    }, context);

    expect(browserContextId).toBe('cdb-default-context');
    expect(rootTargetBrowserContextId).toBe('cdb-default-context');
    expect(executeCdp).not.toHaveBeenCalledWith('Target.getTargetInfo', expect.anything(), expect.anything());
    expect(executeCdp).toHaveBeenCalledTimes(40);
    expect(maximumConcurrentExecuteCdpCalls).toBe(1);
    expect(frame.ariaSnapshot).toHaveBeenCalledOnce();
    expect(result.elements).toEqual([
      expect.objectContaining({ metadata: { providerReference: 'e1' } }),
    ]);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('isolates concurrent operation transports and releases their domain demands', async () => {
    expect.assertions(8);
    const browsers = [0, 1].map(index => ({
      _defaultContext: {
        pages: () => [{ mainFrame: () => ({ ariaSnapshot: vi.fn(async () => ({ snapshot: `operation-${index}` })) }) }],
      },
      close: vi.fn(async () => {}),
      contexts: vi.fn(() => []),
    }));
    let connectionIndex = 0;
    createPlaywrightMock.mockImplementation(() => {
      const index = connectionIndex++;
      return {
        chromium: {
          async connectOverCDP(_progress: unknown, { transport }: { transport: RelayTestTransport }) {
            const response = Promise.withResolvers<void>();
            transport.onmessage = (message) => {
              if (typeof message === 'object' && message !== null && 'id' in message && message.id === 1)
                response.resolve();
            };
            transport.send({ id: 1, method: 'Runtime.enable', params: {} });
            await response.promise;
            const browser = browsers[index];
            if (browser === undefined) throw new Error('Unexpected Playwright connection.');
            return browser;
          },
        },
      };
    });
    const contexts = ['first', 'second'].map(label => ({
      abortSignal: new AbortController().signal,
      authorityBindingId: `binding-${label}`,
      connectionId: `connection-${label}`,
      executeCdp: vi.fn(async () => ({ label })),
      leaseId: `lease-${label}`,
      onCdpEvent: vi.fn(() => () => {}),
      principalId: 'shared-principal',
      setDomainDemand: vi.fn(async () => {}),
      target: {
        availability: 'available' as const,
        capabilities: { level: 'unsafe' as const },
        generation: 1,
        id: 'shared-target',
        scopeId: 'scope-id',
        type: 'page' as const,
      },
    } satisfies AutomationProviderExecutionContext));
    const provider = createPlaywrightAutomationProvider();
    const operation = { kind: 'snapshot' as const, maximumDepth: 2, maximumNodes: 10, mode: 'interactive' as const };

    const results = await Promise.all(contexts.map(async (context, index) =>
      provider.execute({ operation, operationId: `operation-${index}` }, context)));
    const [firstContext, secondContext] = contexts;
    if (firstContext === undefined || secondContext === undefined)
      throw new Error('Expected two isolated execution contexts.');

    expect(results.map(result => result.value)).toStrictEqual([
      { snapshot: 'operation-0' },
      { snapshot: 'operation-1' },
    ]);
    expect(firstContext.executeCdp).toHaveBeenCalledWith('Runtime.enable', {}, undefined);
    expect(secondContext.executeCdp).toHaveBeenCalledWith('Runtime.enable', {}, undefined);
    expect(firstContext.setDomainDemand).toHaveBeenCalledWith('Runtime', false, undefined);
    expect(secondContext.setDomainDemand).toHaveBeenCalledWith('Runtime', false, undefined);
    expect(browsers[0]?.close).toHaveBeenCalledOnce();
    expect(browsers[1]?.close).toHaveBeenCalledOnce();
    expect(createPlaywrightMock).toHaveBeenCalledTimes(2);
  });

  it('treats a zero action timeout as immediate expiration', async () => {
    expect.assertions(1);
    createPlaywrightMock.mockReturnValue({
      chromium: {
        async connectOverCDP(progress: { race: <Value>(value: Promise<Value>) => Promise<Value> }) {
          return progress.race(new Promise(() => {}));
        },
      },
    });
    const provider = createPlaywrightAutomationProvider({ timing: { actionTimeoutMilliseconds: 0 } });
    const context = {
      abortSignal: new AbortController().signal,
      authorityBindingId: 'binding-id',
      connectionId: 'connection-id',
      executeCdp: vi.fn(async () => ({})),
      leaseId: 'lease-id',
      onCdpEvent: vi.fn(() => () => {}),
      principalId: 'principal-id',
      setDomainDemand: vi.fn(async () => {}),
      target: {
        availability: 'available',
        capabilities: { level: 'unsafe' },
        generation: 1,
        id: 'target-id',
        scopeId: 'scope-id',
        type: 'page',
      },
    } satisfies AutomationProviderExecutionContext;

    await expect(provider.execute({
      operation: { kind: 'snapshot', maximumDepth: 1, maximumNodes: 1, mode: 'interactive' },
      operationId: 'operation-id',
    }, context)).rejects.toMatchObject({ code: 'AUTOMATION_PROVIDER_FAILED' });
  });

  it('allows action expiration to be disabled explicitly', async () => {
    expect.assertions(2);
    const browser = {
      _defaultContext: {
        pages: () => [{ mainFrame: () => ({ ariaSnapshot: vi.fn(async () => ({ snapshot: 'ready' })) }) }],
      },
      close: vi.fn(async () => {}),
      contexts: vi.fn(() => []),
    };
    createPlaywrightMock.mockReturnValue({
      chromium: { connectOverCDP: vi.fn(async () => browser) },
    });
    const provider = createPlaywrightAutomationProvider({ timing: { actionTimeoutMilliseconds: null } });
    const context = {
      abortSignal: new AbortController().signal,
      authorityBindingId: 'binding-id',
      connectionId: 'connection-id',
      executeCdp: vi.fn(async () => ({})),
      leaseId: 'lease-id',
      onCdpEvent: vi.fn(() => () => {}),
      principalId: 'principal-id',
      setDomainDemand: vi.fn(async () => {}),
      target: {
        availability: 'available',
        capabilities: { level: 'unsafe' },
        generation: 1,
        id: 'target-id',
        scopeId: 'scope-id',
        type: 'page',
      },
    } satisfies AutomationProviderExecutionContext;

    const result = await provider.execute({
      operation: { kind: 'snapshot', maximumDepth: 1, maximumNodes: 1, mode: 'interactive' },
      operationId: 'operation-id',
    }, context);

    expect(result.value).toStrictEqual({ snapshot: 'ready' });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid action timing at construction', () => {
    expect.assertions(1);

    expect(() => createPlaywrightAutomationProvider({ timing: { actionTimeoutMilliseconds: -1 } }))
      .toThrow('actionTimeoutMilliseconds');
  });
});
