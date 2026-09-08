import type { NativeMcpHarness } from './fixtures/native-mcp-harness.js';

import { writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { styleText } from 'node:util';

import { afterEach, expect, it } from 'vitest';

import { deepDomProfiles } from './fixtures/deep-dom-page.js';
import { createNativeMcpHarness, toolText } from './fixtures/native-mcp-harness.js';

interface CallMeasurement {
  readonly argumentCharacters: number;
  readonly artifactBytes: number;
  readonly artifactReadMilliseconds: number;
  readonly commands: readonly { readonly method: string; readonly durationMilliseconds: number }[];
  readonly commandCount: number;
  readonly commandRequestCharacters: number;
  readonly commandResponseCharacters: number;
  readonly durationMilliseconds: number;
  readonly error: boolean;
  readonly name: string;
  readonly responseCharacters: number;
}

let harness: NativeMcpHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

it.runIf(process.env.CDB_NATIVE_BENCHMARK === '1')('measures the public native agent loop and a limited Playwright reference', async () => {
  expect.assertions(4);
  const requestedSamples = Number(process.env.CDB_NATIVE_BENCHMARK_SAMPLES ?? 10);
  if (!Number.isInteger(requestedSamples) || requestedSamples < 5 || requestedSamples > 50) throw new Error('CDB_NATIVE_BENCHMARK_SAMPLES must be between 5 and 50.');
  const profile = process.env.CDB_NATIVE_BENCHMARK_PROFILE === 'stress' ? 'stress' : 'normal';
  const mcpModule = process.env.CDB_MCP_BASELINE_MODULE;
  harness = await createNativeMcpHarness({ ...(mcpModule === undefined ? {} : { mcpModule }), profile });
  const activeHarness = harness;
  const worker = activeHarness.context.serviceWorkers()[0]!;
  await worker.evaluate(() => {
    const workerGlobal = globalThis as unknown as {
      chrome: { debugger: { sendCommand: (...parameters: unknown[]) => Promise<unknown> } };
      debuggerCommandMeasurements: Array<{ readonly method: string; readonly durationMilliseconds: number }>;
    };
    workerGlobal.debuggerCommandMeasurements = [];
    const sendCommand = workerGlobal.chrome.debugger.sendCommand.bind(workerGlobal.chrome.debugger);
    workerGlobal.chrome.debugger.sendCommand = async (...parameters) => {
      const startedAt = performance.now();
      const result = await sendCommand(...parameters);
      workerGlobal.debuggerCommandMeasurements.push({ method: String(parameters[1]), durationMilliseconds: performance.now() - startedAt });
      return result;
    };
  });
  const measurements: CallMeasurement[] = [];
  const initialLoad = loadavg();
  const commandMeasurements: Array<{ readonly method: string; readonly durationMilliseconds: number; readonly requestCharacters: number; readonly responseCharacters: number }> = [];
  let artifactBytes = 0;
  let artifactReadMilliseconds = 0;
  const executeCommand = activeHarness.client.executeCommand.bind(activeHarness.client);
  activeHarness.client.executeCommand = async (command) => {
    const startedAt = performance.now();
    const result = await executeCommand(command);
    commandMeasurements.push({ method: command.method, durationMilliseconds: performance.now() - startedAt, requestCharacters: JSON.stringify(command).length, responseCharacters: JSON.stringify(result).length });
    return result;
  };
  const readArtifact = activeHarness.client.readArtifact.bind(activeHarness.client);
  activeHarness.client.readArtifact = async (request, signal) => {
    const startedAt = performance.now();
    const result = await readArtifact(request, signal);
    artifactReadMilliseconds += performance.now() - startedAt;
    artifactBytes += result.byteLength;
    return result;
  };
  const catalogue = await activeHarness.mcpClient.listTools();
  const catalogueCharacters = JSON.stringify(catalogue).length;
  const frameChain = [1, 2, 3].map(index => ({ css: `iframe[title="Frame ${index}"]` }));
  const record = async (name: string, toolArguments: Record<string, unknown>, include = true): Promise<Awaited<ReturnType<NativeMcpHarness['mcpClient']['callTool']>>> => {
    const startedAt = performance.now();
    const commandStart = commandMeasurements.length;
    const artifactStart = artifactBytes;
    const artifactReadStart = artifactReadMilliseconds;
    const result = await activeHarness.mcpClient.callTool({ arguments: toolArguments, name });
    if (include) measurements.push({
      argumentCharacters: JSON.stringify(toolArguments).length,
      artifactBytes: artifactBytes - artifactStart,
      artifactReadMilliseconds: artifactReadMilliseconds - artifactReadStart,
      commands: commandMeasurements.slice(commandStart).map(({ method, durationMilliseconds }) => ({ method, durationMilliseconds })),
      commandCount: commandMeasurements.length - commandStart,
      commandRequestCharacters: commandMeasurements.slice(commandStart).reduce((total, command) => total + command.requestCharacters, 0),
      commandResponseCharacters: commandMeasurements.slice(commandStart).reduce((total, command) => total + command.responseCharacters, 0),
      durationMilliseconds: performance.now() - startedAt,
      error: result.isError === true,
      name,
      responseCharacters: JSON.stringify(result).length,
    });
    return result;
  };
  const selectorMode = process.env.CDB_NATIVE_BENCHMARK_SELECTOR === 'locator' ? 'locator' : 'ref';
  const actionArguments = (snapshot: Awaited<ReturnType<NativeMcpHarness['mcpClient']['callTool']>>): { readonly fill: Record<string, unknown>; readonly click: Record<string, unknown> } => {
    const inputReference = /textbox "Deep value"[^\n]*\[ref=(e\d+)\]/u.exec(toolText(snapshot))?.[1];
    const buttonReference = /button "Save deep value"[^\n]*\[ref=(e\d+)\]/u.exec(toolText(snapshot))?.[1];
    return {
      fill: { ...(selectorMode === 'ref' && inputReference !== undefined ? { ref: inputReference } : { locator: { css: 'input#deep-value', frameChain } }), targetRef: activeHarness.targetRef, text: 'measured public workflow' },
      click: { ...(selectorMode === 'ref' && buttonReference !== undefined ? { ref: buttonReference } : { locator: { css: 'button#deep-save', frameChain } }), targetRef: activeHarness.targetRef },
    };
  };
  const initialSnapshotStartedAt = performance.now();
  const initialSnapshot = await record('browser.snapshot', { targetRef: activeHarness.targetRef }, false);
  const initialSnapshotDurationMilliseconds = performance.now() - initialSnapshotStartedAt;
  const initialArguments = actionArguments(initialSnapshot);
  const warmFill = await record('browser.fill', initialArguments.fill, false);
  const warmClick = await record('browser.click', initialArguments.click, false);
  const warmWorkflowSucceeded = !warmFill.isError && !warmClick.isError;
  if (warmWorkflowSucceeded) {
    for (let sampleIndex = 0; sampleIndex < requestedSamples; sampleIndex += 1) {
      const snapshot = await record('browser.snapshot', { targetRef: activeHarness.targetRef });
      if (snapshot.isError) break;
      const sampleArguments = actionArguments(snapshot);
      const fill = await record('browser.fill', sampleArguments.fill);
      if (fill.isError) break;
      const click = await record('browser.click', sampleArguments.click);
      if (click.isError) break;
    }
  }
  const finalStatus = await activeHarness.page.getByRole('status').textContent();
  const chromiumVersion = activeHarness.context.browser()?.version() ?? 'unavailable';
  const actions = measurements.filter(measurement => measurement.name !== 'browser.snapshot');
  const snapshots = measurements.filter(measurement => measurement.name === 'browser.snapshot');
  const action95 = actions.length === 0 ? null : percentile95(actions.map(measurement => measurement.durationMilliseconds));
  const snapshot95 = snapshots.length === 0 ? null : percentile95(snapshots.map(measurement => measurement.durationMilliseconds));
  const lastCompletedWorkflow = measurements.flatMap((measurement, index) => measurement.name === 'browser.click' && !measurement.error && index >= 2 ? [measurements.slice(index - 2, index + 1)] : []).at(-1);
  const workflowTokenEstimate = lastCompletedWorkflow === undefined ? null : Math.ceil(lastCompletedWorkflow.reduce((total, measurement) => total + measurement.argumentCharacters + measurement.responseCharacters, 0) / 4);
  const debuggerCommandMeasurements = await worker.evaluate(() => (globalThis as typeof globalThis & { debuggerCommandMeasurements: Array<{ readonly method: string; readonly durationMilliseconds: number }> }).debuggerCommandMeasurements);
  await activeHarness.close();
  harness = await createNativeMcpHarness({ profile, shadow: 'open' });
  const referenceDurations: number[] = [];
  const referenceSamples = Math.min(requestedSamples, 10);
  const referenceInput = harness.leafFrame.getByRole('textbox', { name: 'Deep value', exact: true });
  const referenceButton = harness.leafFrame.getByRole('button', { name: 'Save deep value', exact: true });
  await referenceInput.fill('Playwright reference');
  await referenceButton.click();
  for (let sampleIndex = 0; sampleIndex < referenceSamples; sampleIndex += 1) {
    let startedAt = performance.now();
    await referenceInput.fill('Playwright reference');
    referenceDurations.push(performance.now() - startedAt);
    startedAt = performance.now();
    await referenceButton.click();
    referenceDurations.push(performance.now() - startedAt);
  }
  const report = {
    budgets: { nativeActionP95Milliseconds: 500, nativeSnapshotP95Milliseconds: 1_000 },
    chromiumVersion,
    environment: { architecture: process.arch, nodeVersion: process.version, operatingSystem: process.platform, processorModel: cpus()[0]?.model, processors: cpus().length, initialLoad, finalLoad: loadavg() },
    fixture: deepDomProfiles[profile],
    measuredAt: new Date().toISOString(),
    modelExcluded: true,
    native: {
      actionP95Milliseconds: action95,
      errors: measurements.filter(measurement => measurement.error).length,
      debuggerCommandMeasurements,
      initialSnapshotIncludesDeepControls: toolText(initialSnapshot).includes('Save deep value'),
      initialSnapshotDurationMilliseconds,
      measurements,
      module: mcpModule ?? 'workspace source',
      selectorMode,
      snapshotP95Milliseconds: snapshot95,
      warmupFailures: [initialSnapshot, warmFill, warmClick].filter(result => result.isError).map(result => toolText(result)),
    },
    playwrightReference: {
      actionP95Milliseconds: percentile95(referenceDurations),
      limitation: 'Direct Playwright locator actions in open shadow roots only; no CDB/MCP transport or token comparison.',
      measurements: referenceDurations,
      samples: referenceSamples,
    },
    profile,
    samples: requestedSamples,
    tokenEstimates: {
      catalogueCharacters,
      catalogueTokens: Math.ceil(catalogueCharacters / 4),
      lastWorkflowTokens: workflowTokenEstimate,
      method: 'ceil(serialized JSON characters / 4), an estimate rather than measured model tokenizer usage; catalogue is counted separately once.',
    },
    transport: 'MCP SDK in-memory transport → authenticated client WebSocket → broker → authenticated provider WebSocket → MV3 chrome.debugger; artifact reads use authenticated HTTP.',
  };
  if (process.env.CDB_NATIVE_BENCHMARK_OUTPUT !== undefined) await writeFile(process.env.CDB_NATIVE_BENCHMARK_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.info(styleText('cyan', '📊 [native-benchmark]'), JSON.stringify(report));
  expect(finalStatus).toBe('Saved: measured public workflow');
  expect(warmWorkflowSucceeded && measurements.length === requestedSamples * 3 && measurements.every(measurement => !measurement.error)).toBe(true);
  expect(process.env.CDB_NATIVE_PERFORMANCE_GATE === '1' ? action95 ?? Infinity : 0).toBeLessThanOrEqual(500);
  expect(process.env.CDB_NATIVE_PERFORMANCE_GATE === '1' ? snapshot95 ?? Infinity : 0).toBeLessThanOrEqual(1_000);
}, 180_000);
