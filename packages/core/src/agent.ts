import type { PublishedTarget } from './protocol.js';

export interface AgentTargetReference {
  readonly available: boolean;
  readonly targetGeneration: number;
  readonly targetId: string;
  readonly targetReference: string;
}

export interface AgentSession {
  dispose: () => void;
  project: (targets: readonly PublishedTarget[]) => readonly AgentTargetReference[];
  resolve: (targetReference: string) => AgentTargetReference | undefined;
  revoke: (targetId: string) => void;
  setUnavailable: (targetId: string) => void;
}

/** Owns stable agent-facing target references without interpreting provider or browser metadata. */
export function createAgentSession(): AgentSession {
  const referencesByTargetId = new Map<string, AgentTargetReference>();
  const targetsByReference = new Map<string, AgentTargetReference>();
  let nextReference = 1;
  let disposed = false;

  function ensureActive(): void {
    if (disposed) throw new Error('The agent session is disposed.');
  }

  return {
    dispose() {
      disposed = true;
      referencesByTargetId.clear();
      targetsByReference.clear();
    },
    project(targets) {
      ensureActive();
      return targets.map((target) => {
        const existing = referencesByTargetId.get(target.id);
        const reference: AgentTargetReference = {
          available: true,
          targetGeneration: target.generation,
          targetId: target.id,
          targetReference: existing?.targetReference ?? `t${nextReference++}`,
        };
        referencesByTargetId.set(target.id, reference);
        targetsByReference.set(reference.targetReference, reference);
        return reference;
      });
    },
    resolve(targetReference) {
      ensureActive();
      return targetsByReference.get(targetReference);
    },
    revoke(targetId) {
      ensureActive();
      const reference = referencesByTargetId.get(targetId);
      if (reference === undefined) return;
      referencesByTargetId.delete(targetId);
      targetsByReference.delete(reference.targetReference);
    },
    setUnavailable(targetId) {
      ensureActive();
      const reference = referencesByTargetId.get(targetId);
      if (reference === undefined) return;
      const unavailable = { ...reference, available: false };
      referencesByTargetId.set(targetId, unavailable);
      targetsByReference.set(reference.targetReference, unavailable);
    },
  };
}
