import type { Page } from 'playwright';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';

import { benchmarkAgentWorkflow } from './fixtures/workflow-benchmark.js';

it('retains completed workflow summaries when the subsequent blocked-action phase fails', async () => {
  expect.assertions(4);
  const directory = await mkdtemp(join(tmpdir(), 'cdb-report-'));
  const output = join(directory, 'report.json');
  const observation = 'textbox "Deep value" [ref=e1]\nbutton "Save deep value" [ref=e2]';
  const worker = { evaluate: vi.fn().mockResolvedValue([]) };
  let covered = false;
  const page = {
    context: () => ({ serviceWorkers: () => [worker] }),
    locator: () => ({ click: async () => {
      covered = true;
    }, evaluate: async () => {} }),
  } as unknown as Page;
  const client = new Client({ name: 'report regression', version: '1.0.0' });
  vi.spyOn(client, 'callTool').mockImplementation(async (request) => {
    if (covered) throw new Error('Fixture transport interrupted');
    return { content: [{ type: 'text', text: request.name === 'browser.batch' ? JSON.stringify({ observation }) : observation }] };
  });
  vi.stubEnv('CDB_DEVFRAME_BENCHMARK_OUTPUT', output);
  vi.stubEnv('CDB_WORKFLOW_BENCHMARK_SAMPLES', '5');
  try {
    await expect(benchmarkAgentWorkflow(client, 'fixture', page)).rejects.toThrow('Fixture transport interrupted');
    const report = JSON.parse(await readFile(output, 'utf8')) as { summaries: unknown; measurements: unknown[] };
    expect(report.summaries).toMatchObject({
      'ref:browser.fill': { samples: 5 },
      'ref:browser.snapshot': { samples: 5 },
      'ref:individual-workflow': { samples: 5 },
      'ref:browser.click:blocked': { samples: 0 },
      'locator:browser.fill': { samples: 0 },
    });
    expect(report.measurements).toHaveLength(20);
    expect(worker.evaluate).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
