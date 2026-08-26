export type DiagnosticCode
  = 'CAPABILITY_DENIED'
    | 'CDP_COMMAND_FAILED'
    | 'LEASE_CONFLICT'
    | 'LEASE_EXPIRED'
    | 'LEASE_REQUIRED'
    | 'REQUEST_CANCELLED'
    | 'SESSION_GENERATION_STALE'
    | 'SESSION_NOT_FOUND'
    | 'TARGET_GENERATION_STALE'
    | 'TARGET_NOT_FOUND'
    | 'TARGET_REVOKED';

export interface DiagnosticTraceEntry {
  readonly code: DiagnosticCode;
  readonly component: 'target-broker';
  readonly occurredAt: string;
  readonly sequence: number;
}

export interface DiagnosticTraceStore {
  entries: () => readonly DiagnosticTraceEntry[];
  record: (code: DiagnosticCode) => void;
}

/** Retains a bounded trace of operational outcomes without accepting sensitive diagnostic payloads. */
export function createDiagnosticTraceStore(maximumEntries: number, now: () => number = Date.now): DiagnosticTraceStore {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new Error('The diagnostic trace limit is invalid.');
  const traceEntries: DiagnosticTraceEntry[] = [];
  let sequence = 0;
  return {
    entries() {
      return [...traceEntries];
    },
    record(code) {
      traceEntries.push({ code, component: 'target-broker', occurredAt: new Date(now()).toISOString(), sequence: ++sequence });
      if (traceEntries.length > maximumEntries) traceEntries.splice(0, traceEntries.length - maximumEntries);
    },
  };
}
