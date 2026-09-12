import type { BrokerRuntime } from '@dvcol/cdb-broker';
import type { Client } from '@modelcontextprotocol/client';
import type { Page, Worker } from 'playwright';

import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { styleText } from 'node:util';

interface LifecycleWorker {
  approveDevframeRequest: (requestId: string) => Promise<unknown>;
  disconnectDevframeProvider: () => void;
  readDevframeState: () => Promise<unknown>;
}

/** Optional repeated lifecycle diagnostics over the same real extension and MCP connection. */
export async function diagnoseLifecycle(options: { agent: Client; broker: BrokerRuntime; worker: Worker; page: Page; chromiumVersion: string }): Promise<void> {
  const output = process.env.CDB_LIFECYCLE_DIAGNOSTICS_OUTPUT;
  if (output === undefined) return;
  const { agent, broker, worker, page } = options;
  const cycles = 30;
  const initialLoad = loadavg();
  const measurements: { cycle: number; scenario: string; milliseconds: number; error?: string }[] = [];
  const actionMetrics: unknown[] = [];
  const diagnostics = channel('cdb.mcp.action');
  const collect = (measurement: unknown): void => {
    actionMetrics.push(measurement);
  };
  diagnostics.subscribe(collect);
  async function until(ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!ready()) {
      assert(Date.now() < deadline, 'Lifecycle state did not settle within 10 seconds.');
      await delay(20);
    }
  }
  async function call(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    const result = await agent.callTool({ name, arguments: parameters });
    assert(!result.isError, JSON.stringify(result));
    const content = result.content as { type: string; text?: string }[];
    return JSON.parse(content.find(item => item.type === 'text')?.text ?? 'null');
  }
  async function approve(): Promise<string> {
    const requested = call('browser.request_access', { level: 'interact' });
    requested.catch(() => {});
    await Promise.race([
      until(() => broker.snapshot().requests.length === 1),
      requested.then(() => {
        throw new Error('Access completed without an approval request.');
      }),
    ]);
    await worker.evaluate(async requestId => (globalThis as unknown as LifecycleWorker).approveDevframeRequest(requestId), broker.snapshot().requests[0]!.id);
    await requested;
    const targets = await call('browser.list_targets', {}) as { targetRef: string }[];
    assert.equal(targets.length, 1);
    return targets[0]!.targetRef;
  }
  async function record(cycle: number, scenario: string, run: () => Promise<void>): Promise<void> {
    const started = performance.now();
    try {
      await run();
      measurements.push({ cycle, scenario, milliseconds: performance.now() - started });
    } catch (error) {
      measurements.push({ cycle, scenario, milliseconds: performance.now() - started, error: String(error) });
      throw error;
    }
  }
  const locator = { role: 'button', name: { match: 'exact', value: 'Save deep value' } };
  try {
    for (const scope of broker.snapshot().scopes) await broker.revokeScope(scope.id);
    await page.goto(page.url().replace('cdb-other.test', 'cdb-root.test'));
    let targetRef = await approve();
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      await record(cycle, 'navigation', async () => {
        await call('browser.reload', { targetRef, timeoutMilliseconds: 10_000 });
        await call('browser.click', { targetRef, locator });
      });
      await record(cycle, 'reconnect', async () => {
        const generation = broker.snapshot().grants[0]!.targetGeneration;
        await worker.evaluate(() => (globalThis as unknown as LifecycleWorker).disconnectDevframeProvider());
        await until(() => broker.snapshot().grants.some(grant => grant.state === 'active' && grant.targetGeneration > generation));
        await call('browser.click', { targetRef, locator });
      });
      await record(cycle, 'cancellation', async () => {
        await page.locator('#toggle-overlay').click();
        const abort = new AbortController();
        const pending = agent.callTool({ name: 'browser.click', arguments: { targetRef, locator } }, { signal: abort.signal }).then(value => ({ value }), (error: unknown) => ({ error }));
        await delay(100);
        abort.abort();
        const outcome = await pending;
        assert('error' in outcome || outcome.value.isError, 'Cancellation unexpectedly completed the covered action.');
        await until(() => broker.snapshot().leases.length === 0);
        await worker.evaluate(async () => (globalThis as unknown as LifecycleWorker).readDevframeState());
        await page.locator('#parent-overlay').evaluate(element => element.remove());
        await call('browser.click', { targetRef, locator });
      });
      await record(cycle, 'revocation', async () => {
        await page.locator('#toggle-overlay').click();
        const pending = agent.callTool({ name: 'browser.click', arguments: { targetRef, locator } }).then(value => ({ value }), (error: unknown) => ({ error }));
        await delay(100);
        await broker.revokeScope(broker.snapshot().scopes[0]!.id);
        const outcome = await pending;
        assert('error' in outcome || outcome.value.isError, 'Revocation unexpectedly completed the covered action.');
        assert.deepEqual(await call('browser.list_targets', {}), []);
        await worker.evaluate(async () => (globalThis as unknown as LifecycleWorker).readDevframeState());
        await page.locator('#parent-overlay').evaluate(element => element.remove());
        targetRef = await approve();
        await call('browser.click', { targetRef, locator });
      });
      if ((cycle + 1) % 5 === 0) console.info(styleText('cyan', '🔎 [lifecycle-diagnostics]'), `${cycle + 1}/${cycles} cycles completed`);
    }
  } finally {
    diagnostics.unsubscribe(collect);
    await writeFile(output, JSON.stringify({ cycles, environment: { chromiumVersion: options.chromiumVersion, node: process.version, initialLoad, finalLoad: loadavg() }, measurements, actionMetrics }, null, 2));
    for (const scope of broker.snapshot().scopes) await broker.revokeScope(scope.id);
  }
}
