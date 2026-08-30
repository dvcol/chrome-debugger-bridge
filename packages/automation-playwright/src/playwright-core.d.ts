declare module 'playwright-core/lib/coreBundle' {
  interface InternalProgress {
    readonly deadline: number;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
    readonly timeout: number;
    disableTimeout: () => void;
    log: (message: string) => void;
    race: <Value>(value: Promise<Value> | readonly Promise<Value>[]) => Promise<Value>;
    setAllowConcurrentOrNestedRaces: (allow: boolean) => void;
    wait: (timeout: number) => Promise<void>;
  }

  interface InternalCdpMessage {
    readonly error?: { readonly message: string };
    readonly id?: number;
    readonly method?: string;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly sessionId?: string;
  }

  interface InternalTransport {
    onclose?: () => void;
    onmessage?: (message: InternalCdpMessage) => void;
    close: () => void;
    send: (message: InternalCdpMessage) => void;
  }

  interface InternalElementHandle {
    boundingBox: (progress: InternalProgress) => Promise<Readonly<Record<string, number>> | null>;
    dispose: () => Promise<void>;
    scrollIntoViewIfNeeded: (progress: InternalProgress) => Promise<void>;
  }

  interface InternalFrame {
    ariaSnapshot: (
      progress: InternalProgress,
      options: Readonly<Record<string, unknown>>,
    ) => Promise<{ readonly snapshot: string }>;
    check: (progress: InternalProgress, selector: string, options: Readonly<Record<string, unknown>>) => Promise<void>;
    click: (progress: InternalProgress, selector: string, options: Readonly<Record<string, unknown>>) => Promise<void>;
    dragAndDrop: (
      progress: InternalProgress,
      source: string,
      destination: string,
      options: Readonly<Record<string, unknown>>,
    ) => Promise<void>;
    fill: (
      progress: InternalProgress,
      selector: string,
      value: string,
      options: Readonly<Record<string, unknown>>,
    ) => Promise<void>;
    focus: (progress: InternalProgress, selector: string, options: Readonly<Record<string, unknown>>) => Promise<void>;
    hover: (progress: InternalProgress, selector: string, options: Readonly<Record<string, unknown>>) => Promise<void>;
    isVisible: (progress: InternalProgress, selector: string, options: Readonly<Record<string, unknown>>) => Promise<boolean>;
    press: (
      progress: InternalProgress,
      selector: string,
      key: string,
      options: Readonly<Record<string, unknown>>,
    ) => Promise<void>;
    selectOption: (
      progress: InternalProgress,
      selector: string,
      elements: readonly InternalElementHandle[],
      values: readonly Readonly<Record<string, unknown>>[],
      options: Readonly<Record<string, unknown>>,
    ) => Promise<readonly string[]>;
    selectors: {
      query: (selector: string, options?: Readonly<Record<string, unknown>>) => Promise<InternalElementHandle | null>;
      queryAll: (selector: string) => Promise<readonly InternalElementHandle[]>;
    };
    type: (
      progress: InternalProgress,
      selector: string,
      text: string,
      options: Readonly<Record<string, unknown>>,
    ) => Promise<void>;
    uncheck: (progress: InternalProgress, selector: string, options: Readonly<Record<string, unknown>>) => Promise<void>;
  }

  interface InternalPage {
    mainFrame: () => InternalFrame;
  }

  interface InternalBrowserContext {
    pages: () => readonly InternalPage[];
  }

  interface InternalBrowser {
    readonly _defaultContext?: InternalBrowserContext;
    close: () => Promise<void>;
    contexts: () => readonly InternalBrowserContext[];
  }

  interface InternalPlaywright {
    chromium: {
      connectOverCDP: (
        progress: InternalProgress,
        options: {
          readonly isLocal: boolean;
          readonly noDefaults: boolean;
          readonly transport: InternalTransport;
        },
      ) => Promise<InternalBrowser>;
    };
  }

  export const iso: {
    locatorOrSelectorAsSelector: (
      language: 'javascript',
      locator: string,
      testIdAttributeName: string,
    ) => string;
  };

  export const server: {
    createPlaywright: (options: {
      readonly isClientCollocatedWithServer: boolean;
      readonly sdkLanguage: 'javascript';
    }) => InternalPlaywright;
    nullProgress: InternalProgress;
  };

  export type {
    InternalBrowser,
    InternalCdpMessage,
    InternalElementHandle,
    InternalFrame,
    InternalProgress,
    InternalTransport,
  };
}
