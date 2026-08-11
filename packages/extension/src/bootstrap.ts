export interface DevframeConnectionOffer {
  readonly brokerId: string;
  readonly display?: { readonly title?: string };
  readonly endpoint: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly protocolVersions: { readonly maximum: number; readonly minimum: number };
}

export interface DevframeOfferRuntimeMessage {
  readonly kind: 'chrome-debugger-bridge.devframe-offer';
  readonly offer: DevframeConnectionOffer;
  readonly origin: string;
}

export interface DevframeOfferMessageSource {
  readonly origin: string;
  readonly source: MessageEventSource | null;
}

export interface CreateDevframeOfferContentRelayOptions {
  readonly allowedOrigin: string;
  readonly postRuntimeMessage: (message: DevframeOfferRuntimeMessage) => Promise<void>;
  readonly removeWindowMessageListener: (listener: (event: MessageEvent<unknown>) => void) => void;
  readonly windowSource: MessageEventSource;
}

export interface DevframeOfferContentRelay {
  dispose: () => void;
  receive: (event: MessageEvent<unknown>) => void;
}

export interface DevframeOfferLocator {
  locate: (offer: DevframeConnectionOffer) => Promise<DevframeConnectionOffer | undefined>;
}

export interface DevframeOfferPairingPolicy {
  approve: (offer: DevframeConnectionOffer, origin: string) => Promise<boolean>;
}

export interface CreateDevframeAgentBootstrapOptions<Connection> {
  readonly connect: (offer: DevframeConnectionOffer) => Promise<Connection>;
  readonly locator: DevframeOfferLocator;
  readonly now?: () => number;
  readonly pairingPolicy: DevframeOfferPairingPolicy;
}

export interface DevframeAgentBootstrap<Connection> {
  accept: (message: unknown) => Promise<Connection | undefined>;
  cancel: (nonce: string) => void;
  dispose: () => void;
}

export interface DevframeRuntimeMessagePort {
  addListener: (listener: (message: unknown) => void) => void;
  removeListener: (listener: (message: unknown) => void) => void;
}

export interface InstalledDevframeOfferRuntimeHandler {
  dispose: () => void;
}

const offerMessageKind = 'chrome-debugger-bridge.devframe-offer';
const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates the non-secret connection offer before it crosses into extension runtime messaging. */
export function parseDevframeConnectionOffer(value: unknown): DevframeConnectionOffer | undefined {
  if (!isRecord(value)) return undefined;
  if ('authorization' in value || 'credential' in value || 'credentialId' in value || 'tabId' in value) return undefined;
  const protocolVersions = value.protocolVersions;
  if (!isRecord(protocolVersions)) return undefined;
  const minimumProtocolVersion = protocolVersions.minimum;
  const maximumProtocolVersion = protocolVersions.maximum;
  if (
    typeof value.brokerId !== 'string'
    || !identifierPattern.test(value.brokerId)
    || typeof value.endpoint !== 'string'
    || typeof value.expiresAt !== 'string'
    || typeof value.nonce !== 'string'
    || !identifierPattern.test(value.nonce)
    || typeof minimumProtocolVersion !== 'number'
    || !Number.isSafeInteger(minimumProtocolVersion)
    || typeof maximumProtocolVersion !== 'number'
    || !Number.isSafeInteger(maximumProtocolVersion)
    || minimumProtocolVersion < 1
    || maximumProtocolVersion < minimumProtocolVersion
  ) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    return undefined;
  }
  if ((endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined;
  if (!Number.isFinite(Date.parse(value.expiresAt))) return undefined;
  const display = isRecord(value.display) && (value.display.title === undefined || typeof value.display.title === 'string')
    ? (value.display.title === undefined ? undefined : { title: value.display.title })
    : undefined;
  return {
    brokerId: value.brokerId,
    ...(display === undefined ? {} : { display }),
    endpoint: endpoint.toString(),
    expiresAt: value.expiresAt,
    nonce: value.nonce,
    protocolVersions: { maximum: maximumProtocolVersion, minimum: minimumProtocolVersion },
  };
}

/** Relays one origin-bound offer from the page to extension runtime messaging, then removes its listener. */
export function createDevframeOfferContentRelay(options: CreateDevframeOfferContentRelayOptions): DevframeOfferContentRelay {
  let disposed = false;
  let receive: (event: MessageEvent<unknown>) => void;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    options.removeWindowMessageListener(receive);
  };
  receive = (event: MessageEvent<unknown>): void => {
    if (disposed || event.origin !== options.allowedOrigin || event.source !== options.windowSource) return;
    const offer = parseDevframeConnectionOffer(event.data);
    if (offer === undefined) return;
    dispose();
    void options.postRuntimeMessage({ kind: offerMessageKind, offer, origin: event.origin }).catch(() => {});
  };
  return { dispose, receive };
}

/** Validates a one-shot runtime offer before allowing the extension agent to open its own direct transport. */
export function createDevframeAgentBootstrap<Connection>(options: CreateDevframeAgentBootstrapOptions<Connection>): DevframeAgentBootstrap<Connection> {
  const now = options.now ?? Date.now;
  const consumedNonces = new Set<string>();
  let disposed = false;
  const cancel = (nonce: string): void => {
    consumedNonces.add(nonce);
  };
  return {
    async accept(message) {
      if (disposed || !isRecord(message) || message.kind !== offerMessageKind || typeof message.origin !== 'string') return undefined;
      const offer = parseDevframeConnectionOffer(message.offer);
      if (offer === undefined || consumedNonces.has(offer.nonce) || Date.parse(offer.expiresAt) <= now()) {
        if (offer !== undefined) cancel(offer.nonce);
        return undefined;
      }
      consumedNonces.add(offer.nonce);
      const locatedOffer = await options.locator.locate(offer);
      if (locatedOffer === undefined || locatedOffer.nonce !== offer.nonce || locatedOffer.brokerId !== offer.brokerId || Date.parse(locatedOffer.expiresAt) <= now()) return undefined;
      if (!await options.pairingPolicy.approve(locatedOffer, message.origin)) return undefined;
      return options.connect(locatedOffer);
    },
    cancel,
    dispose() {
      disposed = true;
      consumedNonces.clear();
    },
  };
}

/** Installs the service-worker runtime boundary and removes it deterministically on disposal. */
export function installDevframeOfferRuntimeHandler<Connection>(
  runtime: DevframeRuntimeMessagePort,
  bootstrap: DevframeAgentBootstrap<Connection>,
): InstalledDevframeOfferRuntimeHandler {
  let disposed = false;
  const listener = (message: unknown): void => {
    if (disposed) return;
    void bootstrap.accept(message).catch(() => {});
  };
  runtime.addListener(listener);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.removeListener(listener);
      bootstrap.dispose();
    },
  };
}
