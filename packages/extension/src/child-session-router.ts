export interface PublicChildSession {
  readonly generation: number;
  readonly id: string;
}

export interface ChildSessionRouter {
  attach: (chromeSessionId: string) => PublicChildSession;
  detach: (chromeSessionId: string) => PublicChildSession | undefined;
  resolve: (publicSessionId: string) => string | undefined;
  revoke: () => readonly PublicChildSession[];
}

/** Keeps Chrome's flat-session identifiers extension-private behind lifecycle-bound UUIDs. */
export function createChildSessionRouter(): ChildSessionRouter {
  const chromeSessionIdByPublicId = new Map<string, string>();
  const publicSessionByChromeId = new Map<string, PublicChildSession>();
  let generation = 0;

  return {
    attach(chromeSessionId) {
      const existing = publicSessionByChromeId.get(chromeSessionId);
      if (existing !== undefined) return existing;
      const session = { generation: ++generation, id: globalThis.crypto.randomUUID() };
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
