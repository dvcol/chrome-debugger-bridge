import type {
  AcquireLeaseRequest,
  ArtifactAccessRequest,
  CdpSubscription,
  ChromeDebuggerBridgeClient,
  ReleaseLeaseRequest,
  RenewLeaseRequest,
  TargetChange,
} from '@dvcol/cdb';
import type {
  AgentAuthenticationMessage,
  AgentToBrokerMessage,
  BrokerToAgentMessage,
  BrokerToClientMessage,
  CdpCommand,
  CdpCommandResult,
  CdpEvent,
  CdpSubscriptionRequest,
  ClientToBrokerMessage,
  Lease,
  ProtocolVersionRange,
  PublishedTarget,
} from '@dvcol/cdb/protocol';

import type { AgentAuthenticationTranscript, AuthenticatedFrame } from './authentication.js';

import { createChromeDebuggerBridgeClient } from '@dvcol/cdb';
import {
  agentAuthenticationMessageSchema,
  agentToBrokerMessageSchema,
  brokerToAgentMessageSchema,
  brokerToClientMessageSchema,
} from '@dvcol/cdb/protocol';

import {
  createAgentAuthenticationProof,
  createAuthenticatedFrame,
  createRandomIdentifier,
  decodeBase64UrlBytes,
  generateRandomBase64Url,
  importAgentCredential,
  openAuthenticatedFrame,
  verifyBrokerAuthenticationProof,
} from './authentication.js';
import { agentWebSocketProtocol, clientWebSocketProtocol, validateWebSocketEndpointSecurity } from './protocols.js';

export { createHttpArtifactReader } from './artifact-reader.js';
export {
  type ArtifactTransferControl,
  type ArtifactTransferSocket,
  createArtifactTransferReceiver,
  decodeArtifactChunk,
  encodeArtifactChunk,
  streamArtifact,
} from './artifacts.js';

export const defaultAgentWebSocketPath = '/cdb/agent';
export const defaultClientWebSocketPath = '/cdb/client';
export { agentWebSocketProtocol, clientWebSocketProtocol } from './protocols.js';
const maximumPendingAuthenticatedMessages = 32;
const base64PaddingPattern = /=+$/u;

export interface PairedAgentCredential {
  readonly agentId: string;
  readonly brokerId: string;
  readonly credentialId: string;
  readonly endpoint: string;
  readonly key: CryptoKey;
}

export interface PairedAgentCredentialStore {
  load: (endpoint: string) => Promise<PairedAgentCredential | undefined>;
  remove: (credentialId: string) => Promise<void>;
  save: (credential: PairedAgentCredential) => Promise<void>;
}

export interface BrowserAgentConnection {
  readonly agentId: string;
  readonly brokerId: string;
  readonly connectionId: string;
  readonly credentialId: string;
  readonly principalId: string;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  close: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: BrokerToAgentMessage) => void) => () => void;
  send: (message: AgentToBrokerMessage) => Promise<void>;
}

export interface ConnectAgentWebSocketOptions {
  readonly credentialStore: PairedAgentCredentialStore;
  readonly endpoint: string;
  readonly handshakeTimeoutMilliseconds?: number;
  readonly origin?: string;
  readonly protocolVersions?: ProtocolVersionRange;
  readonly requestPairingCode?: (challenge: {
    readonly abortSignal: AbortSignal;
    readonly brokerId: string;
    readonly endpoint: string;
    readonly expiresAt: string;
  }) => Promise<string>;
}

interface BufferedWebSocketMessages {
  forwardTo: (listener: (event: MessageEvent<unknown>) => void) => void;
  receiveText: (timeoutMilliseconds: number) => Promise<string>;
}

function bufferWebSocketMessages(webSocket: WebSocket): BufferedWebSocketMessages {
  const queuedEvents: MessageEvent<unknown>[] = [];
  let forwardListener: ((event: MessageEvent<unknown>) => void) | undefined;
  let pendingReceiver: {
    readonly reject: (error: Error) => void;
    readonly resolve: (source: string) => void;
  } | undefined;
  let terminalError: Error | undefined;

  const resolveEvent = (event: MessageEvent<unknown>): void => {
    const receiver = pendingReceiver;
    pendingReceiver = undefined;
    if (typeof event.data !== 'string') {
      receiver?.reject(new Error('Authentication response must be text'));
      return;
    }
    receiver?.resolve(event.data);
  };
  const fail = (error: Error): void => {
    terminalError = error;
    const receiver = pendingReceiver;
    pendingReceiver = undefined;
    receiver?.reject(error);
  };

  webSocket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (forwardListener !== undefined) {
      forwardListener(event);
      return;
    }
    if (pendingReceiver !== undefined) {
      resolveEvent(event);
      return;
    }
    queuedEvents.push(event);
    if (queuedEvents.length > maximumPendingAuthenticatedMessages) {
      fail(new Error('Too many messages arrived before authentication completed'));
      webSocket.close(4003, 'Too many pending messages');
    }
  });
  webSocket.addEventListener('error', () => fail(new Error('WebSocket failed during authentication')));
  webSocket.addEventListener('close', () => fail(new Error('WebSocket closed during authentication')), { once: true });

  return {
    forwardTo(listener) {
      if (pendingReceiver !== undefined || forwardListener !== undefined) {
        throw new Error('WebSocket message dispatcher is already in use');
      }
      forwardListener = listener;
      for (const event of queuedEvents.splice(0)) {
        listener(event);
      }
    },
    async receiveText(timeoutMilliseconds) {
      if (forwardListener !== undefined || pendingReceiver !== undefined) {
        throw new Error('WebSocket message dispatcher is already in use');
      }
      const queuedEvent = queuedEvents.shift();
      if (queuedEvent !== undefined) {
        if (typeof queuedEvent.data !== 'string') {
          throw new TypeError('Authentication response must be text');
        }
        return queuedEvent.data;
      }
      if (terminalError !== undefined) {
        throw terminalError;
      }
      let timeout: ReturnType<typeof globalThis.setTimeout>;
      try {
        return await new Promise<string>((resolve, reject) => {
          pendingReceiver = { reject, resolve };
          timeout = globalThis.setTimeout(() => {
            pendingReceiver = undefined;
            reject(new Error('Authentication response timed out'));
          }, timeoutMilliseconds);
        });
      } finally {
        globalThis.clearTimeout(timeout!);
      }
    },
  };
}

async function requestPairingCodeWithDeadline(
  webSocket: WebSocket,
  timeoutMilliseconds: number,
  requestPairingCode: NonNullable<ConnectAgentWebSocketOptions['requestPairingCode']>,
  challenge: Omit<Parameters<NonNullable<ConnectAgentWebSocketOptions['requestPairingCode']>>[0], 'abortSignal'>,
): Promise<string> {
  const abortController = new AbortController();
  const handleClose = (): void => abortController.abort();
  const timeout = globalThis.setTimeout(() => abortController.abort(), timeoutMilliseconds);
  webSocket.addEventListener('close', handleClose, { once: true });
  try {
    const approval = Promise.resolve(requestPairingCode({ ...challenge, abortSignal: abortController.signal }));
    return await new Promise<string>((resolve, reject) => {
      const handleAbort = (): void => reject(new Error('Pairing approval was aborted'));
      abortController.signal.addEventListener('abort', handleAbort, { once: true });
      void approval.then(resolve, reject).finally(() => {
        abortController.signal.removeEventListener('abort', handleAbort);
      });
    });
  } finally {
    globalThis.clearTimeout(timeout);
    webSocket.removeEventListener('close', handleClose);
  }
}

async function waitForOpen(webSocket: WebSocket, timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof globalThis.setTimeout>;
    function cleanup(): void {
      globalThis.clearTimeout(timeout);
      webSocket.removeEventListener('open', handleOpen);
      webSocket.removeEventListener('error', handleError);
      webSocket.removeEventListener('close', handleClose);
    }
    function handleOpen(): void {
      cleanup();
      resolve();
    }
    function handleError(): void {
      cleanup();
      reject(new Error('WebSocket connection failed'));
    }
    function handleClose(): void {
      cleanup();
      reject(new Error('WebSocket closed before authentication'));
    }

    timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket connection timed out'));
    }, timeoutMilliseconds);
    webSocket.addEventListener('open', handleOpen, { once: true });
    webSocket.addEventListener('error', handleError, { once: true });
    webSocket.addEventListener('close', handleClose, { once: true });
  });
}

async function parseAuthenticationMessage(source: string): Promise<AgentAuthenticationMessage> {
  const parsed = JSON.parse(source) as unknown;
  const result = await agentAuthenticationMessageSchema['~standard'].validate(parsed);
  if ('issues' in result) {
    throw new Error('Received an invalid authentication message');
  }
  return result.value;
}

async function exchangeAuthenticationMessage(
  webSocket: WebSocket,
  messageBuffer: BufferedWebSocketMessages,
  message: AgentAuthenticationMessage,
  timeoutMilliseconds: number,
): Promise<AgentAuthenticationMessage> {
  webSocket.send(JSON.stringify(message));
  return parseAuthenticationMessage(await messageBuffer.receiveText(timeoutMilliseconds));
}

function throwAuthenticationError(message: AgentAuthenticationMessage): never {
  if (message.kind === 'error') {
    throw new Error(message.error.message);
  }
  throw new Error('Received an unexpected authentication response');
}

function resolveOrigin(explicitOrigin: string | undefined): string {
  if (explicitOrigin !== undefined) {
    return explicitOrigin;
  }
  if (typeof globalThis.location?.origin === 'string' && globalThis.location.origin !== 'null') {
    return globalThis.location.origin;
  }
  throw new Error('An explicit origin is required outside a browser location');
}

export async function connectAgentWebSocket(
  options: ConnectAgentWebSocketOptions,
): Promise<BrowserAgentConnection> {
  const timeoutMilliseconds = options.handshakeTimeoutMilliseconds ?? 5_000;
  const endpointUrl = new URL(options.endpoint);
  validateWebSocketEndpointSecurity(endpointUrl);
  if (endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
    throw new Error('The agent WebSocket endpoint must not contain credentials, query parameters, or fragments');
  }

  const origin = resolveOrigin(options.origin);
  const storedCredential = await options.credentialStore.load(endpointUrl.href);
  const agentId = storedCredential?.agentId ?? createRandomIdentifier();
  const clientNonce = generateRandomBase64Url(32);
  const beginRequestId = createRandomIdentifier();
  const webSocket = new globalThis.WebSocket(endpointUrl.href, agentWebSocketProtocol);
  const messageBuffer = bufferWebSocketMessages(webSocket);
  const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    webSocket.addEventListener('close', event => resolve({ code: event.code, reason: event.reason }), { once: true });
  });

  try {
    await waitForOpen(webSocket, timeoutMilliseconds);
    if (webSocket.protocol !== agentWebSocketProtocol) {
      throw new Error('The broker selected an invalid WebSocket subprotocol');
    }
    const beginResponse = await exchangeAuthenticationMessage(webSocket, messageBuffer, {
      kind: 'request',
      method: 'agent.auth.begin',
      parameters: {
        agentId,
        clientNonce,
        credentialId: storedCredential?.credentialId,
        endpointPath: endpointUrl.pathname,
        expectedBrokerId: storedCredential?.brokerId,
        origin,
        protocolVersions: options.protocolVersions ?? { maximum: 1, minimum: 1 },
        role: 'agent',
      },
      protocolVersion: 1,
      requestId: beginRequestId,
    }, timeoutMilliseconds);
    if (beginResponse.kind !== 'response' || beginResponse.method !== 'agent.auth.begin') {
      throwAuthenticationError(beginResponse);
    }
    if (beginResponse.requestId !== beginRequestId || beginResponse.result.endpointPath !== endpointUrl.pathname) {
      throw new Error('Authentication challenge does not match the request');
    }
    if (storedCredential !== undefined && beginResponse.result.brokerId !== storedCredential.brokerId) {
      throw new Error('Broker identity changed and requires explicit re-pairing');
    }
    if (storedCredential !== undefined && beginResponse.result.pairingRequired) {
      throw new Error('The stored credential was rejected; remove it explicitly before pairing again');
    }

    let credentialKey = storedCredential?.key;
    let credentialId = storedCredential?.credentialId;
    let pendingCredential: PairedAgentCredential | undefined;
    if (beginResponse.result.pairingRequired) {
      if (options.requestPairingCode === undefined) {
        throw new Error('Pairing approval is required');
      }
      const pairingApprovalTimeoutMilliseconds = Math.max(1, Date.parse(beginResponse.result.expiresAt) - Date.now());
      const pairingCode = await requestPairingCodeWithDeadline(
        webSocket,
        pairingApprovalTimeoutMilliseconds,
        options.requestPairingCode,
        {
          brokerId: beginResponse.result.brokerId,
          endpoint: endpointUrl.href,
          expiresAt: beginResponse.result.expiresAt,
        },
      );
      const pairingRequestId = createRandomIdentifier();
      const pairingResponse = await exchangeAuthenticationMessage(webSocket, messageBuffer, {
        kind: 'request',
        method: 'agent.pair.finish',
        parameters: {
          connectionId: beginResponse.result.connectionId,
          pairingCode,
        },
        protocolVersion: 1,
        requestId: pairingRequestId,
      }, timeoutMilliseconds);
      if (pairingResponse.kind !== 'response' || pairingResponse.method !== 'agent.pair.finish') {
        throwAuthenticationError(pairingResponse);
      }
      if (
        pairingResponse.requestId !== pairingRequestId
        || pairingResponse.result.brokerId !== beginResponse.result.brokerId
      ) {
        throw new Error('Pairing response does not match the challenge');
      }
      const credentialBytes = decodeBase64UrlBytes(pairingResponse.result.credential);
      try {
        credentialKey = await importAgentCredential(credentialBytes);
      } finally {
        credentialBytes.fill(0);
      }
      const pairedCredentialId = pairingResponse.result.credentialId;
      credentialId = pairedCredentialId;
      pendingCredential = {
        agentId,
        brokerId: pairingResponse.result.brokerId,
        credentialId: pairedCredentialId,
        endpoint: endpointUrl.href,
        key: credentialKey,
      };
    }

    if (credentialKey === undefined || credentialId === undefined) {
      throw new Error('Broker did not provide an authentication credential');
    }
    if (beginResponse.result.credentialId !== undefined && beginResponse.result.credentialId !== credentialId) {
      throw new Error('Authentication challenge selected a different credential');
    }

    const transcript: AgentAuthenticationTranscript = {
      agentId,
      brokerId: beginResponse.result.brokerId,
      clientNonce,
      connectionId: beginResponse.result.connectionId,
      credentialId,
      endpointPath: endpointUrl.pathname,
      expiresAt: beginResponse.result.expiresAt,
      origin,
      protocolVersion: beginResponse.result.protocolVersion,
      serverNonce: beginResponse.result.serverNonce,
    };
    const finishRequestId = createRandomIdentifier();
    const finishResponse = await exchangeAuthenticationMessage(webSocket, messageBuffer, {
      kind: 'request',
      method: 'agent.auth.finish',
      parameters: {
        connectionId: transcript.connectionId,
        credentialId,
        proof: await createAgentAuthenticationProof(credentialKey, transcript),
      },
      protocolVersion: 1,
      requestId: finishRequestId,
    }, timeoutMilliseconds);
    if (finishResponse.kind !== 'response' || finishResponse.method !== 'agent.auth.finish') {
      throwAuthenticationError(finishResponse);
    }
    if (
      finishResponse.requestId !== finishRequestId
      || finishResponse.result.connectionId !== transcript.connectionId
      || !await verifyBrokerAuthenticationProof(credentialKey, transcript, {
        connectionGeneration: finishResponse.result.connectionGeneration,
        principalId: finishResponse.result.principalId,
      }, finishResponse.result.brokerProof)
    ) {
      throw new Error('Broker authentication proof is invalid');
    }
    if (pendingCredential !== undefined) {
      await options.credentialStore.save(pendingCredential);
    }

    const messageListeners = new Set<(message: BrokerToAgentMessage) => void>();
    const pendingApplicationMessages: BrokerToAgentMessage[] = [];
    let inboundSequence = 1;
    let outboundSequence = 1;
    let pendingMessages = 0;
    let pendingReceive = Promise.resolve();
    let pendingSend = Promise.resolve();
    let receiveFailed = false;

    messageBuffer.forwardTo((event: MessageEvent<unknown>) => {
      if (receiveFailed) {
        return;
      }
      if (typeof event.data !== 'string') {
        receiveFailed = true;
        webSocket.close(4002, 'Text messages required');
        return;
      }
      const messageText = event.data;
      pendingMessages += 1;
      if (pendingMessages > maximumPendingAuthenticatedMessages) {
        receiveFailed = true;
        webSocket.close(4003, 'Too many pending messages');
        return;
      }
      pendingReceive = pendingReceive.then(async () => {
        if (receiveFailed) {
          return;
        }
        const frame = JSON.parse(messageText) as AuthenticatedFrame;
        const payload = await openAuthenticatedFrame(
          credentialKey,
          transcript,
          'broker-to-agent',
          inboundSequence,
          frame,
        );
        const result = await brokerToAgentMessageSchema['~standard'].validate(payload);
        if ('issues' in result) {
          throw new Error('Broker sent an invalid agent-plane message');
        }
        inboundSequence += 1;
        if (messageListeners.size === 0) {
          if (pendingApplicationMessages.length >= maximumPendingAuthenticatedMessages) {
            throw new Error('Too many messages are waiting for an agent listener');
          }
          pendingApplicationMessages.push(result.value);
          return;
        }
        for (const listener of messageListeners) {
          listener(result.value);
        }
      }).catch(() => {
        receiveFailed = true;
        webSocket.close(4002, 'Invalid authenticated message');
      }).finally(() => pendingMessages -= 1);
    });
    webSocket.addEventListener('close', () => {
      messageListeners.clear();
      pendingApplicationMessages.length = 0;
    }, { once: true });

    return {
      agentId,
      brokerId: transcript.brokerId,
      connectionId: transcript.connectionId,
      credentialId,
      principalId: finishResponse.result.principalId,
      closed,
      close(code, reason) {
        webSocket.close(code, reason);
      },
      onMessage(listener) {
        messageListeners.add(listener);
        while (pendingApplicationMessages.length > 0 && messageListeners.has(listener)) {
          listener(pendingApplicationMessages.shift()!);
        }
        return () => messageListeners.delete(listener);
      },
      async send(message) {
        pendingSend = pendingSend.then(async () => {
          const validation = await agentToBrokerMessageSchema['~standard'].validate(message);
          if ('issues' in validation) {
            throw new Error('Cannot send an invalid agent-plane message');
          }
          const frame = await createAuthenticatedFrame(
            credentialKey,
            transcript,
            'agent-to-broker',
            outboundSequence,
            validation.value,
          );
          webSocket.send(JSON.stringify(frame));
          outboundSequence += 1;
        });
        await pendingSend;
      },
    };
  } catch (error) {
    webSocket.close(4001, 'Authentication failed');
    throw error;
  }
}

export interface BrowserClientConnection {
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  close: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: BrokerToClientMessage) => void) => () => void;
  send: (message: ClientToBrokerMessage) => Promise<void>;
}

export interface ConnectBrowserClientWebSocketOptions {
  /** Sent as an encoded WebSocket subprotocol because browsers cannot set upgrade headers. */
  readonly authorization: string;
  readonly endpoint: string;
  readonly handshakeTimeoutMilliseconds?: number;
}

function encodeAuthorizationSubprotocol(authorization: string): string {
  const bytes = new TextEncoder().encode(authorization);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `chrome-debugger-bridge.authorization.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(base64PaddingPattern, '')}`;
}

/** Connects a generic browser client using only the platform WebSocket and Web Crypto APIs. */
export async function connectBrowserClientWebSocket(
  options: ConnectBrowserClientWebSocketOptions,
): Promise<BrowserClientConnection> {
  const timeoutMilliseconds = options.handshakeTimeoutMilliseconds ?? 5_000;
  const endpointUrl = new URL(options.endpoint);
  validateWebSocketEndpointSecurity(endpointUrl);
  if (endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
    throw new Error('The client WebSocket endpoint must not contain credentials, query parameters, or fragments');
  }
  if (options.authorization.length === 0) throw new Error('Client authorization is required');

  const webSocket = new globalThis.WebSocket(endpointUrl.href, [
    clientWebSocketProtocol,
    encodeAuthorizationSubprotocol(options.authorization),
  ]);
  webSocket.binaryType = 'arraybuffer';
  await waitForOpen(webSocket, timeoutMilliseconds);
  if (webSocket.protocol !== clientWebSocketProtocol) {
    webSocket.close(1002, 'Invalid WebSocket subprotocol');
    throw new Error('The broker selected an invalid WebSocket subprotocol');
  }

  const listeners = new Set<(message: BrokerToClientMessage) => void>();
  const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    webSocket.addEventListener('close', event => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
  let pendingMessages = 0;
  let pendingReceive = Promise.resolve();
  let receiveFailed = false;
  webSocket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (receiveFailed) return;
    if (typeof event.data !== 'string') {
      receiveFailed = true;
      webSocket.close(1003, 'Text messages required');
      return;
    }
    pendingMessages += 1;
    if (pendingMessages > maximumPendingAuthenticatedMessages) {
      receiveFailed = true;
      webSocket.close(1008, 'Too many pending messages');
      return;
    }
    pendingReceive = pendingReceive.then(async () => {
      const result = await brokerToClientMessageSchema['~standard'].validate(JSON.parse(event.data as string) as unknown);
      if ('issues' in result) throw new Error('Broker sent an invalid client-plane message');
      for (const listener of listeners) listener(result.value);
    }).catch(() => {
      receiveFailed = true;
      webSocket.close(1008, 'Invalid broker client message');
    }).finally(() => pendingMessages -= 1);
  });
  webSocket.addEventListener('close', () => listeners.clear(), { once: true });

  return {
    closed,
    close(code, reason) {
      webSocket.close(code, reason);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(message) {
      if (webSocket.readyState !== WebSocket.OPEN) throw new Error('The client WebSocket is not open');
      webSocket.send(JSON.stringify(message));
    },
  };
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (message: Extract<BrokerToClientMessage, { readonly kind: 'response' }>) => void;
}

function createAsyncQueue<Value>(maximumValues: number): AsyncIterable<Value> & {
  close: (error?: Error) => void;
  offer: (value: Value) => void;
} {
  const values: Value[] = [];
  const receivers: Array<{ readonly reject: (error: Error) => void; readonly resolve: (result: IteratorResult<Value>) => void }> = [];
  let terminalError: Error | undefined;
  let closed = false;
  return {
    close(error) {
      closed = true;
      terminalError = error;
      while (receivers.length > 0) {
        const receiver = receivers.shift()!;
        if (error === undefined) receiver.resolve({ done: true, value: undefined });
        else receiver.reject(error);
      }
    },
    offer(value) {
      if (closed) return;
      const receiver = receivers.shift();
      if (receiver !== undefined) receiver.resolve({ done: false, value });
      else if (values.length < maximumValues) values.push(value);
      else throw new Error('The browser client queue overflowed');
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Value>> {
          const value = values.shift();
          if (value !== undefined) return { done: false, value };
          if (terminalError !== undefined) throw terminalError;
          if (closed) return { done: true, value: undefined };
          return new Promise((resolve, reject) => receivers.push({ reject, resolve }));
        },
      };
    },
  };
}

export interface BrowserChromeDebuggerBridgeClient extends ChromeDebuggerBridgeClient {
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  cancelCommand: (request: Pick<CdpCommand, 'operationId' | 'targetGeneration' | 'targetId'>) => Promise<void>;
  close: (code?: number, reason?: string) => void;
}

export interface CreateBrowserChromeDebuggerBridgeClientOptions extends ConnectBrowserClientWebSocketOptions {
  readonly artifactEndpoint: string;
  readonly reconnect?: {
    readonly initialDelayMilliseconds?: number;
    readonly maximumDelayMilliseconds?: number;
  };
}

interface BrowserSubscriptionState {
  readonly events: ReturnType<typeof createAsyncQueue<CdpEvent>>;
  readonly request: CdpSubscriptionRequest;
  closed: boolean;
  droppedCount: number;
  id: string;
  lastDeliveredSequence: number;
  overflowed: boolean;
}

/** Creates the browser target-directory facade on top of an authenticated JSON-RPC WebSocket. */
export async function createBrowserChromeDebuggerBridgeClient(
  options: CreateBrowserChromeDebuggerBridgeClientOptions,
): Promise<BrowserChromeDebuggerBridgeClient> {
  let connection = await connectBrowserClientWebSocket(options);
  const pendingRequests = new Map<string, PendingRequest>();
  const targetChanges = createAsyncQueue<TargetChange>(maximumPendingAuthenticatedMessages);
  const subscriptions = new Map<string, BrowserSubscriptionState>();
  const subscriptionStates = new Set<BrowserSubscriptionState>();
  const initialReconnectDelayMilliseconds = options.reconnect?.initialDelayMilliseconds ?? 25;
  const maximumReconnectDelayMilliseconds = options.reconnect?.maximumDelayMilliseconds ?? 1_000;
  let manuallyClosed = false;
  let reconnecting: Promise<void> | undefined;
  let removeListener = (): void => {};
  let resolveClosed: (close: { readonly code: number; readonly reason: string }) => void;
  const closed = new Promise<{ readonly code: number; readonly reason: string }>(resolve => resolveClosed = resolve);
  let nextTargetSequence = 0;

  const failPendingRequests = (error: Error): void => {
    for (const pendingRequest of pendingRequests.values()) pendingRequest.reject(error);
    pendingRequests.clear();
  };
  const receiveMessage = (message: BrokerToClientMessage): void => {
    if (message.kind === 'response') {
      const pendingRequest = pendingRequests.get(message.requestId);
      if (pendingRequest !== undefined) {
        pendingRequests.delete(message.requestId);
        pendingRequest.resolve(message);
      }
      return;
    }
    if (message.kind === 'error') {
      const pendingRequest = pendingRequests.get(message.requestId);
      if (pendingRequest !== undefined) {
        pendingRequests.delete(message.requestId);
        pendingRequest.reject(new Error(`${message.error.code}: ${message.error.message}`));
      }
      return;
    }
    if (message.method === 'targets.snapshot') {
      nextTargetSequence = message.parameters.sequence;
      targetChanges.offer({ kind: 'snapshot', sequence: nextTargetSequence, targets: message.parameters.targets });
    } else if (message.method === 'targets.published') {
      targetChanges.offer({ kind: 'published', sequence: ++nextTargetSequence, target: message.parameters.target });
    } else if (message.method === 'targets.updated') {
      targetChanges.offer({ kind: 'updated', sequence: ++nextTargetSequence, target: message.parameters.target });
    } else if (message.method === 'targets.revoked') {
      targetChanges.offer({ kind: 'revoked', sequence: ++nextTargetSequence, ...message.parameters });
    } else if (message.method === 'cdp.event') {
      const subscription = subscriptions.get(message.parameters.subscriptionId);
      if (subscription !== undefined) {
        subscription.lastDeliveredSequence = message.parameters.sequence;
        subscription.events.offer(message.parameters);
      }
    } else if (message.method === 'subscriptions.overflow') {
      const subscription = subscriptions.get(message.parameters.subscriptionId);
      if (subscription !== undefined) {
        subscription.droppedCount = message.parameters.droppedCount;
        subscription.lastDeliveredSequence = message.parameters.lastDeliveredSequence;
        subscription.overflowed = true;
      }
    }
  };

  const wait = async (milliseconds: number): Promise<void> => new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
  const attachConnection = (nextConnection: BrowserClientConnection): void => {
    connection = nextConnection;
    removeListener = connection.onMessage(receiveMessage);
    void connection.closed.then((close) => {
      removeListener();
      if (manuallyClosed) {
        failPendingRequests(new Error(`The client WebSocket closed (${close.code}).`));
        targetChanges.close();
        for (const subscription of subscriptionStates) subscription.events.close();
        resolveClosed(close);
        return;
      }
      failPendingRequests(new Error(`The client WebSocket disconnected (${close.code}).`));
      void reconnect();
    });
  };
  const restoreSubscriptions = async (): Promise<void> => {
    for (const subscription of subscriptionStates) {
      if (subscription.closed) continue;
      try {
        const response = await request({ kind: 'request', method: 'cdp.subscribe', parameters: subscription.request, protocolVersion: 1, requestId: crypto.randomUUID() }, true);
        if (response.method !== 'cdp.subscribe') throw new Error('Received an unexpected subscription response');
        subscriptions.delete(subscription.id);
        subscription.id = response.result.subscriptionId;
        subscriptions.set(subscription.id, subscription);
      } catch (error) {
        subscription.closed = true;
        subscriptions.delete(subscription.id);
        subscriptionStates.delete(subscription);
        subscription.events.close(error instanceof Error ? error : new Error('LEASE_REQUIRED'));
      }
    }
  };
  async function reconnect(): Promise<void> {
    if (reconnecting !== undefined || manuallyClosed) return reconnecting;
    reconnecting = (async () => {
      let delayMilliseconds = initialReconnectDelayMilliseconds;
      while (true) {
        if (manuallyClosed) return;
        try {
          const nextConnection = await connectBrowserClientWebSocket(options);
          attachConnection(nextConnection);
          await restoreSubscriptions();
          return;
        } catch {
          await wait(delayMilliseconds);
          delayMilliseconds = Math.min(maximumReconnectDelayMilliseconds, delayMilliseconds * 2);
        }
      }
    })().finally(() => reconnecting = undefined);
    return reconnecting;
  }
  attachConnection(connection);

  async function request(message: ClientToBrokerMessage, allowDuringReconnect = false): Promise<Extract<BrokerToClientMessage, { readonly kind: 'response' }>> {
    if (!allowDuringReconnect && reconnecting !== undefined) await reconnecting;
    if (manuallyClosed) throw new Error('The browser client is closed.');
    return new Promise((resolve, reject) => {
      const pendingRequest: PendingRequest = { reject, resolve };
      pendingRequests.set(message.requestId, pendingRequest);
      void connection.send(message).catch((error: unknown) => {
        pendingRequests.delete(message.requestId);
        reject(error instanceof Error ? error : new Error('Unable to send client request'));
      });
    });
  }

  const facade = createChromeDebuggerBridgeClient({
    async acquireLease(requestInput: AcquireLeaseRequest): Promise<Lease> {
      const response = await request({ kind: 'request', method: 'leases.acquire', parameters: { ...requestInput, mode: requestInput.mode ?? 'shared-read', requestedMethods: [...requestInput.requestedMethods] }, protocolVersion: 1, requestId: crypto.randomUUID() });
      if (response.method !== 'leases.acquire') throw new Error('Received an unexpected lease response');
      return response.result.lease;
    },
    async executeCommand(command: CdpCommand): Promise<CdpCommandResult> {
      const response = await request({ kind: 'request', method: 'cdp.send', parameters: command, protocolVersion: 1, requestId: crypto.randomUUID() });
      if (response.method !== 'cdp.send') throw new Error('Received an unexpected command response');
      return response.result;
    },
    async listTargets(): Promise<readonly PublishedTarget[]> {
      const response = await request({ kind: 'request', method: 'targets.list', parameters: {}, protocolVersion: 1, requestId: crypto.randomUUID() });
      if (response.method !== 'targets.list') throw new Error('Received an unexpected target response');
      return response.result.targets;
    },
    async releaseLease(requestInput: ReleaseLeaseRequest): Promise<void> {
      const response = await request({ kind: 'request', method: 'leases.release', parameters: requestInput, protocolVersion: 1, requestId: crypto.randomUUID() });
      if (response.method !== 'leases.release') throw new Error('Received an unexpected lease response');
    },
    async readArtifact(requestInput: ArtifactAccessRequest, signal?: AbortSignal): Promise<Uint8Array> {
      const endpoint = new URL(encodeURIComponent(requestInput.artifactId), options.artifactEndpoint);
      const response = await globalThis.fetch(endpoint, {
        headers: {
          authorization: options.authorization,
          ...(requestInput.range === undefined ? {} : { range: `bytes=${requestInput.range.offset}-${requestInput.range.offset + requestInput.range.length - 1}` }),
        },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new Error(`Artifact read failed with HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async releaseArtifact(): Promise<void> {
      /** HTTP artifact access is one-shot; the backing store releases each successful read. */
    },
    async renewLease(requestInput: RenewLeaseRequest): Promise<Lease> {
      const response = await request({ kind: 'request', method: 'leases.renew', parameters: requestInput, protocolVersion: 1, requestId: crypto.randomUUID() });
      if (response.method !== 'leases.renew') throw new Error('Received an unexpected lease response');
      return response.result.lease;
    },
    async subscribe(requestInput: CdpSubscriptionRequest): Promise<CdpSubscription> {
      const response = await request({ kind: 'request', method: 'cdp.subscribe', parameters: requestInput, protocolVersion: 1, requestId: crypto.randomUUID() });
      if (response.method !== 'cdp.subscribe') throw new Error('Received an unexpected subscription response');
      const subscriptionId = response.result.subscriptionId;
      const subscription: BrowserSubscriptionState = {
        closed: false,
        droppedCount: 0,
        events: createAsyncQueue<CdpEvent>(requestInput.buffer.capacity),
        id: subscriptionId,
        lastDeliveredSequence: 0,
        overflowed: false,
        request: requestInput,
      };
      subscriptions.set(subscriptionId, subscription);
      subscriptionStates.add(subscription);
      return {
        close() {
          subscription.closed = true;
          subscriptions.delete(subscription.id);
          subscriptionStates.delete(subscription);
          subscription.events.close();
          void request({ kind: 'request', method: 'cdp.unsubscribe', parameters: { subscriptionId: subscription.id }, protocolVersion: 1, requestId: crypto.randomUUID() }).catch(() => {});
        },
        get droppedCount() {
          return subscription.droppedCount;
        },
        get id() {
          return subscription.id;
        },
        get lastDeliveredSequence() {
          return subscription.lastDeliveredSequence;
        },
        get overflowed() {
          return subscription.overflowed;
        },
        targetGeneration: requestInput.targetGeneration,
        targetId: requestInput.targetId,
        [Symbol.asyncIterator]() {
          return subscription.events[Symbol.asyncIterator]();
        },
      };
    },
    watchTargets() {
      return targetChanges;
    },
  });
  return {
    ...facade,
    cancelCommand: async (requestInput) => {
      const response = await request({ kind: 'request', method: 'cdp.cancel', parameters: requestInput, protocolVersion: 1, requestId: crypto.randomUUID() });
      if (response.method !== 'cdp.cancel') throw new Error('Received an unexpected cancellation response');
    },
    close: (code, reason) => {
      manuallyClosed = true;
      connection.close(code, reason);
    },
    closed,
  };
}
