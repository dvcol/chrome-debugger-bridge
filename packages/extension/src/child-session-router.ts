export interface PublicChildSession {
  readonly frameId?: string;
  readonly generation: number;
  readonly id: string;
  readonly type: string;
  readonly url?: string;
}

export interface ChildSessionRouter {
  attach: (
    chromeSessionId: string,
    metadata?: string | { readonly frameId?: string; readonly type?: string; readonly url?: string },
  ) => PublicChildSession;
  detach: (chromeSessionId: string) => PublicChildSession | undefined;
  list: () => readonly PublicChildSession[];
  publicSessionForChromeId: (chromeSessionId: string) => PublicChildSession | undefined;
  resolve: (publicSessionId: string) => string | undefined;
  revoke: () => readonly PublicChildSession[];
}

/** Keeps Chrome's flat-session identifiers extension-private behind lifecycle-bound UUIDs. */
export function createChildSessionRouter(): ChildSessionRouter {
  const chromeSessionIdByPublicId = new Map<string, string>();
  const publicSessionByChromeId = new Map<string, PublicChildSession>();
  let generation = 0;

  return {
    attach(chromeSessionId, metadata = {}) {
      const existing = publicSessionByChromeId.get(chromeSessionId);
      if (existing !== undefined) return existing;
      const sessionMetadata = typeof metadata === 'string' ? { type: metadata } : metadata;
      const session = {
        ...(sessionMetadata.frameId === undefined ? {} : { frameId: sessionMetadata.frameId }),
        generation: ++generation,
        id: globalThis.crypto.randomUUID(),
        type: sessionMetadata.type ?? 'unknown',
        ...(sessionMetadata.url === undefined ? {} : { url: sessionMetadata.url }),
      };
      chromeSessionIdByPublicId.set(session.id, chromeSessionId);
      publicSessionByChromeId.set(chromeSessionId, session);
      return session;
    },
    detach(chromeSessionId) {
      const session = publicSessionByChromeId.get(chromeSessionId);
      if (session === undefined) return undefined;
      publicSessionByChromeId.delete(chromeSessionId);
      chromeSessionIdByPublicId.delete(session.id);
      return session;
    },
    list() {
      return [...publicSessionByChromeId.values()];
    },
    publicSessionForChromeId(chromeSessionId) {
      return publicSessionByChromeId.get(chromeSessionId);
    },
    resolve(publicSessionId) {
      return chromeSessionIdByPublicId.get(publicSessionId);
    },
    revoke() {
      const sessions = [...publicSessionByChromeId.values()];
      chromeSessionIdByPublicId.clear();
      publicSessionByChromeId.clear();
      return sessions;
    },
  };
}
