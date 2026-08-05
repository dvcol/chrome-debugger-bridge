import type {
  AgentAuthenticationMessage,
  AgentToBrokerMessage,
  BrokerToAgentMessage,
  BrokerToClientMessage,
  ClientToBrokerMessage,
} from '@dvcol/chrome-debugger-bridge/protocol';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { AgentAuthenticationTranscript, AuthenticatedFrame } from './authentication.js';

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';

import {
  agentAuthenticationMessageSchema,
  agentToBrokerMessageSchema,
  brokerToAgentMessageSchema,
  brokerToClientMessageSchema,
  clientToBrokerMessageSchema,
} from '@dvcol/chrome-debugger-bridge/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import {
  createAuthenticatedFrame,
  createBrokerAuthenticationProof,
  createRandomIdentifier,
  generateRandomBase64Url,
  importAgentCredential,
  openAuthenticatedFrame,
  verifyAgentAuthenticationProof,
} from './authentication.js';
import {
  agentWebSocketProtocol,
  clientWebSocketProtocol,
  isLoopbackHostname,
  validateWebSocketEndpointSecurity,
} from './protocols.js';

export { defaultArtifactHttpPath, mountAuthenticatedArtifactHttpEndpoint, type MountedAuthenticatedArtifactHttpEndpoint } from './artifact-http.js';
export { createHttpArtifactReader } from './artifact-reader.js';
export {
  type ArtifactTransferControl,
  type ArtifactTransferSocket,
  createArtifactTransferReceiver,
  decodeArtifactChunk,
  encodeArtifactChunk,
  streamArtifact,
} from './artifacts.js';
export { createFileArtifactStore, type FileArtifactStore, type FileArtifactStoreOptions } from './file-artifact-store.js';

export const defaultAgentWebSocketPath = '/__chrome_debugger_bridge/agent';
export const defaultClientWebSocketPath = '/__chrome_debugger_bridge/client';
export { agentWebSocketProtocol, clientWebSocketProtocol } from './protocols.js';

export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly role: 'agent' | 'client';
}

export interface BrokerAgentCredentialRecord {
  readonly agentId: string;
  readonly brokerId: string;
  readonly credential: Uint8Array;
  readonly credentialId: string;
  readonly principalId: string;
  readonly status: 'active' | 'pending';
}

export interface AgentCredentialIdentity {
  readonly agentId: string;
  readonly brokerId: string;
  readonly credentialId: string;
  readonly principalId: string;
}

export interface AgentAuthenticationAdapter<Principal extends AuthenticatedPrincipal> {
  activate: (
    record: BrokerAgentCredentialRecord,
    abortSignal: AbortSignal,
  ) => Promise<BrokerAgentCredentialRecord | undefined>;
  authenticate: (identity: AgentCredentialIdentity, abortSignal: AbortSignal) => Promise<Principal | undefined>;
  load: (credentialId: string, abortSignal: AbortSignal) => Promise<BrokerAgentCredentialRecord | undefined>;
  pair: (input: {
    readonly agentId: string;
    readonly brokerId: string;
    readonly credential: Uint8Array;
    readonly credentialId: string;
    readonly origin: string;
    readonly pairingCode: string;
    readonly abortSignal: AbortSignal;
  }) => Promise<BrokerAgentCredentialRecord | undefined>;
  revoke: (credentialId: string) => Promise<void>;
}

export interface ClientAuthenticationAdapter<Principal extends AuthenticatedPrincipal> {
  authenticate: (input: {
    readonly abortSignal: AbortSignal;
    readonly authorization: string | undefined;
    readonly endpointPath: string;
    readonly origin: string | undefined;
    readonly remoteAddress: string | undefined;
  }) => Promise<Principal | undefined>;
}

export interface TransportClaims {
  readonly endpointPath: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly role: 'agent' | 'client';
  readonly secure: boolean;
}

export interface AuthenticatedConnection<InboundMessage, OutboundMessage> {
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  close: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: InboundMessage) => void) => () => void;
  send: (message: OutboundMessage) => Promise<void>;
}

export interface AuthenticatedAgentConnection<Principal extends AuthenticatedPrincipal> {
  readonly connection: AuthenticatedConnection<AgentToBrokerMessage, BrokerToAgentMessage>;
  readonly connectionId: string;
  readonly credentialId: string;
  readonly principal: Principal;
  readonly transportClaims: TransportClaims;
}

export interface AuthenticatedClientConnection<Principal extends AuthenticatedPrincipal> {
  readonly connection: AuthenticatedConnection<ClientToBrokerMessage, BrokerToClientMessage>;
  readonly connectionId: string;
  readonly principal: Principal;
  readonly transportClaims: TransportClaims;
}

export interface WebSocketBridgeLimits {
  readonly handshakeTimeoutMilliseconds?: number;
  readonly maximumMessageBytes?: number;
  readonly maximumPreAuthenticationBytes?: number;
  readonly maximumPreAuthenticationMessages?: number;
  readonly maximumUnauthenticatedConnections?: number;
  readonly pairingTimeoutMilliseconds?: number;
}

export interface MountAuthenticatedWebSocketBridgeOptions<
  AgentPrincipal extends AuthenticatedPrincipal,
  ClientPrincipal extends AuthenticatedPrincipal,
> {
  readonly agentAuthentication: AgentAuthenticationAdapter<AgentPrincipal>;
  readonly agentPath?: string;
  readonly brokerId: string;
  readonly clientAuthentication: ClientAuthenticationAdapter<ClientPrincipal>;
  readonly clientPath?: string;
  readonly limits?: WebSocketBridgeLimits;
  readonly onAgentConnection: (connection: AuthenticatedAgentConnection<AgentPrincipal>) => void;
  readonly onClientConnection: (connection: AuthenticatedClientConnection<ClientPrincipal>) => void;
  readonly originPolicy: (input: TransportClaims, abortSignal: AbortSignal) => boolean | Promise<boolean>;
  readonly server: HttpServer;
}

export interface MountedAuthenticatedWebSocketBridge {
  close: () => Promise<void>;
  revokeAgentCredential: (credentialId: string) => Promise<void>;
}

export interface StandaloneAuthenticatedWebSocketBridge extends MountedAuthenticatedWebSocketBridge {
  readonly host: string;
  readonly port: number;
}

type ConnectionListener<Message> = (message: Message) => void;

const defaultLimits = {
  handshakeTimeoutMilliseconds: 5_000,
  maximumMessageBytes: 16 * 1_024,
  maximumPreAuthenticationBytes: 16 * 1_024,
  maximumPreAuthenticationMessages: 4,
  maximumUnauthenticatedConnections: 8,
  pairingTimeoutMilliseconds: 5 * 60_000,
} as const;
const maximumPendingAuthenticatedMessages = 32;
const base64PaddingPattern = /=+$/u;
const base64UrlPattern = /^[\w-]+$/u;

async function createClosedPromise(webSocket: WebSocket): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise(resolve => webSocket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

function validatePath(path: string): void {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error(`Invalid WebSocket endpoint path: ${path}`);
  }
}

function getRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

function getTransportClaims(
  request: IncomingMessage,
  endpointPath: string,
  role: TransportClaims['role'],
): TransportClaims {
  const originHeader = request.headers.origin;
  const hostHeader = request.headers.host;
  return {
    endpointPath,
    host: typeof hostHeader === 'string' ? hostHeader : undefined,
    origin: typeof originHeader === 'string' ? originHeader : undefined,
    remoteAddress: request.socket.remoteAddress,
    role,
    secure: 'encrypted' in request.socket && request.socket.encrypted === true,
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '::1'
    || address?.startsWith('127.') === true
    || address?.startsWith('::ffff:127.') === true;
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  if (socket.destroyed) {
    return;
  }
  socket.end(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function raceWithAbort<Value>(operation: Promise<Value>, abortSignal: AbortSignal): Promise<Value> {
  if (abortSignal.aborted) {
    throw new Error('Upgrade authentication aborted');
  }
  return new Promise<Value>((resolve, reject) => {
    const handleAbort = (): void => reject(new Error('Upgrade authentication aborted'));
    abortSignal.addEventListener('abort', handleAbort, { once: true });
    void operation.then(
      (value) => {
        abortSignal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', handleAbort);
        reject(error instanceof Error ? error : new Error('Upgrade authentication failed'));
      },
    );
  });
}

async function validateAuthenticationMessage(source: string): Promise<AgentAuthenticationMessage> {
  const parsed = JSON.parse(source) as unknown;
  const result = await agentAuthenticationMessageSchema['~standard'].validate(parsed);
  if ('issues' in result) {
    throw new Error('Invalid authentication message');
  }
  return result.value;
}

function sendAuthenticationError(
  webSocket: WebSocket,
  request: AgentAuthenticationMessage | undefined,
): void {
  if (webSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (request?.kind !== 'request') {
    webSocket.close(1008, 'Authentication failed');
    return;
  }
  const response: AgentAuthenticationMessage = {
    error: {
      code: 'AUTHENTICATION_FAILED',
      message: 'Authentication failed',
      retryable: false,
    },
    kind: 'error',
    method: request.method,
    protocolVersion: 1,
    requestId: request.requestId,
  };
  webSocket.send(JSON.stringify(response), () => webSocket.close(1008, 'Authentication failed'));
}

function credentialsMatch(first: Uint8Array, second: Uint8Array): boolean {
  if (first.byteLength !== second.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < first.byteLength; index += 1) {
    difference |= first[index]! ^ second[index]!;
  }
  return difference === 0;
}

function getCredentialIdentity(record: BrokerAgentCredentialRecord): AgentCredentialIdentity {
  return {
    agentId: record.agentId,
    brokerId: record.brokerId,
    credentialId: record.credentialId,
    principalId: record.principalId,
  };
}

function getExpectedWebSocketProtocol(role: TransportClaims['role']): string {
  return role === 'agent' ? agentWebSocketProtocol : clientWebSocketProtocol;
}

function hasExpectedWebSocketProtocol(request: IncomingMessage, role: TransportClaims['role']): boolean {
  const protocolHeader = request.headers['sec-websocket-protocol'];
  return typeof protocolHeader === 'string'
    && protocolHeader.split(',').map(protocol => protocol.trim()).includes(getExpectedWebSocketProtocol(role));
}

function getBrowserClientAuthorization(request: IncomingMessage): string | undefined {
  const protocolHeader = request.headers['sec-websocket-protocol'];
  if (typeof protocolHeader !== 'string') return undefined;
  const encodedAuthorization = protocolHeader.split(',')
    .map(protocol => protocol.trim())
    .find(protocol => protocol.startsWith('chrome-debugger-bridge.authorization.'))
    ?.slice('chrome-debugger-bridge.authorization.'.length);
  if (encodedAuthorization === undefined || !base64UrlPattern.test(encodedAuthorization)) return undefined;
  try {
    const authorization = Buffer.from(encodedAuthorization, 'base64url').toString('utf8');
    return authorization.length === 0 ? undefined : authorization;
  } catch {
    return undefined;
  }
}

function createBrokerClientConnection(
  webSocket: WebSocket,
): AuthenticatedConnection<ClientToBrokerMessage, BrokerToClientMessage> {
  const listeners = new Set<ConnectionListener<ClientToBrokerMessage>>();
  const closed = createClosedPromise(webSocket);
  let pendingMessages = 0;
  let pendingReceive = Promise.resolve();
  let receiveFailed = false;
  webSocket.once('close', () => listeners.clear());
  webSocket.on('message', (data, isBinary) => {
    if (receiveFailed) {
      return;
    }
    if (isBinary) {
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
      if (receiveFailed) {
        return;
      }
      const parsed = JSON.parse(data.toString()) as unknown;
      const result = await clientToBrokerMessageSchema['~standard'].validate(parsed);
      if ('issues' in result) {
        throw new Error('Invalid client-plane message');
      }
      for (const listener of listeners) {
        listener(result.value);
      }
    }).catch(() => {
      receiveFailed = true;
      webSocket.close(1008, 'Invalid client message');
    }).finally(() => pendingMessages -= 1);
  });
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
      const validation = await brokerToClientMessageSchema['~standard'].validate(message);
      if ('issues' in validation) {
        throw new Error('Cannot send an invalid client-plane message');
      }
      await new Promise<void>((resolve, reject) => {
        webSocket.send(JSON.stringify(validation.value), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function createNodeClientConnection(
  webSocket: WebSocket,
): AuthenticatedConnection<BrokerToClientMessage, ClientToBrokerMessage> {
  const listeners = new Set<ConnectionListener<BrokerToClientMessage>>();
  const closed = createClosedPromise(webSocket);
  let pendingMessages = 0;
  let pendingReceive = Promise.resolve();
  let receiveFailed = false;
  webSocket.once('close', () => listeners.clear());
  webSocket.on('message', (data, isBinary) => {
    if (receiveFailed) {
      return;
    }
    if (isBinary) {
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
      if (receiveFailed) {
        return;
      }
      const parsed = JSON.parse(data.toString()) as unknown;
      const result = await brokerToClientMessageSchema['~standard'].validate(parsed);
      if ('issues' in result) {
        throw new Error('Invalid broker-to-client message');
      }
      for (const listener of listeners) {
        listener(result.value);
      }
    }).catch(() => {
      receiveFailed = true;
      webSocket.close(1008, 'Invalid broker message');
    }).finally(() => pendingMessages -= 1);
  });
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
      const validation = await clientToBrokerMessageSchema['~standard'].validate(message);
      if ('issues' in validation) {
        throw new Error('Cannot send an invalid client-to-broker message');
      }
      await new Promise<void>((resolve, reject) => {
        webSocket.send(JSON.stringify(validation.value), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

interface AgentAuthenticationState<Principal extends AuthenticatedPrincipal> {
  credentialKey: CryptoKey | undefined;
  credentialRecord: BrokerAgentCredentialRecord | undefined;
  principal: Principal | undefined;
  request: AgentAuthenticationMessage | undefined;
  stage: 'begin' | 'finish' | 'pairing';
  transcript: AgentAuthenticationTranscript | undefined;
}

function createAgentConnection(
  webSocket: WebSocket,
  credentialKey: CryptoKey,
  transcript: AgentAuthenticationTranscript,
  initialMessages: readonly { readonly data: Buffer; readonly isBinary: boolean }[] = [],
): AuthenticatedConnection<AgentToBrokerMessage, BrokerToAgentMessage> {
  const listeners = new Set<ConnectionListener<AgentToBrokerMessage>>();
  const closed = createClosedPromise(webSocket);
  let inboundSequence = 1;
  let outboundSequence = 1;
  let pendingMessages = 0;
  let pendingReceive = Promise.resolve();
  let pendingSend = Promise.resolve();
  let receiveFailed = false;

  const handleMessage = (data: Buffer, isBinary: boolean): void => {
    if (receiveFailed) {
      return;
    }
    if (isBinary) {
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
      if (receiveFailed) {
        return;
      }
      const frame = JSON.parse(data.toString()) as AuthenticatedFrame;
      const payload = await openAuthenticatedFrame(
        credentialKey,
        transcript,
        'agent-to-broker',
        inboundSequence,
        frame,
      );
      const result = await agentToBrokerMessageSchema['~standard'].validate(payload);
      if ('issues' in result) {
        throw new Error('Invalid agent-plane message');
      }
      inboundSequence += 1;
      for (const listener of listeners) {
        listener(result.value);
      }
    }).catch(() => {
      receiveFailed = true;
      webSocket.close(1008, 'Invalid authenticated message');
    }).finally(() => pendingMessages -= 1);
  };
  webSocket.on('message', handleMessage);
  for (const message of initialMessages) {
    handleMessage(message.data, message.isBinary);
  }
  webSocket.once('close', () => listeners.clear());

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
      pendingSend = pendingSend.then(async () => {
        const validation = await brokerToAgentMessageSchema['~standard'].validate(message);
        if ('issues' in validation) {
          throw new Error('Cannot send an invalid agent-plane message');
        }
        const frame = await createAuthenticatedFrame(
          credentialKey,
          transcript,
          'broker-to-agent',
          outboundSequence,
          validation.value,
        );
        await new Promise<void>((resolve, reject) => {
          webSocket.send(JSON.stringify(frame), (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        outboundSequence += 1;
      });
      await pendingSend;
    },
  };
}

function attachAgentAuthentication<Principal extends AuthenticatedPrincipal>(input: {
  readonly adapter: AgentAuthenticationAdapter<Principal>;
  readonly brokerId: string;
  readonly claims: TransportClaims;
  readonly isCredentialRevoked: (credentialId: string) => boolean;
  readonly limits: Required<WebSocketBridgeLimits>;
  readonly onAuthenticated: (connection: AuthenticatedAgentConnection<Principal>) => void;
  readonly onReleased: () => void;
  readonly registerCredentialConnection: (credentialId: string, webSocket: WebSocket) => void;
  readonly revokeCredential: (credentialId: string) => Promise<void>;
  readonly webSocket: WebSocket;
}): void {
  const { webSocket } = input;
  const state: AgentAuthenticationState<Principal> = {
    credentialKey: undefined,
    credentialRecord: undefined,
    principal: undefined,
    request: undefined,
    stage: 'begin',
    transcript: undefined,
  };
  const authenticationAbortController = new AbortController();
  let cumulativeBytes = 0;
  let messageCount = 0;
  let released = false;
  let authenticationComplete = false;
  let authenticationAccepted = false;
  let authenticationFailed = false;
  let authenticationQueue = Promise.resolve();
  let provisionalCredentialId: string | undefined;
  const ensureCredentialAvailable = (credentialId: string): void => {
    if (input.isCredentialRevoked(credentialId)) {
      throw new Error('Authentication failed');
    }
  };
  const ensureAuthenticationOpen = (): void => {
    if (authenticationFailed || webSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Authentication connection is closed');
    }
  };
  const release = (): void => {
    if (!released) {
      released = true;
      input.onReleased();
    }
  };
  let timeout: ReturnType<typeof setTimeout>;
  const resetAuthenticationTimeout = (timeoutMilliseconds: number): void => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      authenticationFailed = true;
      authenticationAbortController.abort();
      webSocket.close(1008, 'Authentication timed out');
    }, timeoutMilliseconds);
  };
  resetAuthenticationTimeout(input.limits.handshakeTimeoutMilliseconds);
  webSocket.once('close', () => {
    if (!authenticationAccepted) {
      authenticationFailed = true;
      authenticationAbortController.abort();
      const credentialIdToRevoke = provisionalCredentialId
        ?? (!authenticationComplete && state.credentialRecord?.status === 'pending'
          ? state.credentialRecord.credentialId
          : undefined);
      if (credentialIdToRevoke !== undefined) {
        void input.revokeCredential(credentialIdToRevoke).catch(() => {
          /** The host owns persistence diagnostics; transport cleanup remains best-effort. */
        });
      }
    }
    clearTimeout(timeout);
    release();
  });

  const handleAuthenticationMessage = (data: Buffer, isBinary: boolean): void => {
    if (authenticationComplete || authenticationFailed) {
      return;
    }
    cumulativeBytes += data.byteLength;
    messageCount += 1;
    if (
      isBinary
      || cumulativeBytes > input.limits.maximumPreAuthenticationBytes
      || messageCount > input.limits.maximumPreAuthenticationMessages
    ) {
      authenticationFailed = true;
      sendAuthenticationError(webSocket, state.request);
      return;
    }
    authenticationQueue = authenticationQueue.then(async () => {
      if (authenticationComplete || authenticationFailed) {
        return;
      }

      const message = await validateAuthenticationMessage(data.toString());
      state.request = message;
      if (state.stage === 'begin') {
        if (message.kind !== 'request' || message.method !== 'agent.auth.begin') {
          throw new Error('Authentication must begin with agent.auth.begin');
        }
        if (
          message.parameters.role !== 'agent'
          || message.parameters.endpointPath !== input.claims.endpointPath
          || message.parameters.origin !== input.claims.origin
          || (message.parameters.expectedBrokerId !== undefined && message.parameters.expectedBrokerId !== input.brokerId)
        ) {
          throw new Error('Authentication context is invalid');
        }
        if (message.parameters.credentialId !== undefined) {
          ensureCredentialAvailable(message.parameters.credentialId);
        }
        const credentialRecord = message.parameters.credentialId === undefined
          ? undefined
          : await raceWithAbort(
              input.adapter.load(message.parameters.credentialId, authenticationAbortController.signal),
              authenticationAbortController.signal,
            );
        ensureAuthenticationOpen();
        if (message.parameters.credentialId !== undefined) {
          ensureCredentialAvailable(message.parameters.credentialId);
        }
        if (message.parameters.credentialId !== undefined && (
          credentialRecord?.status !== 'active'
          || credentialRecord.agentId !== message.parameters.agentId
          || credentialRecord.brokerId !== input.brokerId
        )) {
          throw new Error('Authentication failed');
        }
        const validCredential = credentialRecord?.status === 'active'
          && credentialRecord.agentId === message.parameters.agentId
          && credentialRecord.brokerId === input.brokerId
          ? credentialRecord
          : undefined;
        const connectionId = createRandomIdentifier();
        const authenticationTimeoutMilliseconds = validCredential === undefined
          ? input.limits.pairingTimeoutMilliseconds
          : input.limits.handshakeTimeoutMilliseconds;
        resetAuthenticationTimeout(authenticationTimeoutMilliseconds);
        const expiresAt = new Date(Date.now() + authenticationTimeoutMilliseconds).toISOString();
        state.credentialRecord = validCredential;
        state.transcript = {
          agentId: message.parameters.agentId,
          brokerId: input.brokerId,
          clientNonce: message.parameters.clientNonce,
          connectionId,
          credentialId: validCredential?.credentialId ?? createRandomIdentifier(),
          endpointPath: input.claims.endpointPath,
          expiresAt,
          origin: input.claims.origin ?? '',
          protocolVersion: 1,
          serverNonce: generateRandomBase64Url(32),
        };
        ensureCredentialAvailable(state.transcript.credentialId);
        if (validCredential !== undefined) {
          input.registerCredentialConnection(validCredential.credentialId, webSocket);
        }
        state.stage = validCredential === undefined ? 'pairing' : 'finish';
        const response: AgentAuthenticationMessage = {
          kind: 'response',
          method: 'agent.auth.begin',
          protocolVersion: 1,
          requestId: message.requestId,
          result: {
            brokerId: input.brokerId,
            connectionId,
            credentialId: validCredential?.credentialId,
            endpointPath: input.claims.endpointPath,
            expiresAt,
            pairingRequired: validCredential === undefined,
            protocolVersion: 1,
            serverNonce: state.transcript.serverNonce,
          },
        };
        webSocket.send(JSON.stringify(response));
        return;
      }

      if (state.stage === 'pairing') {
        if (message.kind !== 'request' || message.method !== 'agent.pair.finish' || state.transcript === undefined) {
          throw new Error('Expected agent.pair.finish');
        }
        if (message.parameters.connectionId !== state.transcript.connectionId) {
          throw new Error('Pairing challenge is invalid');
        }
        const credential = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const pairingOperation = input.adapter.pair({
          abortSignal: authenticationAbortController.signal,
          agentId: state.transcript.agentId,
          brokerId: input.brokerId,
          credential,
          credentialId: state.transcript.credentialId,
          origin: state.transcript.origin,
          pairingCode: message.parameters.pairingCode,
        });
        void pairingOperation.then(async (record) => {
          if (authenticationAbortController.signal.aborted && record !== undefined) {
            return input.revokeCredential(record.credentialId);
          }
        }).catch(() => {});
        const credentialRecord = await raceWithAbort(pairingOperation, authenticationAbortController.signal);
        if (authenticationFailed || webSocket.readyState !== WebSocket.OPEN) {
          if (credentialRecord !== undefined) {
            await input.revokeCredential(credentialRecord.credentialId);
          }
          ensureAuthenticationOpen();
        }
        if (
          credentialRecord === undefined
          || credentialRecord.status !== 'pending'
          || credentialRecord.agentId !== state.transcript.agentId
          || credentialRecord.brokerId !== input.brokerId
          || credentialRecord.credentialId !== state.transcript.credentialId
          || !credentialsMatch(credentialRecord.credential, credential)
        ) {
          throw new Error('Authentication failed');
        }
        state.credentialRecord = credentialRecord;
        provisionalCredentialId = credentialRecord.credentialId;
        ensureCredentialAvailable(credentialRecord.credentialId);
        input.registerCredentialConnection(credentialRecord.credentialId, webSocket);
        state.credentialKey = await importAgentCredential(credentialRecord.credential);
        state.stage = 'finish';
        const response: AgentAuthenticationMessage = {
          kind: 'response',
          method: 'agent.pair.finish',
          protocolVersion: 1,
          requestId: message.requestId,
          result: {
            brokerId: input.brokerId,
            credential: generateCredentialEncoding(credentialRecord.credential),
            credentialId: credentialRecord.credentialId,
          },
        };
        webSocket.send(JSON.stringify(response));
        return;
      }

      if (message.kind !== 'request' || message.method !== 'agent.auth.finish' || state.transcript === undefined) {
        throw new Error('Expected agent.auth.finish');
      }
      const credentialRecord = state.credentialRecord;
      if (
        credentialRecord === undefined
        || message.parameters.connectionId !== state.transcript.connectionId
        || message.parameters.credentialId !== credentialRecord.credentialId
        || Date.now() > Date.parse(state.transcript.expiresAt)
      ) {
        throw new Error('Authentication failed');
      }
      const credentialKey = state.credentialKey ?? await importAgentCredential(credentialRecord.credential);
      if (!await verifyAgentAuthenticationProof(credentialKey, state.transcript, message.parameters.proof)) {
        throw new Error('Authentication failed');
      }
      ensureAuthenticationOpen();
      ensureCredentialAvailable(credentialRecord.credentialId);
      const authenticatedPrincipal = credentialRecord.status === 'active'
        ? await raceWithAbort(
            input.adapter.authenticate(getCredentialIdentity(credentialRecord), authenticationAbortController.signal),
            authenticationAbortController.signal,
          )
        : undefined;
      ensureAuthenticationOpen();
      ensureCredentialAvailable(credentialRecord.credentialId);
      if (credentialRecord.status === 'active' && (
        authenticatedPrincipal === undefined
        || authenticatedPrincipal.role !== 'agent'
        || authenticatedPrincipal.id !== credentialRecord.principalId
      )) {
        throw new Error('Authentication failed');
      }
      const brokerClaims = {
        connectionGeneration: 1,
        principalId: credentialRecord.principalId,
      } as const;
      const brokerProof = await createBrokerAuthenticationProof(credentialKey, state.transcript, brokerClaims);
      ensureAuthenticationOpen();
      authenticationComplete = true;
      webSocket.off('message', handleAuthenticationMessage);
      const pendingMessages: { readonly data: Buffer; readonly isBinary: boolean }[] = [];
      let pendingMessageBytes = 0;
      const bufferPendingMessage = (data: Buffer, isBinary: boolean): void => {
        pendingMessageBytes += data.byteLength;
        if (
          pendingMessages.length >= maximumPendingAuthenticatedMessages
          || pendingMessageBytes > input.limits.maximumMessageBytes * maximumPendingAuthenticatedMessages
        ) {
          authenticationFailed = true;
          webSocket.close(1008, 'Too many pending messages');
          return;
        }
        pendingMessages.push({ data, isBinary });
      };
      webSocket.on('message', bufferPendingMessage);
      const response: AgentAuthenticationMessage = {
        kind: 'response',
        method: 'agent.auth.finish',
        protocolVersion: 1,
        requestId: message.requestId,
        result: {
          brokerProof,
          connectionGeneration: brokerClaims.connectionGeneration,
          connectionId: state.transcript.connectionId,
          principalId: brokerClaims.principalId,
        },
      };
      await new Promise<void>((resolve, reject) => {
        webSocket.send(JSON.stringify(response), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      ensureAuthenticationOpen();
      ensureCredentialAvailable(credentialRecord.credentialId);
      const activationOperation = credentialRecord.status === 'pending'
        ? input.adapter.activate(credentialRecord, authenticationAbortController.signal)
        : Promise.resolve(credentialRecord);
      void activationOperation.then(async (record) => {
        if (authenticationAbortController.signal.aborted && record !== undefined && credentialRecord.status === 'pending') {
          return input.revokeCredential(record.credentialId);
        }
      }).catch(() => {});
      const activeCredentialRecord = await raceWithAbort(activationOperation, authenticationAbortController.signal);
      ensureAuthenticationOpen();
      ensureCredentialAvailable(credentialRecord.credentialId);
      if (
        activeCredentialRecord?.status !== 'active'
        || activeCredentialRecord.agentId !== credentialRecord.agentId
        || activeCredentialRecord.brokerId !== credentialRecord.brokerId
        || activeCredentialRecord.credentialId !== credentialRecord.credentialId
        || activeCredentialRecord.principalId !== credentialRecord.principalId
        || !credentialsMatch(activeCredentialRecord.credential, credentialRecord.credential)
      ) {
        throw new Error('Authentication failed');
      }
      const principal = authenticatedPrincipal ?? await raceWithAbort(
        input.adapter.authenticate(getCredentialIdentity(activeCredentialRecord), authenticationAbortController.signal),
        authenticationAbortController.signal,
      );
      ensureAuthenticationOpen();
      ensureCredentialAvailable(activeCredentialRecord.credentialId);
      if (principal === undefined || principal.role !== 'agent' || principal.id !== activeCredentialRecord.principalId) {
        if (credentialRecord.status === 'pending') {
          await input.revokeCredential(activeCredentialRecord.credentialId);
        }
        throw new Error('Authentication failed');
      }
      state.credentialRecord = activeCredentialRecord;
      state.principal = principal;
      webSocket.off('message', bufferPendingMessage);
      const connection = createAgentConnection(webSocket, credentialKey, state.transcript, pendingMessages);
      try {
        input.onAuthenticated({
          connection,
          connectionId: state.transcript.connectionId,
          credentialId: activeCredentialRecord.credentialId,
          principal,
          transportClaims: input.claims,
        });
      } catch {
        if (credentialRecord.status === 'pending') {
          await input.revokeCredential(activeCredentialRecord.credentialId);
        }
        webSocket.close(1011, 'Broker connection setup failed');
        return;
      }
      authenticationAccepted = true;
      provisionalCredentialId = undefined;
      clearTimeout(timeout);
      release();
    }).catch(() => {
      authenticationFailed = true;
      sendAuthenticationError(webSocket, state.request);
    });
  };

  webSocket.on('message', handleAuthenticationMessage);
}

function generateCredentialEncoding(credential: Uint8Array): string {
  let binary = '';
  for (const byte of credential) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(base64PaddingPattern, '');
}

export function mountAuthenticatedWebSocketBridge<
  AgentPrincipal extends AuthenticatedPrincipal,
  ClientPrincipal extends AuthenticatedPrincipal,
>(
  options: MountAuthenticatedWebSocketBridgeOptions<AgentPrincipal, ClientPrincipal>,
): MountedAuthenticatedWebSocketBridge {
  const agentPath = options.agentPath ?? defaultAgentWebSocketPath;
  const clientPath = options.clientPath ?? defaultClientWebSocketPath;
  validatePath(agentPath);
  validatePath(clientPath);
  if (agentPath === clientPath) {
    throw new Error('Agent and client WebSocket paths must be distinct');
  }
  const limits = { ...defaultLimits, ...options.limits };
  const webSocketServer = new WebSocketServer({
    maxPayload: limits.maximumMessageBytes,
    noServer: true,
    perMessageDeflate: false,
  });
  const unauthenticatedConnections = new Set<WebSocket>();
  const pendingUpgrades = new Map<Duplex, AbortController>();
  const agentConnectionsByCredential = new Map<string, Set<WebSocket>>();
  const revokedCredentialIds = new Set<string>();
  const credentialRevocations = new Map<string, Promise<void>>();
  const allConnections = new Set<WebSocket>();
  let closing = false;

  const revokeCredential = async (credentialId: string): Promise<void> => {
    revokedCredentialIds.add(credentialId);
    const credentialConnections = agentConnectionsByCredential.get(credentialId);
    agentConnectionsByCredential.delete(credentialId);
    for (const webSocket of credentialConnections ?? []) {
      webSocket.close(1008, 'Credential revoked');
    }
    const existingRevocation = credentialRevocations.get(credentialId);
    if (existingRevocation !== undefined) {
      await existingRevocation;
      return;
    }
    const revocation = options.agentAuthentication.revoke(credentialId);
    credentialRevocations.set(credentialId, revocation);
    void revocation.finally(() => credentialRevocations.delete(credentialId)).catch(() => {});
    await revocation;
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (
      closing
      || pendingUpgrades.size + unauthenticatedConnections.size >= limits.maximumUnauthenticatedConnections
    ) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const upgradeAbortController = new AbortController();
    pendingUpgrades.set(socket, upgradeAbortController);
    const upgradeTimeout = setTimeout(() => {
      upgradeAbortController.abort();
      rejectUpgrade(socket, 408, 'Request Timeout');
    }, limits.handshakeTimeoutMilliseconds);
    void (async () => {
      try {
        const requestUrl = getRequestUrl(request);
        const endpointPath = requestUrl.pathname;
        const role = endpointPath === agentPath ? 'agent' : endpointPath === clientPath ? 'client' : undefined;
        if (role === undefined || requestUrl.search || requestUrl.hash) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        if (!hasExpectedWebSocketProtocol(request, role)) {
          rejectUpgrade(socket, 400, 'Bad Request');
          return;
        }
        const claims = getTransportClaims(request, endpointPath, role);
        if (!claims.secure && !isLoopbackAddress(request.socket.localAddress)) {
          rejectUpgrade(socket, 403, 'Forbidden');
          return;
        }
        if (!await raceWithAbort(
          Promise.resolve(options.originPolicy(claims, upgradeAbortController.signal)),
          upgradeAbortController.signal,
        )) {
          rejectUpgrade(socket, 403, 'Forbidden');
          return;
        }

        let clientPrincipal: ClientPrincipal | undefined;
        if (role === 'client') {
          const authorizationHeader = request.headers.authorization;
          clientPrincipal = await raceWithAbort(options.clientAuthentication.authenticate({
            abortSignal: upgradeAbortController.signal,
            authorization: typeof authorizationHeader === 'string' ? authorizationHeader : getBrowserClientAuthorization(request),
            endpointPath,
            origin: claims.origin,
            remoteAddress: claims.remoteAddress,
          }), upgradeAbortController.signal);
          if (clientPrincipal === undefined || clientPrincipal.role !== 'client') {
            rejectUpgrade(socket, 401, 'Unauthorized');
            return;
          }
        }
        if (closing || upgradeAbortController.signal.aborted || socket.destroyed) {
          return;
        }

        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          allConnections.add(webSocket);
          webSocket.on('error', () => {
          /** Protocol errors are reflected through the close code; diagnostics remain host-owned. */
          });
          webSocket.once('close', () => {
            allConnections.delete(webSocket);
            unauthenticatedConnections.delete(webSocket);
            for (const connections of agentConnectionsByCredential.values()) {
              connections.delete(webSocket);
            }
          });

          if (role === 'client') {
            const principal = clientPrincipal!;
            options.onClientConnection({
              connection: createBrokerClientConnection(webSocket),
              connectionId: createRandomIdentifier(),
              principal,
              transportClaims: claims,
            });
            return;
          }

          unauthenticatedConnections.add(webSocket);
          attachAgentAuthentication({
            adapter: options.agentAuthentication,
            brokerId: options.brokerId,
            claims,
            isCredentialRevoked: credentialId => revokedCredentialIds.has(credentialId),
            limits,
            onAuthenticated: options.onAgentConnection,
            onReleased: () => unauthenticatedConnections.delete(webSocket),
            registerCredentialConnection(credentialId, liveWebSocket) {
              const connections = agentConnectionsByCredential.get(credentialId) ?? new Set<WebSocket>();
              connections.add(liveWebSocket);
              agentConnectionsByCredential.set(credentialId, connections);
            },
            revokeCredential,
            webSocket,
          });
        });
      } catch {
        if (!upgradeAbortController.signal.aborted) {
          rejectUpgrade(socket, 500, 'Internal Server Error');
        }
      } finally {
        clearTimeout(upgradeTimeout);
        pendingUpgrades.delete(socket);
      }
    })();
  };

  options.server.on('upgrade', handleUpgrade);

  return {
    async close() {
      closing = true;
      options.server.off('upgrade', handleUpgrade);
      for (const [socket, abortController] of pendingUpgrades) {
        abortController.abort();
        rejectUpgrade(socket, 503, 'Service Unavailable');
      }
      for (const webSocket of allConnections) {
        webSocket.close(1001, 'Server shutting down');
      }
      await new Promise<void>(resolve => webSocketServer.close(() => resolve()));
      await Promise.allSettled(credentialRevocations.values());
    },
    async revokeAgentCredential(credentialId) {
      await revokeCredential(credentialId);
    },
  };
}

export async function createStandaloneAuthenticatedWebSocketBridge<
  AgentPrincipal extends AuthenticatedPrincipal,
  ClientPrincipal extends AuthenticatedPrincipal,
>(
  options: Omit<MountAuthenticatedWebSocketBridgeOptions<AgentPrincipal, ClientPrincipal>, 'server'> & {
    readonly host?: string;
    readonly port?: number;
  },
): Promise<StandaloneAuthenticatedWebSocketBridge> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHostname(host === '::1' ? '[::1]' : host)) {
    throw new Error('The standalone WebSocket broker must bind to a loopback host');
  }
  const server = createServer();
  const mounted = mountAuthenticatedWebSocketBridge({ ...options, server });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Standalone WebSocket server did not expose a TCP address');
  }
  return {
    ...mounted,
    host,
    port: address.port,
    async close() {
      await mounted.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export type NodeClientConnection = AuthenticatedConnection<BrokerToClientMessage, ClientToBrokerMessage>;

export async function connectNodeClientWebSocket(options: {
  readonly authorization: string;
  readonly endpoint: string;
  readonly origin?: string;
}): Promise<NodeClientConnection> {
  const endpointUrl = new URL(options.endpoint);
  validateWebSocketEndpointSecurity(endpointUrl);
  if (endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
    throw new Error('The client WebSocket endpoint must not contain credentials, query parameters, or fragments');
  }
  const webSocket = new WebSocket(endpointUrl, clientWebSocketProtocol, {
    headers: {
      authorization: options.authorization,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    webSocket.once('open', resolve);
    webSocket.once('error', reject);
    webSocket.once('unexpected-response', (_request, response) => reject(new Error(`WebSocket rejected with ${response.statusCode}`)));
  });
  if (webSocket.protocol !== clientWebSocketProtocol) {
    webSocket.close(1002, 'Invalid WebSocket subprotocol');
    throw new Error('The broker selected an invalid WebSocket subprotocol');
  }
  return createNodeClientConnection(webSocket);
}
