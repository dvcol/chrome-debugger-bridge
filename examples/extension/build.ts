import type { GrantFlowHostConfiguration } from '../standalone-host/grant-flow.ts';

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const exampleDirectory = dirname(fileURLToPath(import.meta.url));

export async function buildApprovalExtension({ configuration, outDir = join(exampleDirectory, 'dist') }: {
  readonly configuration: GrantFlowHostConfiguration;
  readonly outDir?: string;
}): Promise<string> {
  for (const entry of ['service-worker', 'popup', 'content-script']) {
    await build({
      build: {
        emptyOutDir: entry === 'service-worker',
        lib: {
          entry: join(exampleDirectory, `${entry}.ts`),
          fileName: () => `${entry}.js`,
          formats: [entry === 'content-script' ? 'iife' : 'es'],
          name: 'CdbApprovalExample',
        },
        outDir,
      },
      configFile: false,
      logLevel: 'silent',
    });
  }
  await mkdir(outDir, { recursive: true });
  await copyFile(join(exampleDirectory, 'popup.html'), join(outDir, 'popup.html'));
  await writeFile(join(outDir, 'configuration.json'), JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({
    action: { default_popup: 'popup.html', default_title: 'Review CDB browser access' },
    background: { service_worker: 'service-worker.js', type: 'module' },
    content_scripts: [{ js: ['content-script.js'], matches: ['http://*/*', 'https://*/*'] }],
    host_permissions: ['http://127.0.0.1/*'],
    manifest_version: 3,
    name: 'CDB trusted approval example',
    permissions: ['debugger', 'storage', 'tabs', 'tabGroups', 'webNavigation'],
    version: '0.0.0',
  } satisfies chrome.runtime.ManifestV3, null, 2));
  return outDir;
}
