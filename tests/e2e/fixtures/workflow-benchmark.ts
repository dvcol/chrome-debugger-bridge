import type { Client } from '@modelcontextprotocol/client';
import type { Page } from 'playwright';

import { channel } from 'node:diagnostics_channel';
import { writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { styleText } from 'node:util';

const referencePattern = /\[ref=(e\d+)\]/u;

interface BenchmarkWorker {
  chrome: { debugger: { sendCommand: (...parameters: unknown[]) => Promise<unknown> } };
  cdbBenchmarkCommands: { method: string; milliseconds: number }[];
  restoreCdbBenchmarkCommands: () => void;
}

/** Runs identical agent workflows over either real extension transport. */
export async function benchmarkAgentWorkflow(agent: Client, chromiumVersion: string, page: Page, transport: 'devframe' | 'websocket' = 'devframe'): Promise<void> {
  const output = transport === 'devframe' ? process.env.CDB_DEVFRAME_BENCHMARK_OUTPUT : process.env.CDB_WEBSOCKET_BENCHMARK_OUTPUT;
  if (output === undefined) return;
  const samples = Number(process.env.CDB_WORKFLOW_BENCHMARK_SAMPLES ?? 30);
  if (!Number.isInteger(samples) || samples < 5 || samples > 50) throw new Error('Benchmark samples must be between 5 and 50.');
  const initialLoad = loadavg();
  const actionMetrics: unknown[] = [];
  const snapshotMetrics: unknown[] = [];
  const diagnostics = channel('cdb.mcp.action');
  const snapshotDiagnostics = channel('cdb.mcp.snapshot');
  const collectSnapshot = (measurement: unknown): void => {
    snapshotMetrics.push(measurement);
  };
  const collect = (measurement: unknown): void => {
    actionMetrics.push(measurement);
  };
  const measurements: { selector: string; name: string; milliseconds: number; argumentsCharacters: number; responseCharacters: number; error: boolean }[] = [];
  const summaries: Record<string, { samples: number; p95Milliseconds: number | undefined }> = {};
  const workflows: Record<string, number[]> = { ref: [], locator: [] };
  const percentile95 = (values: number[]): number | undefined => values.sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1];
  const worker = page.context().serviceWorkers()[0];
  if (worker === undefined) throw new Error('The benchmark extension worker is unavailable.');
  await worker.evaluate(() => {
    const workerGlobal = globalThis as unknown as BenchmarkWorker;
    const sendCommand = workerGlobal.chrome.debugger.sendCommand;
    workerGlobal.cdbBenchmarkCommands = [];
    workerGlobal.restoreCdbBenchmarkCommands = () => {
      workerGlobal.chrome.debugger.sendCommand = sendCommand;
    };
    workerGlobal.chrome.debugger.sendCommand = async (...parameters) => {
      const started = performance.now();
      try {
        return await sendCommand.apply(workerGlobal.chrome.debugger, parameters);
      } finally {
        workerGlobal.cdbBenchmarkCommands.push({ method: String(parameters[1]), milliseconds: performance.now() - started });
      }
    };
  });
  diagnostics.subscribe(collect);
  snapshotDiagnostics.subscribe(collectSnapshot);
  try {
    for (const selector of ['ref', 'locator'] as const) {
      async function call(name: string, argumentsValue: Record<string, unknown>, record = true, blocked = false): Promise<string> {
        const started = performance.now();
        const result = await agent.callTool({ name, arguments: argumentsValue });
        const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        if (record) measurements.push({ selector, name: blocked ? `${name}:blocked` : name, milliseconds: performance.now() - started, argumentsCharacters: JSON.stringify(argumentsValue).length, responseCharacters: JSON.stringify(result).length, error: result.isError === true });
        if (blocked ? !text.includes('MCP_ELEMENT_COVERED') : result.isError) throw new Error(`Benchmark ${name} failed: ${text}`);
        return text;
      }
      let snapshot = await call('browser.snapshot', { targetRef: 't1' }, false);
      const locate = (role: string, name: string): Record<string, unknown> => {
        if (selector === 'locator') return { locator: { role, name: { match: 'exact', value: name } } };
        const reference = snapshot.split('\n').find(line => line.includes(`${role} "${name}"`))?.match(referencePattern)?.[1];
        if (reference === undefined) throw new Error(`Missing benchmark reference for ${name}.`);
        return { ref: reference };
      };
      const actions = (): { fill: Record<string, unknown>; click: Record<string, unknown> } => ({
        fill: { ...locate('textbox', 'Deep value'), text: 'Benchmark value' },
        click: { ...locate('button', 'Save deep value') },
      });
      for (let sample = -5; sample < samples; sample += 1) {
        const started = performance.now();
        const individual = actions();
        await call('browser.fill', { targetRef: 't1', ...individual.fill }, sample >= 0);
        await call('browser.click', { targetRef: 't1', ...individual.click }, sample >= 0);
        snapshot = await call('browser.snapshot', { targetRef: 't1' }, sample >= 0);
        if (sample >= 0) workflows[selector]!.push(performance.now() - started);
        const next = actions();
        const batch = { targetRef: 't1', observe: true, actions: [{ action: 'fill', ...next.fill }, { action: 'click', ...next.click }] };
        snapshot = (JSON.parse(await call('browser.batch', batch, sample >= 0)) as { observation: string }).observation;
      }
      await page.locator('#toggle-overlay').click();
      try {
        for (let sample = -5; sample < samples; sample += 1) await call('browser.click', { targetRef: 't1', ...actions().click }, sample >= 0, true);
      } finally {
        await page.locator('#parent-overlay').evaluate(element => element.remove());
      }
    }
  } finally {
    diagnostics.unsubscribe(collect);
    snapshotDiagnostics.unsubscribe(collectSnapshot);
    /** Summarize completed calls even when a later action interrupts the run. */
    for (const selector of ['ref', 'locator']) {
      for (const name of ['browser.fill', 'browser.click', 'browser.snapshot', 'browser.batch', 'browser.click:blocked']) {
        const durations = measurements.filter(measurement => measurement.selector === selector && measurement.name === name && (name.endsWith(':blocked') || !measurement.error)).map(measurement => measurement.milliseconds);
        summaries[`${selector}:${name}`] = { samples: durations.length, p95Milliseconds: percentile95(durations) };
      }
      summaries[`${selector}:individual-workflow`] = { samples: workflows[selector]!.length, p95Milliseconds: percentile95(workflows[selector]!) };
    }
    const chromeCommands = await worker.evaluate(() => {
      const workerGlobal = globalThis as unknown as BenchmarkWorker;
      workerGlobal.restoreCdbBenchmarkCommands();
      return workerGlobal.cdbBenchmarkCommands;
    }).catch(() => undefined);
    const report = { environment: { chromiumVersion, node: process.version, architecture: process.arch, operatingSystem: process.platform, processor: cpus()[0]?.model, initialLoad, finalLoad: loadavg() }, transport, fixture: 'normal, closed shadow roots, three cross-origin frame levels', warmups: 5, samples, summaries, measurements, actionMetrics, snapshotMetrics, chromeCommands, tokenizerEstimate: 'Serialized JSON characters / 4; not measured tokenizer usage' };
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.info(styleText('cyan', '📊 [workflow-benchmark]'), transport, summaries);
  }
  if (process.env.CDB_WORKFLOW_PERFORMANCE_GATE === '1') {
    for (const selector of ['ref', 'locator']) for (const [name, maximumMilliseconds] of [['browser.fill', 500], ['browser.click', 500], ['browser.snapshot', 1_000]] as const) {
      if ((summaries[`${selector}:${name}`]?.p95Milliseconds ?? Infinity) > maximumMilliseconds) throw new Error(`${selector}:${name} p95 exceeded ${maximumMilliseconds} ms.`);
    }
  }
}
