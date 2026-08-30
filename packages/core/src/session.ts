import type { AuthorityBinding, AuthorityRecord, AuthorityStore } from './authority.js';
import type { JsonValue } from './protocol.js';
import type { TimeoutMilliseconds } from './timing.js';

import { scheduleTimeout, validateTimeoutMilliseconds } from './timing.js';

const base64PaddingPattern = /=+$/u;

export interface StoredCredential {
  readonly credential: string;
  readonly logicalSessionId: string;
}

export interface CredentialStoreChange {
  readonly key: string;
}

export interface CredentialStore {
  delete: (key: string) => Promise<void>;
  get: (key: string) => Promise<StoredCredential | undefined>;
  set: (key: string, credential: StoredCredential) => Promise<void>;
  subscribe: (listener: (change: CredentialStoreChange) => void) => () => void;
}

export function createMemoryCredentialStore(
  initialCredentials: Readonly<Record<string, StoredCredential>> = {},
): CredentialStore {
  const credentials = new Map(Object.entries(initialCredentials).map(([key, value]) => [key, structuredClone(value)]));
  const listeners = new Set<(change: CredentialStoreChange) => void>();
  const notify = (key: string): void => {
    for (const listener of listeners) listener({ key });
  };
  return {
    async delete(key) {
      if (!credentials.delete(key)) return;
      notify(key);
    },
    async get(key) {
      const credential = credentials.get(key);
      return credential === undefined ? undefined : structuredClone(credential);
    },
    async set(key, credential) {
      if (key.length === 0 || credential.credential.length === 0 || credential.logicalSessionId.length === 0) {
        throw new TypeError('Credential keys, credentials, and logical session identifiers must be non-empty.');
      }
      credentials.set(key, structuredClone(credential));
      notify(key);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface LogicalSessionTimingPolicy {
  readonly resumeWindowMilliseconds: TimeoutMilliseconds;
}

export const defaultLogicalSessionTimingPolicy: Readonly<LogicalSessionTimingPolicy> = Object.freeze({
  resumeWindowMilliseconds: 15 * 60_000,
});

export interface LogicalSessionCredential {
  readonly connectionGeneration: number;
  readonly logicalSessionId: string;
  readonly resumeCredential: string;
}

export interface LogicalSessionManager {
  create: (input: {
    readonly bindings?: readonly AuthorityBinding[];
    readonly connectionId: string;
    readonly logicalSessionId?: string;
    readonly metadata?: JsonValue;
    readonly principalId: string;
  }) => Promise<LogicalSessionCredential>;
  disconnect: (logicalSessionId: string, connectionId: string) => Promise<void>;
  dispose: () => void;
  resume: (input: {
    readonly connectionId: string;
    readonly logicalSessionId: string;
    readonly resumeCredential: string;
  }) => Promise<LogicalSessionCredential>;
  terminate: (logicalSessionId: string) => Promise<void>;
}

export class LogicalSessionError extends Error {
  constructor(
    readonly code: 'SESSION_CREDENTIAL_INVALID' | 'SESSION_EXPIRED' | 'SESSION_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export interface CreateLogicalSessionManagerOptions {
  readonly authorityStore?: AuthorityStore;
  readonly generateCredential?: () => string;
  readonly generateId?: () => string;
  readonly now?: () => number;
  readonly timing?: Partial<LogicalSessionTimingPolicy>;
}

function randomCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(base64PaddingPattern, '');
}

async function hashCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function jsonMetadata(metadata: JsonValue | undefined): JsonValue | undefined {
  if (metadata === undefined) return undefined;
  const validate = (value: unknown): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new TypeError('Logical session metadata must not contain sparse arrays.');
      for (const item of value) validate(item);
      return;
    }
    if (typeof value === 'object') {
      const prototype = Reflect.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Logical session metadata must contain only JSON objects.');
      }
      for (const item of Object.values(value as Record<string, unknown>)) validate(item);
      return;
    }
    throw new TypeError('Logical session metadata must be JSON-compatible.');
  };
  validate(metadata);
  return structuredClone(metadata);
}

/** Owns opaque resume credentials while delegating durable state to an AuthorityStore. */
export function createLogicalSessionManager(
  options: CreateLogicalSessionManagerOptions & { readonly authorityStore: AuthorityStore },
): LogicalSessionManager {
  const authorityStore = options.authorityStore;
  const generateCredential = options.generateCredential ?? randomCredential;
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const timing: LogicalSessionTimingPolicy = {
    ...defaultLogicalSessionTimingPolicy,
    ...options.timing,
  };
  validateTimeoutMilliseconds(timing.resumeWindowMilliseconds, 'resumeWindowMilliseconds');
  const expiryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function clearExpiry(logicalSessionId: string): void {
    const timeout = expiryTimeouts.get(logicalSessionId);
    if (timeout !== undefined) clearTimeout(timeout);
    expiryTimeouts.delete(logicalSessionId);
  }

  function scheduleExpiry(record: AuthorityRecord): void {
    clearExpiry(record.logicalSessionId);
    if (record.resumeExpiresAt === null || record.resumeExpiresAt === undefined || record.activeConnectionId !== undefined) return;
    const remainingMilliseconds = Math.max(0, Date.parse(record.resumeExpiresAt) - now());
    const timeout = scheduleTimeout(() => {
      expiryTimeouts.delete(record.logicalSessionId);
      void authorityStore.update(record.logicalSessionId, (current) => {
        if (
          current?.activeConnectionId !== undefined
          || current?.resumeExpiresAt === null
          || current?.resumeExpiresAt === undefined
          || Date.parse(current.resumeExpiresAt) > now()
        ) return current;
        return undefined;
      }).catch(() => {});
    }, remainingMilliseconds);
    if (timeout !== undefined) expiryTimeouts.set(record.logicalSessionId, timeout);
  }

  return {
    async create(input) {
      if (disposed) throw new Error('The logical session manager is disposed.');
      const logicalSessionId = input.logicalSessionId ?? generateId();
      if (logicalSessionId.length === 0 || input.connectionId.length === 0 || input.principalId.length === 0) {
        throw new TypeError('Logical session, connection, and principal identifiers must be non-empty.');
      }
      if (await authorityStore.get(logicalSessionId) !== undefined) {
        throw new TypeError('The logical session identifier already exists.');
      }
      const resumeCredential = generateCredential();
      const record: AuthorityRecord = {
        activeConnectionId: input.connectionId,
        bindings: input.bindings ?? [],
        connectionGeneration: 1,
        logicalSessionId,
        ...(input.metadata === undefined ? {} : { metadata: jsonMetadata(input.metadata)! }),
        principalId: input.principalId,
        resumeCredentialHash: await hashCredential(resumeCredential),
      };
      await authorityStore.set(record);
      return { connectionGeneration: 1, logicalSessionId, resumeCredential };
    },
    async disconnect(logicalSessionId, connectionId) {
      if (disposed) return;
      let disconnected: AuthorityRecord | undefined;
      await authorityStore.update(logicalSessionId, (current) => {
        if (current?.activeConnectionId !== connectionId) return current;
        const { activeConnectionId: _activeConnectionId, ...disconnectedRecord } = current;
        const resumeExpiresAt = timing.resumeWindowMilliseconds === null
          ? null
          : new Date(now() + timing.resumeWindowMilliseconds).toISOString();
        disconnected = { ...disconnectedRecord, resumeExpiresAt };
        return disconnected;
      });
      if (disconnected !== undefined) scheduleExpiry(disconnected);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timeout of expiryTimeouts.values()) clearTimeout(timeout);
      expiryTimeouts.clear();
    },
    async resume(input) {
      if (disposed) throw new Error('The logical session manager is disposed.');
      const current = await authorityStore.get(input.logicalSessionId);
      if (current === undefined) throw new LogicalSessionError('SESSION_NOT_FOUND', 'The logical session does not exist.');
      if (
        current.activeConnectionId === undefined
        && current.resumeExpiresAt !== null
        && current.resumeExpiresAt !== undefined
        && Date.parse(current.resumeExpiresAt) <= now()
      ) {
        await authorityStore.delete(input.logicalSessionId);
        throw new LogicalSessionError('SESSION_EXPIRED', 'The logical session resume window expired.');
      }
      if (current.resumeCredentialHash !== await hashCredential(input.resumeCredential)) {
        throw new LogicalSessionError('SESSION_CREDENTIAL_INVALID', 'The logical session credential is invalid.');
      }
      const resumeCredential = generateCredential();
      const resumeCredentialHash = await hashCredential(resumeCredential);
      let resumed: AuthorityRecord | undefined;
      await authorityStore.update(input.logicalSessionId, (latest) => {
        if (latest === undefined || latest.resumeCredentialHash !== current.resumeCredentialHash) return latest;
        const { resumeExpiresAt: _resumeExpiresAt, ...resumedRecord } = latest;
        resumed = {
          ...resumedRecord,
          activeConnectionId: input.connectionId,
          connectionGeneration: latest.connectionGeneration + 1,
          resumeCredentialHash,
        };
        return resumed;
      });
      if (resumed === undefined) {
        throw new LogicalSessionError('SESSION_CREDENTIAL_INVALID', 'The logical session credential was already rotated.');
      }
      clearExpiry(input.logicalSessionId);
      return {
        connectionGeneration: resumed.connectionGeneration,
        logicalSessionId: input.logicalSessionId,
        resumeCredential,
      };
    },
    async terminate(logicalSessionId) {
      clearExpiry(logicalSessionId);
      await authorityStore.delete(logicalSessionId);
    },
  };
}
