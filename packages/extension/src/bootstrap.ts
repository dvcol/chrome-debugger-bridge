export interface BirpcConnectionOffer {
  readonly brokerId: string;
  readonly display?: { readonly title?: string };
  readonly endpoint: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly protocolVersions: { readonly maximum: number; readonly minimum: number };
}

export interface BirpcOfferRuntimeMessage {
  readonly kind: 'chrome-debugger-bridge.birpc-offer';
  readonly offer: BirpcConnectionOffer;
  readonly origin: string;
}

export interface BirpcOfferMessageSource {
  readonly origin: string;
  readonly source: MessageEventSource | null;
}

export interface CreateBirpcOfferContentRelayOptions {
  readonly addWindowMessageListener: (listener: (event: MessageEvent<unknown>) => void) => void;
  readonly allowedOrigin: string;
  readonly postRuntimeMessage: (message: BirpcOfferRuntimeMessage) => Promise<void>;
  readonly removeWindowMessageListener: (listener: (event: MessageEvent<unknown>) => void) => void;
  readonly windowSource: MessageEventSource;
}

export interface BirpcOfferContentRelay {
  dispose: () => void;
  receive: (event: MessageEvent<unknown>) => void;
}

export interface BirpcOfferLocator {
  locate: (offer: BirpcConnectionOffer) => Promise<BirpcConnectionOffer | undefined>;
}

export interface BirpcOfferPairingPolicy {
  approve: (offer: BirpcConnectionOffer, origin: string) => Promise<boolean>;
}

export interface CreateBirpcAgentBootstrapOptions<Connection> {
  /** Closes a connection that completes after its offer has been cancelled or the bootstrap has disposed. */
  readonly closeConnection?: (connection: Connection) => void;
  readonly connect: (offer: BirpcConnectionOffer) => Promise<Connection>;
  readonly locator: BirpcOfferLocator;
  readonly now?: () => number;
  readonly pairingPolicy: BirpcOfferPairingPolicy;
}

export interface BirpcAgentBootstrap<Connection> {
  accept: (message: unknown) => Promise<Connection | undefined>;
  cancel: (nonce: string) => void;
  dispose: () => void;
}

export interface BirpcRuntimeMessagePort {
  addListener: (listener: (message: unknown) => void) => void;
  removeListener: (listener: (message: unknown) => void) => void;
}

export interface InstalledBirpcOfferRuntimeHandler {
  dispose: () => void;
}

const offerMessageKind = 'chrome-debugger-bridge.birpc-offer';
const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates the non-secret connection offer before it crosses into extension runtime messaging. */
export function parseBirpcConnectionOffer(value: unknown): BirpcConnectionOffer | undefined {
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
export function createBirpcOfferContentRelay(options: CreateBirpcOfferContentRelayOptions): BirpcOfferContentRelay {
  let disposed = false;
  let receive: (event: MessageEvent<unknown>) => void;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    options.removeWindowMessageListener(receive);
  };
  receive = (event: MessageEvent<unknown>): void => {
    if (disposed || event.origin !== options.allowedOrigin || event.source !== options.windowSource) return;
    const offer = parseBirpcConnectionOffer(event.data);
    if (offer === undefined) return;
    dispose();
    void options.postRuntimeMessage({ kind: offerMessageKind, offer, origin: event.origin }).catch(() => {});
  };
  options.addWindowMessageListener(receive);
  return { dispose, receive };
}

/** Validates a one-shot runtime offer before allowing the extension agent to open its own direct transport. */
export function createBirpcAgentBootstrap<Connection>(options: CreateBirpcAgentBootstrapOptions<Connection>): BirpcAgentBootstrap<Connection> {
  const now = options.now ?? Date.now;
  const cancelledNonces = new Set<string>();
  const consumedNonces = new Set<string>();
  const connectionsByNonce = new Map<string, Connection>();
  let disposed = false;
  const cancel = (nonce: string): void => {
    cancelledNonces.add(nonce);
    consumedNonces.add(nonce);
    const connection = connectionsByNonce.get(nonce);
    if (connection !== undefined) options.closeConnection?.(connection);
    connectionsByNonce.delete(nonce);
  };
  return {
    async accept(message) {
      if (disposed || !isRecord(message) || message.kind !== offerMessageKind || typeof message.origin !== 'string') return undefined;
      const offer = parseBirpcConnectionOffer(message.offer);
      if (offer === undefined || cancelledNonces.has(offer.nonce) || consumedNonces.has(offer.nonce) || Date.parse(offer.expiresAt) <= now()) {
        if (offer !== undefined) cancel(offer.nonce);
        return undefined;
      }
      consumedNonces.add(offer.nonce);
      const locatedOffer = await options.locator.locate(offer);
      if (disposed || locatedOffer === undefined || locatedOffer.nonce !== offer.nonce || locatedOffer.brokerId !== offer.brokerId || Date.parse(locatedOffer.expiresAt) <= now()) return undefined;
      if (!await options.pairingPolicy.approve(locatedOffer, message.origin) || disposed) return undefined;
      const connection = await options.connect(locatedOffer);
      if (disposed || cancelledNonces.has(offer.nonce)) {
        options.closeConnection?.(connection);
        return undefined;
      }
      connectionsByNonce.set(offer.nonce, connection);
      return connection;
    },
    cancel,
    dispose() {
      disposed = true;
      cancelledNonces.clear();
      for (const connection of connectionsByNonce.values()) options.closeConnection?.(connection);
      connectionsByNonce.clear();
    },
  };
}

/** Installs the service-worker runtime boundary and removes it deterministically on disposal. */
export function installBirpcOfferRuntimeHandler<Connection>(
  runtime: BirpcRuntimeMessagePort,
  bootstrap: BirpcAgentBootstrap<Connection>,
): InstalledBirpcOfferRuntimeHandler {
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
