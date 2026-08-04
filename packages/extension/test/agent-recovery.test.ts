import { expect, it } from 'vitest';

import { createAgentRecovery } from '../src/agent-recovery.js';

function createConnection(): { close: (code?: number, reason?: string) => void; closed: Promise<{ readonly code: number; readonly reason: string }>; resolveClose: (result: { readonly code: number; readonly reason: string }) => void } {
  let resolveClose: ((result: { readonly code: number; readonly reason: string }) => void) | undefined;
  const closed = new Promise<{ readonly code: number; readonly reason: string }>(resolve => resolveClose = resolve);
  return {
    close(code = 1000, reason = '') {
      resolveClose?.({ code, reason });
    },
    closed,
    resolveClose(result) {
      resolveClose?.(result);
    },
  };
}

it('reconciles each fresh connection and backs off after an interruption', async () => {
  expect.assertions(8);
  const firstConnection = createConnection();
  const secondConnection = createConnection();
  const states: string[] = [];
  const scheduledTasks: Array<() => void> = [];
  let connections = 0;
  const recovery = createAgentRecovery({
    async connect() {
      connections += 1;
      return connections === 1 ? firstConnection : secondConnection;
    },
    minimumBackoffMilliseconds: 1,
    onStateChange(state) {
      states.push(state);
    },
    async reconcile(_connection, connectionGeneration) {
      expect(connectionGeneration).toBe(connections);
    },
    schedule(task) {
      scheduledTasks.push(task);
      return 0 as never;
    },
  });

  recovery.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(recovery.state).toBe('ready');
  firstConnection.resolveClose({ code: 1006, reason: 'network loss' });
  await Promise.resolve();
  expect(recovery.state).toBe('reconnecting');
  expect(scheduledTasks).toHaveLength(1);
  scheduledTasks.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(recovery.connection).toBe(secondConnection);
  expect(states).toEqual(['locating', 'connecting', 'authenticating', 'ready', 'reconnecting', 'locating', 'connecting', 'authenticating', 'ready']);
  recovery.stop();
  expect(recovery.state).toBe('stopped');
});

it('does not reconnect after revoked authority', async () => {
  expect.assertions(3);
  const connection = createConnection();
  const recovery = createAgentRecovery({
    async connect() {
      return connection;
    },
    async reconcile() {},
  });

  recovery.start();
  await Promise.resolve();
  await Promise.resolve();
  recovery.revoke();
  await Promise.resolve();

  expect(recovery.state).toBe('revoked');
  expect((await connection.closed).code).toBe(4001);
  expect(recovery.connection).toBeUndefined();
});

it('closes a live connection when its scheduled heartbeat fails', async () => {
  expect.assertions(3);
  const connection = createConnection();
  const scheduledTasks: Array<() => void> = [];
  const recovery = createAgentRecovery({
    async connect() {
      return connection;
    },
    async heartbeat() {
      throw new Error('network loss');
    },
    async reconcile() {},
    schedule(task) {
      scheduledTasks.push(task);
      return 0 as never;
    },
  });

  recovery.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(recovery.state).toBe('ready');
  scheduledTasks.shift()?.();
  await Promise.resolve();
  await Promise.resolve();

  expect((await connection.closed).code).toBe(3001);
  expect(recovery.state).toBe('reconnecting');
});

it('cancels a connection attempt when recovery stops before authentication finishes', async () => {
  expect.assertions(3);
  const connection = createConnection();
  let resolveConnection: (() => void) | undefined;
  const connectionGate = new Promise<void>(resolve => resolveConnection = resolve);
  const recovery = createAgentRecovery({
    async connect() {
      await connectionGate;
      return connection;
    },
    async reconcile() {},
  });

  recovery.start();
  await Promise.resolve();
  expect(recovery.state).toBe('connecting');
  recovery.stop();
  resolveConnection?.();
  await Promise.resolve();
  await Promise.resolve();

  expect(recovery.state).toBe('stopped');
  expect((await connection.closed).code).toBe(1000);
});
