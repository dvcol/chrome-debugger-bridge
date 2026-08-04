import type { PublishedTarget } from './protocol.js';

export interface TargetBroker {
  listTargets: () => readonly PublishedTarget[];
  publishTarget: (target: PublishedTarget) => void;
  revokeTarget: (targetId: string, generation: number) => void;
}

/** Stores only opaque target records received from an authenticated extension agent. */
export function createTargetBroker(): TargetBroker {
  const targetsById = new Map<string, PublishedTarget>();

  return {
    listTargets() {
      return [...targetsById.values()];
    },
    publishTarget(target) {
      targetsById.set(target.id, target);
    },
    revokeTarget(targetId, generation) {
      const target = targetsById.get(targetId);
      if (target?.generation === generation) {
        targetsById.delete(targetId);
      }
    },
  };
}
