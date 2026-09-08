import type { Client } from '@modelcontextprotocol/client';
import type { Page } from 'playwright';

import { channel } from 'node:diagnostics_channel';
import { writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { styleText } from 'node:util';

/** Measures the same public workflow over the embedding test's real provider transport. */
export async function benchmarkAgentWorkflow(agent: Client, chromiumVersion: string, page: Page): Promise<void> {
  if (process.env.CDB_DEVFRAME_BENCHMARK_OUTPUT === undefined) return;
  const samples = Number(process.env.CDB_DEVFRAME_BENCHMARK_SAMPLES ?? 30);
  const initialLoad = loadavg();
  if (!Number.isInteger(samples) || samples < 5 || samples > 50) throw new Error('Benchmark samples must be between 5 and 50.');
  const actionMetrics: unknown[] = [];
  const diagnostics = channel('cdb.mcp.action');
  const collect = (measurement: unknown): void => {
    actionMetrics.push(measurement);
  };
  diagnostics.subscribe(collect);
  try {
    const measurements: { name: string; milliseconds: number; argumentsCharacters: number; responseCharacters: number }[] = [];
    const locator = (role: string, value: string): { role: string; name: { match: 'exact'; value: string } } => ({ role, name: { match: 'exact', value } });
    const fill = { targetRef: 't1', locator: locator('textbox', 'Deep value'), text: 'Benchmark value' };
    const click = { targetRef: 't1', locator: locator('button', 'Save deep value') };
    const batch = { targetRef: 't1', observe: true, actions: [{ action: 'fill', ...fill }, { action: 'click', ...click }].map(({ targetRef: _targetRef, ...action }) => action) };
    async function call(name: string, argumentsValue: Record<string, unknown>, record = true, blocked = false): Promise<void> {
      const started = performance.now();
      const result = await agent.callTool({ name, arguments: argumentsValue });
      if (blocked ? !JSON.stringify(result).includes('MCP_ELEMENT_COVERED') : result.isError) throw new Error(`Benchmark ${name} failed: ${JSON.stringify(result)}`);
      if (record) measurements.push({ name: blocked ? `${name}:blocked` : name, milliseconds: performance.now() - started, argumentsCharacters: JSON.stringify(argumentsValue).length, responseCharacters: JSON.stringify(result).length });
    }
    await call('browser.fill', fill, false);
    await call('browser.click', click, false);
    await call('browser.batch', batch, false);
    for (let sample = 0; sample < samples; sample += 1) {
      await call('browser.fill', fill);
      await call('browser.click', click);
      await call('browser.snapshot', { targetRef: 't1' });
      await call('browser.batch', batch);
    }
    await page.locator('#toggle-overlay').click();
    try {
      for (let sample = 0; sample < samples; sample += 1) await call('browser.click', click, true, true);
    } finally {
      await page.locator('#parent-overlay').evaluate(element => element.remove());
    }
    const workflows = Array.from({ length: samples }, (_unused, index) => measurements.slice(index * 4, index * 4 + 3).reduce((total, measurement) => total + measurement.milliseconds, 0));
    const percentile95 = (values: number[]): number | undefined => values.sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1];
    const summaries = Object.fromEntries(['browser.fill', 'browser.click', 'browser.snapshot', 'browser.batch', 'browser.click:blocked'].map(name => [name, { p95Milliseconds: percentile95(measurements.filter(measurement => measurement.name === name).map(measurement => measurement.milliseconds)) }]));

    const catalogue = await agent.listTools();
    const report = { environment: { chromiumVersion, node: process.version, architecture: process.arch, operatingSystem: process.platform, processor: cpus()[0]?.model, initialLoad, finalLoad: loadavg() }, transport: 'MCP → broker → authenticated Devframe RPC → Chrome extension → chrome.debugger', fixture: 'normal, closed shadow roots, three cross-origin frame levels', samples, individualWorkflowP95Milliseconds: percentile95(workflows), summaries, measurements, actionMetrics, catalogueCharacters: JSON.stringify(catalogue).length, tokenizerEstimate: 'Serialized JSON characters / 4; not measured tokenizer usage' };
    await writeFile(process.env.CDB_DEVFRAME_BENCHMARK_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    console.info(styleText('cyan', '📊 [devframe-benchmark]'), summaries);
    if (process.env.CDB_DEVFRAME_PERFORMANCE_GATE === '1') {
      for (const [name, maximumMilliseconds] of [['browser.fill', 500], ['browser.click', 500], ['browser.snapshot', 1_000]] as const) {
        if ((summaries[name]?.p95Milliseconds ?? Infinity) > maximumMilliseconds) throw new Error(`${name} p95 exceeded ${maximumMilliseconds} ms.`);
      }
    }
  } finally {
    diagnostics.unsubscribe(collect);
  }
}
