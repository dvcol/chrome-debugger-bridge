import type {
  AgentAuthenticationMessage,
  AgentToBrokerMessage,
  BrokerToAgentMessage,
  ProtocolVersionRange,
} from '@dvcol/chrome-debugger-bridge/protocol';

import type { AgentAuthenticationTranscript, AuthenticatedFrame } from './authentication.js';

import {
  agentAuthenticationMessageSchema,
  agentToBrokerMessageSchema,
  brokerToAgentMessageSchema,
} from '@dvcol/chrome-debugger-bridge/protocol';

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
import { agentWebSocketProtocol, validateWebSocketEndpointSecurity } from './protocols.js';

export { createHttpArtifactReader } from './artifact-reader.js';
export {
  type ArtifactTransferControl,
  type ArtifactTransferSocket,
  createArtifactTransferReceiver,
  decodeArtifactChunk,
  encodeArtifactChunk,
  streamArtifact,
} from './artifacts.js';

export const defaultAgentWebSocketPath = '/__chrome_debugger_bridge/agent';
export { agentWebSocketProtocol } from './protocols.js';
const maximumPendingAuthenticatedMessages = 32;

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
