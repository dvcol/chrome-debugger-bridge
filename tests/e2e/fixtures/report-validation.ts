import { appendFile, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { styleText } from 'node:util';

interface ValidationReport {
  environment: Record<string, unknown>;
  samples?: number;
  cycles?: number;
  summaries?: Record<string, { samples: number; p95Milliseconds?: number }>;
  measurements: { error?: unknown }[];
}

/** Print full diagnostics to CI logs and bounded summaries to the job page. */
async function main(): Promise<void> {
  for (const filename of process.argv.slice(2)) {
    let summary = `\n### ${basename(filename)}\n\n`;
    try {
      const content = await readFile(filename, 'utf8');
      const report = JSON.parse(content) as ValidationReport;
      console.info(styleText('cyan', '📊 [browser-diagnostics]'), filename);
      process.stdout.write(`${content}\n`);
      summary += `Environment: ${JSON.stringify(report.environment)}\n\n`;
      if (report.summaries !== undefined) {
        summary += '| Scenario | Completed samples | p95 ms |\n| --- | ---: | ---: |\n';
        for (const [scenario, result] of Object.entries(report.summaries)) summary += `| ${scenario} | ${result.samples}/${report.samples} | ${result.p95Milliseconds?.toFixed(1) ?? 'unavailable'} |\n`;
        summary += '\nTargets: successful action p95 ≤500 ms; snapshot p95 ≤1,000 ms. Partial samples do not establish a passing gate.\n';
      } else {
        const completed = report.measurements.filter(measurement => measurement.error === undefined).length;
        summary += `Lifecycle scenarios completed: ${completed}/${(report.cycles ?? 30) * 4}. Recorded failures: ${report.measurements.length - completed}.\n`;
      }
    } catch (error) {
      console.error(styleText('red', '❌ [browser-diagnostics]'), filename, error);
      summary += 'Report unavailable. This suite did not establish a passing result; inspect its test logs.\n';
      process.exitCode = 1;
    }
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

void main();
