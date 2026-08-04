import { agentWebSocketProtocol } from './protocols.js';

const authenticationDomain = 'chrome-debugger-bridge/auth/v1';
const authenticatedFrameDomain = 'chrome-debugger-bridge/frame/v1';
const base64PaddingPattern = /=+$/u;
const textEncoder = new TextEncoder();

export type AuthenticatedFrameDirection = 'agent-to-broker' | 'broker-to-agent';

export interface AgentAuthenticationTranscript {
  readonly agentId: string;
  readonly brokerId: string;
  readonly clientNonce: string;
  readonly connectionId: string;
  readonly credentialId: string;
  readonly endpointPath: string;
  readonly expiresAt: string;
  readonly origin: string;
  readonly protocolVersion: number;
  readonly serverNonce: string;
}

export interface AuthenticatedFrame {
  readonly authenticationCode: string;
  readonly connectionId: string;
  readonly direction: AuthenticatedFrameDirection;
  readonly kind: 'authenticated';
  readonly payload: string;
  readonly sequence: number;
}

export interface BrokerAuthenticationClaims {
  readonly connectionGeneration: number;
  readonly principalId: string;
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(base64PaddingPattern, '');
}

export function decodeBase64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat(paddingLength)}`;
  const binary = globalThis.atob(base64);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || encodeBase64UrlBytes(bytes) !== value) {
    throw new Error('Expected a canonical 32-byte base64url value');
  }
  return bytes;
}

export function generateRandomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64UrlBytes(bytes);
}

export function createRandomIdentifier(): string {
  return globalThis.crypto.randomUUID();
}

export async function importAgentCredential(credential: Uint8Array): Promise<CryptoKey> {
  if (credential.byteLength !== 32) {
    throw new Error('Agent credentials must contain exactly 32 bytes');
  }
  return globalThis.crypto.subtle.importKey('raw', Uint8Array.from(credential), 'HKDF', false, ['deriveKey']);
}

function createBaseAuthenticationTranscript(transcript: AgentAuthenticationTranscript): readonly unknown[] {
  return [
    authenticationDomain,
    agentWebSocketProtocol,
    'agent',
    transcript.endpointPath,
    transcript.origin,
    transcript.brokerId,
    transcript.agentId,
    transcript.credentialId,
    transcript.connectionId,
    transcript.protocolVersion,
    transcript.clientNonce,
    transcript.serverNonce,
    transcript.expiresAt,
  ];
}

function createAuthenticationTranscriptBytes(
  transcript: AgentAuthenticationTranscript,
  proofDirection: 'agent' | 'broker',
  brokerClaims?: BrokerAuthenticationClaims,
): Uint8Array<ArrayBuffer> {
  /** A fixed primitive tuple is already in RFC 8785 canonical order and avoids object-key ambiguity. */
  return textEncoder.encode(JSON.stringify([
    ...createBaseAuthenticationTranscript(transcript),
    proofDirection,
    ...(brokerClaims === undefined ? [] : [brokerClaims.connectionGeneration, brokerClaims.principalId]),
  ]));
}

async function createKeyDerivationSalt(transcript: AgentAuthenticationTranscript): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(JSON.stringify(createBaseAuthenticationTranscript(transcript))),
  );
}

async function deriveAuthenticationKey(
  credential: CryptoKey,
  transcript: AgentAuthenticationTranscript,
  purpose: 'agent' | 'broker' | AuthenticatedFrameDirection,
): Promise<CryptoKey> {
  return globalThis.crypto.subtle.deriveKey(
    {
      hash: 'SHA-256',
      info: textEncoder.encode(`${authenticationDomain}/${purpose}`),
      name: 'HKDF',
      salt: await createKeyDerivationSalt(transcript),
    },
    credential,
    { hash: 'SHA-256', length: 256, name: 'HMAC' },
    false,
    ['sign', 'verify'],
  );
}

export async function createAgentAuthenticationProof(
  credential: CryptoKey,
  transcript: AgentAuthenticationTranscript,
): Promise<string> {
  const proofKey = await deriveAuthenticationKey(credential, transcript, 'agent');
  const proof = await globalThis.crypto.subtle.sign(
    'HMAC',
    proofKey,
    createAuthenticationTranscriptBytes(transcript, 'agent'),
  );
  return encodeBase64UrlBytes(new Uint8Array(proof));
}

export async function verifyAgentAuthenticationProof(
  credential: CryptoKey,
  transcript: AgentAuthenticationTranscript,
  proof: string,
): Promise<boolean> {
  const proofKey = await deriveAuthenticationKey(credential, transcript, 'agent');
  return globalThis.crypto.subtle.verify(
    'HMAC',
    proofKey,
    decodeBase64UrlBytes(proof),
    createAuthenticationTranscriptBytes(transcript, 'agent'),
  );
}

export async function createBrokerAuthenticationProof(
  credential: CryptoKey,
  transcript: AgentAuthenticationTranscript,
  claims: BrokerAuthenticationClaims,
): Promise<string> {
  const proofKey = await deriveAuthenticationKey(credential, transcript, 'broker');
  const proof = await globalThis.crypto.subtle.sign(
    'HMAC',
    proofKey,
    createAuthenticationTranscriptBytes(transcript, 'broker', claims),
  );
  return encodeBase64UrlBytes(new Uint8Array(proof));
}

export async function verifyBrokerAuthenticationProof(
  credential: CryptoKey,
  transcript: AgentAuthenticationTranscript,
  claims: BrokerAuthenticationClaims,
  proof: string,
): Promise<boolean> {
  const proofKey = await deriveAuthenticationKey(credential, transcript, 'broker');
  return globalThis.crypto.subtle.verify(
    'HMAC',
    proofKey,
    decodeBase64UrlBytes(proof),
    createAuthenticationTranscriptBytes(transcript, 'broker', claims),
  );
}

function createAuthenticatedFrameBytes(
  frame: Omit<AuthenticatedFrame, 'authenticationCode' | 'kind'>,
): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(JSON.stringify([
    authenticatedFrameDomain,
    frame.connectionId,
    frame.direction,
    frame.sequence,
    frame.payload,
  ]));
}

export async function createAuthenticatedFrame(
  credential: CryptoKey,
  transcript: AgentAuthenticationTranscript,
  direction: AuthenticatedFrameDirection,
  sequence: number,
  payload: unknown,
): Promise<AuthenticatedFrame> {
  const frameWithoutAuthenticationCode = {
    connectionId: transcript.connectionId,
    direction,
    payload: JSON.stringify(payload),
    sequence,
  };
  const sessionKey = await deriveAuthenticationKey(credential, transcript, direction);
  const authenticationCode = await globalThis.crypto.subtle.sign(
    'HMAC',
    sessionKey,
    createAuthenticatedFrameBytes(frameWithoutAuthenticationCode),
  );
  return {
    authenticationCode: encodeBase64UrlBytes(new Uint8Array(authenticationCode)),
    ...frameWithoutAuthenticationCode,
    kind: 'authenticated',
  };
}

export async function openAuthenticatedFrame(
  credential: CryptoKey,
  transcript: AgentAuthenticationTranscript,
  expectedDirection: AuthenticatedFrameDirection,
  expectedSequence: number,
  frameValue: unknown,
): Promise<unknown> {
  const frame = parseAuthenticatedFrame(frameValue);
  if (
    frame.connectionId !== transcript.connectionId
    || frame.direction !== expectedDirection
    || frame.sequence !== expectedSequence
  ) {
    throw new Error('Authenticated frame context is invalid');
  }

  const sessionKey = await deriveAuthenticationKey(credential, transcript, expectedDirection);
  const valid = await globalThis.crypto.subtle.verify(
    'HMAC',
    sessionKey,
    decodeBase64UrlBytes(frame.authenticationCode),
    createAuthenticatedFrameBytes(frame),
  );
  if (!valid) {
    throw new Error('Authenticated frame proof is invalid');
  }
  return JSON.parse(frame.payload) as unknown;
}

function parseAuthenticatedFrame(value: unknown): AuthenticatedFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Authenticated frame envelope is invalid');
  }
  const frame = value as Partial<AuthenticatedFrame>;
  const keys = Object.keys(value).sort();
  const expectedKeys = ['authenticationCode', 'connectionId', 'direction', 'kind', 'payload', 'sequence'];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || frame.kind !== 'authenticated'
    || typeof frame.authenticationCode !== 'string'
    || typeof frame.connectionId !== 'string'
    || (frame.direction !== 'agent-to-broker' && frame.direction !== 'broker-to-agent')
    || typeof frame.payload !== 'string'
    || !Number.isSafeInteger(frame.sequence)
    || (frame.sequence ?? 0) < 1
  ) {
    throw new Error('Authenticated frame envelope is invalid');
  }
  decodeBase64UrlBytes(frame.authenticationCode);
  return frame as AuthenticatedFrame;
}
