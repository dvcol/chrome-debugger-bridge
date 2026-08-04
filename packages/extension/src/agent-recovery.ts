export type AgentRecoveryState = 'authenticating' | 'connecting' | 'locating' | 'ready' | 'reconnecting' | 'revoked' | 'stopped';

export interface RecoverableAgentConnection {
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  close: (code?: number, reason?: string) => void;
}

export interface CreateAgentRecoveryOptions<Connection extends RecoverableAgentConnection> {
  readonly connect: (connectionGeneration: number) => Promise<Connection>;
  readonly heartbeat?: (connection: Connection, connectionGeneration: number) => Promise<void>;
  readonly heartbeatIntervalMilliseconds?: number;
  readonly maximumBackoffMilliseconds?: number;
  readonly minimumBackoffMilliseconds?: number;
  readonly onStateChange?: (state: AgentRecoveryState) => void;
  readonly reconcile: (connection: Connection, connectionGeneration: number) => Promise<void>;
  readonly schedule?: (task: () => void, delayMilliseconds: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly cancelScheduled?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface AgentRecovery<Connection extends RecoverableAgentConnection> {
  readonly state: AgentRecoveryState;
  readonly connection: Connection | undefined;
  start: () => void;
  revoke: () => void;
  stop: () => void;
}

/** Reconnects an MV3 agent without treating connections, targets, leases, or sessions as durable state. */
export function createAgentRecovery<Connection extends RecoverableAgentConnection>(options: CreateAgentRecoveryOptions<Connection>): AgentRecovery<Connection> {
  const minimumBackoffMilliseconds = options.minimumBackoffMilliseconds ?? 250;
  const maximumBackoffMilliseconds = options.maximumBackoffMilliseconds ?? 30_000;
  const heartbeatIntervalMilliseconds = options.heartbeatIntervalMilliseconds ?? 20_000;
  const schedule = options.schedule ?? globalThis.setTimeout;
  const cancelScheduled = options.cancelScheduled ?? globalThis.clearTimeout;
  let activeConnection: Connection | undefined;
  let attempt = 0;
  let connectionGeneration = 0;
  let currentState: AgentRecoveryState = 'stopped';
  let scheduledReconnect: number | ReturnType<typeof globalThis.setTimeout> | undefined;
  let scheduledHeartbeat: number | ReturnType<typeof globalThis.setTimeout> | undefined;
  let stopped = true;

  function setState(state: AgentRecoveryState): void {
    currentState = state;
    options.onStateChange?.(state);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    setState('reconnecting');
    const delayMilliseconds = Math.min(maximumBackoffMilliseconds, minimumBackoffMilliseconds * 2 ** Math.min(attempt++, 16));
    scheduledReconnect = schedule(() => {
      scheduledReconnect = undefined;
      void connect();
    }, delayMilliseconds);
  }

  function scheduleHeartbeat(connection: Connection, generation: number): void {
    if (options.heartbeat === undefined || stopped || activeConnection !== connection) return;
    scheduledHeartbeat = schedule(() => {
      scheduledHeartbeat = undefined;
      void options.heartbeat?.(connection, generation).then(() => {
        scheduleHeartbeat(connection, generation);
      }).catch(() => {
        connection.close(1001, 'Agent heartbeat failed');
      });
    }, heartbeatIntervalMilliseconds);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    setState('locating');
    try {
      setState('connecting');
      const candidateConnection = await options.connect(++connectionGeneration);
      if (stopped) {
        candidateConnection.close(1000, 'Agent recovery stopped');
        return;
      }
      setState('authenticating');
      await options.reconcile(candidateConnection, connectionGeneration);
      if (stopped) {
        candidateConnection.close(1000, 'Agent recovery stopped');
        return;
      }
      activeConnection = candidateConnection;
      attempt = 0;
      setState('ready');
      scheduleHeartbeat(candidateConnection, connectionGeneration);
      const closure = await candidateConnection.closed;
      if (activeConnection !== candidateConnection) return;
      activeConnection = undefined;
      if (scheduledHeartbeat !== undefined) cancelScheduled(scheduledHeartbeat as ReturnType<typeof globalThis.setTimeout>);
      scheduledHeartbeat = undefined;
      if (closure.code === 4001 || closure.code === 4003) {
        setState('revoked');
        return;
      }
      scheduleReconnect();
    } catch {
      activeConnection = undefined;
      scheduleReconnect();
    }
  }

  return {
    get connection() {
      return activeConnection;
    },
    get state() {
      return currentState;
    },
    revoke() {
      stopped = true;
      if (scheduledReconnect !== undefined) cancelScheduled(scheduledReconnect as ReturnType<typeof globalThis.setTimeout>);
      scheduledReconnect = undefined;
      if (scheduledHeartbeat !== undefined) cancelScheduled(scheduledHeartbeat as ReturnType<typeof globalThis.setTimeout>);
      scheduledHeartbeat = undefined;
      activeConnection?.close(4001, 'Agent authority revoked');
      activeConnection = undefined;
      setState('revoked');
    },
    start() {
      if (!stopped) return;
      stopped = false;
      void connect();
    },
    stop() {
      stopped = true;
      if (scheduledReconnect !== undefined) cancelScheduled(scheduledReconnect as ReturnType<typeof globalThis.setTimeout>);
      scheduledReconnect = undefined;
      if (scheduledHeartbeat !== undefined) cancelScheduled(scheduledHeartbeat as ReturnType<typeof globalThis.setTimeout>);
      scheduledHeartbeat = undefined;
      activeConnection?.close(1000, 'Agent recovery stopped');
      activeConnection = undefined;
      setState('stopped');
    },
  };
}
