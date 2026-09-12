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
    parentChromeSessionId?: string,
  ) => PublicChildSession;
  detach: (chromeSessionId: string) => PublicChildSession | undefined;
  list: () => readonly PublicChildSession[];
  publicSessionForChromeId: (chromeSessionId: string) => PublicChildSession | undefined;
  resolve: (publicSessionId: string) => string | undefined;
  /** Invalidates public references while preserving Chrome sessions that have not detached. */
  renew: () => void;
  revoke: () => readonly PublicChildSession[];
}

/** Keeps Chrome's flat-session identifiers extension-private behind lifecycle-bound UUIDs. */
export function createChildSessionRouter(): ChildSessionRouter {
  const chromeSessionIdByPublicId = new Map<string, string>();
  const publicSessionByChromeId = new Map<string, PublicChildSession>();
  const parentByChromeId = new Map<string, string>();
  let generation = 0;

  return {
    attach(chromeSessionId, metadata = {}, parentChromeSessionId) {
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
      if (parentChromeSessionId !== undefined) parentByChromeId.set(chromeSessionId, parentChromeSessionId);
      return session;
    },
    detach(chromeSessionId) {
      const session = publicSessionByChromeId.get(chromeSessionId);
      if (session === undefined) return undefined;
      const detached = [chromeSessionId];
      while (detached.length > 0) {
        const current = detached.pop()!;
        const child = publicSessionByChromeId.get(current);
        if (child !== undefined) chromeSessionIdByPublicId.delete(child.id);
        publicSessionByChromeId.delete(current);
        parentByChromeId.delete(current);
        for (const [childId, parentId] of parentByChromeId) if (parentId === current) detached.push(childId);
      }
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
    renew() {
      chromeSessionIdByPublicId.clear();
      for (const [chromeSessionId, previous] of publicSessionByChromeId) {
        const session = { ...previous, generation: ++generation, id: globalThis.crypto.randomUUID() };
        publicSessionByChromeId.set(chromeSessionId, session);
        chromeSessionIdByPublicId.set(session.id, chromeSessionId);
      }
    },
    revoke() {
      const sessions = [...publicSessionByChromeId.values()];
      chromeSessionIdByPublicId.clear();
      publicSessionByChromeId.clear();
      parentByChromeId.clear();
      return sessions;
    },
  };
}
