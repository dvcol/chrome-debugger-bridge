import type {
  AutomationLocator,
  AutomationLocatorStrategy,
  AutomationProvider,
  AutomationProviderExecutionContext,
  AutomationProviderRequest,
  AutomationProviderResult,
  AutomationTextMatcher,
  JsonObject,
  TimeoutMilliseconds,
} from '@dvcol/cdb';
import type {
  InternalBrowser,
  InternalCdpMessage,
  InternalFrame,
  InternalProgress,
  InternalTransport,
} from 'playwright-core/lib/coreBundle';

import { randomUUID } from 'node:crypto';

import { AutomationProviderError, validateTimeoutMilliseconds } from '@dvcol/cdb';
import { iso, server } from 'playwright-core/lib/coreBundle';
import playwrightPackageManifest from 'playwright-core/package.json' with { type: 'json' };

const locatorRegularExpressionFlagsPattern = /^[dgimsuvy]*$/u;
const playwrightReferencePattern = /\b(?:f\d+)?e\d+\b/gu;

export interface PlaywrightAutomationProviderOptions {
  readonly testIdAttributeName?: string;
  readonly timing?: Partial<PlaywrightAutomationTimingPolicy>;
}

export interface PlaywrightAutomationTimingPolicy {
  readonly actionTimeoutMilliseconds: TimeoutMilliseconds;
}

export const defaultPlaywrightAutomationTimingPolicy: Readonly<PlaywrightAutomationTimingPolicy> = Object.freeze({
  actionTimeoutMilliseconds: 10_000,
});

interface PlaywrightRuntime {
  readonly browser: InternalBrowser;
  readonly context: AutomationProviderExecutionContext;
  readonly frame: InternalFrame;
  readonly operationId: string;
  readonly transport: CdbPlaywrightTransport;
}

function objectValue(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function playwrightProviderError(
  error: unknown,
  action: boolean,
): AutomationProviderError {
  const message = error instanceof Error
    ? error.message
    : 'The Playwright automation provider failed.';
  const normalizedMessage = message.toLowerCase();
  const match = (
    code: ConstructorParameters<typeof AutomationProviderError>[0],
    patterns: readonly string[],
    retryable = true,
  ): AutomationProviderError | undefined => patterns.some(pattern =>
    normalizedMessage.includes(pattern),
  )
    ? new AutomationProviderError(code, message, undefined, retryable)
    : undefined;
  return match('AUTOMATION_LOCATOR_AMBIGUOUS', ['strict mode violation', 'resolved to '], false)
    ?? match('AUTOMATION_ELEMENT_COVERED', ['intercepts pointer events', 'subtree intercepts pointer events'])
    ?? match('AUTOMATION_ELEMENT_DISABLED', ['element is not enabled', 'element is disabled'])
    ?? match('AUTOMATION_ELEMENT_NOT_EDITABLE', ['element is not editable'])
    ?? match('AUTOMATION_ELEMENT_HIDDEN', ['element is not visible', 'element is hidden'])
    ?? match('AUTOMATION_ELEMENT_UNSTABLE', ['element is not stable'])
    ?? match('AUTOMATION_ELEMENT_DETACHED', ['element is not attached', 'element was detached'])
    ?? match('AUTOMATION_LOCATOR_NOT_FOUND', ['locator did not match', 'resolved to 0 elements'])
    ?? (action
      ? match(
          'AUTOMATION_ACTION_OUTCOME_UNKNOWN',
          ['execution context was destroyed', 'target closed', 'page closed'],
          false,
        )
      : undefined)
    ?? new AutomationProviderError(
      'AUTOMATION_PROVIDER_FAILED',
      message,
      undefined,
      normalizedMessage.includes('timeout'),
    );
}

function playwrightModifiers(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modifierNames: Readonly<Record<string, string>> = {
    alt: 'Alt',
    control: 'Control',
    meta: 'Meta',
    shift: 'Shift',
  };
  return value.map(modifier => modifierNames[String(modifier)])
    .filter((modifier): modifier is string => modifier !== undefined);
}

function createProgress(
  abortSignal: AbortSignal,
  timeoutMilliseconds: TimeoutMilliseconds,
): InternalProgress {
  const signal = timeoutMilliseconds === null
    ? abortSignal
    : AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMilliseconds)]);
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = (): void => {
      reject(signal.reason instanceof Error
        ? signal.reason
        : new Error('The Playwright automation operation was cancelled.'));
    };
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
  return {
    deadline: timeoutMilliseconds === null ? 0 : globalThis.performance.now() + timeoutMilliseconds,
    disableTimeout() {},
    log() {},
    metadata: {
      id: '',
      internal: true,
      log: [],
      method: 'automation.execute',
      params: {},
      startTime: Date.now(),
      type: 'automation',
    },
    async race<Value>(value: Promise<Value> | readonly Promise<Value>[]) {
      const promises = Array.isArray(value)
        ? value as readonly Promise<Value>[]
        : [value as Promise<Value>];
      const result = await Promise.race([
        ...promises,
        aborted,
      ]);
      return result;
    },
    setAllowConcurrentOrNestedRaces() {},
    signal,
    timeout: timeoutMilliseconds ?? 0,
    async wait(timeout: number) {
      await Promise.race([
        new Promise<void>(resolve => setTimeout(resolve, timeout)),
        aborted,
      ]);
    },
  };
}

class CdbPlaywrightTransport implements InternalTransport {
  onclose?: () => void;
  onmessage?: (message: InternalCdpMessage) => void;

  readonly #relaySessionId = `cdb-target-${randomUUID()}`;
  readonly #activeDomainDemands = new Map<string, { readonly domain: string; readonly sessionId?: string }>();
  #closed = false;
  #commandQueue = Promise.resolve();
  readonly #context: AutomationProviderExecutionContext;
  #failure: Error | undefined;
  #targetInfo: JsonObject | undefined;
  readonly #unsubscribe: () => void;

  constructor(context: AutomationProviderExecutionContext) {
    this.#context = context;
    this.#unsubscribe = context.onCdpEvent((event) => {
      if (this.#closed) return;
      void this.#deliver({
        method: event.method,
        params: event.parameters,
        sessionId: event.sessionId ?? this.#relaySessionId,
      }).catch(() => {});
    });
  }

  get failure(): Error | undefined {
    return this.#failure;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    try {
      this.onclose?.();
    } catch (error) {
      this.#failure ??= error instanceof Error
        ? error
        : new Error('The CDB Playwright relay failed while closing.');
    }
  }

  async dispose(): Promise<void> {
    const demands = [...this.#activeDomainDemands];
    this.#activeDomainDemands.clear();
    for (const [, demand] of demands)
      await this.#context.setDomainDemand(demand.domain, false, demand.sessionId).catch(() => {});
    this.close();
  }

  send(message: InternalCdpMessage): void {
    if (this.#closed) return;
    const operation = this.#commandQueue.then(async () => {
      if (this.#closed) return;
      let response: InternalCdpMessage;
      try {
        response = {
          ...(message.id === undefined ? {} : { id: message.id }),
          ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
          result: await this.#handle(message),
        };
      } catch (error) {
        response = {
          error: {
            message: error instanceof Error
              ? error.message
              : 'The CDB Playwright relay command failed.',
          },
          ...(message.id === undefined ? {} : { id: message.id }),
          ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
        };
      }
      await this.#deliver(response);
    });
    this.#commandQueue = operation.catch((error: unknown) => this.#fail(error));
  }

  async #deliver(message: InternalCdpMessage): Promise<void> {
    if (this.#closed) return;
    try {
      await (this.onmessage as ((value: InternalCdpMessage) => unknown) | undefined)?.(message);
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#failure = error instanceof Error
      ? error
      : new Error('The CDB Playwright relay failed while delivering a CDP message.');
    this.close();
  }

  async #attachTarget(): Promise<JsonObject> {
    if (this.#targetInfo !== undefined) return this.#targetInfo;
    this.#targetInfo = {
      attached: true,
      browserContextId: 'cdb-default-context',
      canAccessOpener: false,
      targetId: this.#context.target.id,
      title: this.#context.target.title ?? '',
      type: this.#context.target.type,
      url: this.#context.target.url ?? '',
    };
    await this.#deliver({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: this.#relaySessionId,
        targetInfo: this.#targetInfo,
        waitingForDebugger: false,
      },
    });
    return this.#targetInfo;
  }

  async #handle(message: InternalCdpMessage): Promise<JsonObject> {
    const method = message.method;
    if (method === undefined) return {};
    const parameters = objectValue(message.params);
    if (method === 'Browser.getVersion') {
      return {
        jsVersion: '',
        product: 'Chrome/CDB-Playwright-Relay',
        protocolVersion: '1.3',
        revision: '',
        userAgent: 'CDB-Playwright-Relay/1.0',
      };
    }
    if (method === 'Browser.setDownloadBehavior') return {};
    if (method === 'Target.setDiscoverTargets') return {};
    if (method === 'Target.setAutoAttach') {
      if (message.sessionId === undefined) await this.#attachTarget();
      else {
        await this.#context.setDomainDemand('Target', true, message.sessionId);
        this.#activeDomainDemands.set(`Target:${message.sessionId}`, {
          domain: 'Target',
          sessionId: message.sessionId,
        });
      }
      return {};
    }
    if (method === 'Target.getTargets') {
      const targetInfo = await this.#attachTarget();
      return { targetInfos: [targetInfo] };
    }
    if (method === 'Target.getTargetInfo') {
      return { targetInfo: await this.#attachTarget() };
    }
    if (method === 'Target.createTarget' || method === 'Target.closeTarget')
      throw new Error(`${method} is disabled by the CDB provider boundary.`);
    const sessionId = message.sessionId === this.#relaySessionId
      ? undefined
      : message.sessionId;
    const [domain, command] = method.split('.', 2);
    if (domain !== undefined && command === 'enable')
      this.#activeDomainDemands.set(`${domain}:${sessionId ?? 'root'}`, {
        domain,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    if (domain !== undefined && command === 'disable')
      this.#activeDomainDemands.delete(`${domain}:${sessionId ?? 'root'}`);
    return this.#context.executeCdp(
      method,
      parameters,
      sessionId,
    );
  }
}

function matcherExpression(matcher: AutomationTextMatcher): string {
  if (matcher.regex !== undefined) {
    if (
      matcher.regex.source.length > 1_000
      || !locatorRegularExpressionFlagsPattern.test(matcher.regex.flags ?? '')
    )
      throw new Error('The locator regular expression is outside the supported bounds.');
    const source = matcher.regex.source
      .replaceAll('/', String.raw`\/`)
      .replaceAll('\n', String.raw`\n`)
      .replaceAll('\r', String.raw`\r`)
      .replaceAll('\u2028', String.raw`\u2028`)
      .replaceAll('\u2029', String.raw`\u2029`);
    return `/${source}/${matcher.regex.flags ?? ''}`;
  }
  return JSON.stringify(matcher.pattern ?? '');
}

function strategyExpression(strategy: AutomationLocatorStrategy): string {
  if (strategy.xpath !== undefined)
    return `locator(${JSON.stringify(strategy.xpath)})`;
  if (strategy.css !== undefined)
    return `locator(${JSON.stringify(strategy.css)})`;
  if (strategy.role !== undefined) {
    const options = strategy.name === undefined || strategy.name.exact !== true
      ? ''
      : ', exact: true';
    const name = strategy.name === undefined
      ? ''
      : `, { name: ${matcherExpression(strategy.name)}${options} }`;
    return `getByRole(${JSON.stringify(strategy.role)}${name})`;
  }
  const namedStrategies = [
    ['getByLabel', strategy.label],
    ['getByPlaceholder', strategy.placeholder],
    ['getByAltText', strategy.altText],
    ['getByTitle', strategy.title],
    ['getByTestId', strategy.testId],
    ['getByText', strategy.text ?? strategy.name],
  ] as const;
  const match = namedStrategies.find(([, matcher]) => matcher !== undefined);
  if (match === undefined)
    throw new Error('The Playwright locator has no supported root strategy.');
  const [method, matcher] = match;
  if (matcher === undefined)
    throw new Error('The Playwright locator has no text matcher.');
  const options = method === 'getByTestId' || matcher.exact !== true
    ? ''
    : ', { exact: true }';
  return `${method}(${matcherExpression(matcher)}${options})`;
}

function locatorExpression(locator: AutomationLocator): string {
  const frames = (locator.frameChain ?? []).map(frame =>
    `frameLocator(${JSON.stringify(selectorForStrategy(frame))})`,
  );
  let expression = [
    ...frames,
    strategyExpression(locator),
  ].join('.');
  for (const descendant of locator.descendants ?? [])
    expression += `.${strategyExpression(descendant)}`;
  if (locator.has !== undefined)
    expression += `.filter({ has: ${strategyExpression(locator.has)} })`;
  if (locator.exclude !== undefined)
    expression += `.filter({ hasNot: ${strategyExpression(locator.exclude)} })`;
  if (locator.hasText !== undefined)
    expression += `.filter({ hasText: ${matcherExpression(locator.hasText)} })`;
  if (locator.hasNotText !== undefined)
    expression += `.filter({ hasNotText: ${matcherExpression(locator.hasNotText)} })`;
  if (locator.nth !== undefined) expression += `.nth(${locator.nth})`;
  return expression;
}

function selectorForStrategy(strategy: AutomationLocatorStrategy): string {
  const selector = iso.locatorOrSelectorAsSelector(
    'javascript',
    strategyExpression(strategy),
    'data-testid',
  );
  if (selector === '') throw new Error('Playwright could not parse the locator.');
  return selector;
}

export function selectorForLocator(
  locator: AutomationLocator,
  testIdAttributeName = 'data-testid',
): string {
  let selector = iso.locatorOrSelectorAsSelector(
    'javascript',
    locatorExpression(locator),
    testIdAttributeName,
  );
  if (selector === '') throw new Error('Playwright could not parse the locator.');
  if (locator.visible !== undefined)
    selector += ` >> visible=${String(locator.visible)}`;
  return selector;
}

function selectorFromOpaqueHandle(handle: string): string {
  const parsed: unknown = JSON.parse(handle);
  const selector = stringValue(objectValue(parsed).selector);
  if (selector === undefined)
    throw new Error('The Playwright element handle is invalid.');
  return selector;
}

function opaqueHandle(selector: string): string {
  return JSON.stringify({ selector });
}

function operationSelector(
  request: AutomationProviderRequest,
  testIdAttributeName: string,
): string | undefined {
  const operation = request.operation;
  if (operation.kind !== 'action' && operation.kind !== 'inspect')
    return undefined;
  if (operation.elementHandleId !== undefined)
    return selectorFromOpaqueHandle(operation.elementHandleId);
  if (operation.locator !== undefined)
    return selectorForLocator(operation.locator, testIdAttributeName);
  return undefined;
}

async function disposeHandles(
  handles: readonly { dispose: () => Promise<void> }[],
): Promise<void> {
  await Promise.all(handles.map(async handle => handle.dispose().catch(() => {})));
}

class PlaywrightAutomationProvider implements AutomationProvider {
  readonly descriptor = {
    capabilities: {
      actions: [
        'check',
        'click',
        'drag',
        'fill',
        'focus',
        'hover',
        'press',
        'scroll-into-view',
        'select-option',
        'type',
        'uncheck',
      ],
      locatorDialects: ['playwright'],
      operations: ['action', 'find', 'inspect', 'snapshot'],
      snapshotModes: ['accessibility', 'dom', 'interactive'],
    },
    id: 'playwright',
    version: playwrightPackageManifest.version,
  } as const;

  readonly #actionTimeoutMilliseconds: TimeoutMilliseconds;
  readonly #runtimeDisposals = new WeakMap<PlaywrightRuntime, Promise<void>>();
  readonly #runtimes = new Set<PlaywrightRuntime>();
  readonly #testIdAttributeName: string;

  constructor(options: PlaywrightAutomationProviderOptions) {
    const timing = { ...defaultPlaywrightAutomationTimingPolicy, ...options.timing };
    this.#actionTimeoutMilliseconds = validateTimeoutMilliseconds(
      timing.actionTimeoutMilliseconds,
      'actionTimeoutMilliseconds',
    );
    this.#testIdAttributeName
      = options.testIdAttributeName ?? 'data-testid';
  }

  async dispose(): Promise<void> {
    const runtimes = [...this.#runtimes];
    this.#runtimes.clear();
    await Promise.all(runtimes.map(async runtime => this.#disposeRuntime(runtime)));
  }

  async invalidateTarget(
    target: { readonly generation: number; readonly id: string },
  ): Promise<void> {
    const runtimes = [...this.#runtimes].filter(runtime =>
      runtime.context.target.id === target.id && runtime.context.target.generation === target.generation,
    );
    for (const runtime of runtimes) this.#runtimes.delete(runtime);
    await Promise.all(runtimes.map(async runtime => this.#disposeRuntime(runtime)));
  }

  async execute(
    request: AutomationProviderRequest,
    context: AutomationProviderExecutionContext,
  ): Promise<AutomationProviderResult> {
    let runtime: PlaywrightRuntime | undefined;
    try {
      runtime = await this.#createRuntime(request.operationId, context);
      this.#runtimes.add(runtime);
      const progress = createProgress(
        context.abortSignal,
        this.#actionTimeoutMilliseconds,
      );
      if (request.operation.kind === 'snapshot')
        return await this.#snapshot(
          { operation: request.operation, operationId: request.operationId },
          context,
          runtime,
          progress,
        );
      if (request.operation.kind === 'find')
        return await this.#find(
          { operation: request.operation, operationId: request.operationId },
          runtime,
        );
      if (request.operation.kind === 'inspect')
        return await this.#inspect(
          { operation: request.operation, operationId: request.operationId },
          context,
          runtime,
          progress,
        );
      return await this.#action(
        { operation: request.operation, operationId: request.operationId },
        runtime,
        progress,
      );
    } catch (error) {
      if (error instanceof AutomationProviderError) throw error;
      throw playwrightProviderError(error, request.operation.kind === 'action');
    } finally {
      if (runtime !== undefined) {
        this.#runtimes.delete(runtime);
        await this.#disposeRuntime(runtime);
      }
    }
  }

  async #disposeRuntime(runtime: PlaywrightRuntime): Promise<void> {
    const existingDisposal = this.#runtimeDisposals.get(runtime);
    if (existingDisposal !== undefined) return existingDisposal;
    const disposal = (async () => {
      await runtime.browser.close().catch(() => {});
      await runtime.transport.dispose();
    })();
    this.#runtimeDisposals.set(runtime, disposal);
    return disposal;
  }

  async #createRuntime(
    operationId: string,
    context: AutomationProviderExecutionContext,
  ): Promise<PlaywrightRuntime> {
    const transport = new CdbPlaywrightTransport(context);
    const playwright = server.createPlaywright({
      isClientCollocatedWithServer: true,
      sdkLanguage: 'javascript',
    });
    let browser: InternalBrowser;
    try {
      browser = await playwright.chromium.connectOverCDP(
        createProgress(context.abortSignal, this.#actionTimeoutMilliseconds),
        { isLocal: true, noDefaults: true, transport },
      );
    } catch (error) {
      throw transport.failure ?? error;
    }
    /** connectOverCDP stores its persistent context separately from explicitly created contexts. */
    const browserContext = browser._defaultContext ?? browser.contexts()[0];
    const page = browserContext?.pages()[0];
    if (page === undefined) {
      const contextKind = browser._defaultContext === undefined ? 'explicit' : 'persistent';
      const pageCount = browserContext?.pages().length ?? 0;
      transport.close();
      await browser.close().catch(() => {});
      throw new Error(
        `Playwright did not discover the granted CDB target (target type: ${context.target.type}; ${contextKind} context pages: ${pageCount}).`,
      );
    }
    return { browser, context, frame: page.mainFrame(), operationId, transport };
  }

  async #snapshot(
    request: AutomationProviderRequest & {
      readonly operation: Extract<AutomationProviderRequest['operation'], { readonly kind: 'snapshot' }>;
    },
    context: AutomationProviderExecutionContext,
    runtime: PlaywrightRuntime,
    progress: InternalProgress,
  ): Promise<AutomationProviderResult> {
    if (request.operation.mode === 'dom') {
      const value = await context.executeCdp('DOMSnapshot.captureSnapshot', {
        computedStyles: [],
        includeDOMRects: true,
        includePaintOrder: false,
      });
      return { snapshotId: randomUUID(), value };
    }
    const { snapshot } = await runtime.frame.ariaSnapshot(progress, {
      depth: request.operation.maximumDepth,
      mode: request.operation.mode === 'interactive' ? 'ai' : 'default',
    });
    const references = [
      ...new Set(snapshot.match(playwrightReferencePattern) ?? []),
    ].slice(0, request.operation.maximumNodes);
    return {
      elements: references.map(reference => ({
        handle: opaqueHandle(`aria-ref=${reference}`),
        metadata: { providerReference: reference },
      })),
      snapshotId: randomUUID(),
      value: { snapshot },
    };
  }

  async #find(
    request: AutomationProviderRequest & {
      readonly operation: Extract<AutomationProviderRequest['operation'], { readonly kind: 'find' }>;
    },
    runtime: PlaywrightRuntime,
  ): Promise<AutomationProviderResult> {
    const selector = selectorForLocator(
      request.operation.locator,
      this.#testIdAttributeName,
    );
    const handles = await runtime.frame.selectors.queryAll(selector);
    try {
      const matches = handles.slice(0, request.operation.maximumMatches);
      return {
        elements: matches.map((_handle, index) => ({
          handle: opaqueHandle(`${selector} >> nth=${index}`),
          metadata: { index },
        })),
        value: { matchCount: handles.length },
      };
    } finally {
      await disposeHandles(handles);
    }
  }

  async #inspect(
    request: AutomationProviderRequest & {
      readonly operation: Extract<AutomationProviderRequest['operation'], { readonly kind: 'inspect' }>;
    },
    context: AutomationProviderExecutionContext,
    runtime: PlaywrightRuntime,
    progress: InternalProgress,
  ): Promise<AutomationProviderResult> {
    const selector = operationSelector(request, this.#testIdAttributeName);
    if (selector === undefined) {
      return {
        value: {
          layout: await context.executeCdp('Page.getLayoutMetrics'),
        },
      };
    }
    const output: Record<string, unknown> = { selector };
    if (request.operation.include.includes('accessibility')) {
      output.accessibility = (await runtime.frame.ariaSnapshot(progress, {
        depth: 1,
        mode: 'default',
        selector,
      })).snapshot;
    }
    const handle = await runtime.frame.selectors.query(selector, {
      strict: true,
    });
    if (handle === null) throw new Error('The locator did not match an element.');
    try {
      if (request.operation.include.includes('geometry'))
        output.geometry = await handle.boundingBox(progress);
      output.visible = await runtime.frame.isVisible(progress, selector, {
        strict: true,
      });
      return { value: output as JsonObject };
    } finally {
      await handle.dispose();
    }
  }

  async #action(
    request: AutomationProviderRequest & {
      readonly operation: Extract<AutomationProviderRequest['operation'], { readonly kind: 'action' }>;
    },
    runtime: PlaywrightRuntime,
    progress: InternalProgress,
  ): Promise<AutomationProviderResult> {
    const selector = operationSelector(request, this.#testIdAttributeName);
    if (selector === undefined)
      throw new Error('The Playwright action requires a locator or element handle.');
    const modifiers = playwrightModifiers(request.operation.modifiers);
    const options = {
      ...(modifiers === undefined ? {} : { modifiers }),
      strict: true,
      timeout: request.operation.timeoutMilliseconds ?? this.#actionTimeoutMilliseconds ?? 0,
    };
    if (request.operation.action === 'click') {
      await runtime.frame.click(progress, selector, {
        ...options,
        button: request.operation.button,
        clickCount: request.operation.clickCount,
      });
    } else if (request.operation.action === 'hover')
      await runtime.frame.hover(progress, selector, options);
    else if (request.operation.action === 'focus')
      await runtime.frame.focus(progress, selector, options);
    else if (request.operation.action === 'fill')
      await runtime.frame.fill(
        progress,
        selector,
        request.operation.text,
        options,
      );
    else if (request.operation.action === 'type')
      await runtime.frame.type(
        progress,
        selector,
        request.operation.text,
        options,
      );
    else if (request.operation.action === 'press')
      await runtime.frame.press(
        progress,
        selector,
        request.operation.key,
        options,
      );
    else if (request.operation.action === 'check')
      await runtime.frame.check(progress, selector, options);
    else if (request.operation.action === 'uncheck')
      await runtime.frame.uncheck(progress, selector, options);
    else if (request.operation.action === 'select-option') {
      const values = [{ label: request.operation.label }];
      await runtime.frame.selectOption(progress, selector, [], values, options);
    } else if (request.operation.action === 'drag') {
      const destination = request.operation.destinationElementHandleId !== undefined
        ? selectorFromOpaqueHandle(request.operation.destinationElementHandleId)
        : request.operation.destinationLocator === undefined
          ? undefined
          : selectorForLocator(
              request.operation.destinationLocator,
              this.#testIdAttributeName,
            );
      if (destination === undefined)
        throw new Error('The Playwright drag action requires a destination.');
      await runtime.frame.dragAndDrop(progress, selector, destination, {
        ...options,
        button: request.operation.button,
      });
    } else {
      const handle = await runtime.frame.selectors.query(selector, {
        strict: true,
      });
      if (handle === null)
        throw new Error('The locator did not match an element.');
      try {
        await handle.scrollIntoViewIfNeeded(progress);
      } finally {
        await handle.dispose();
      }
    }
    return { value: { completed: true } };
  }
}

export function createPlaywrightAutomationProvider(
  options: PlaywrightAutomationProviderOptions = {},
): AutomationProvider {
  return new PlaywrightAutomationProvider(options);
}
