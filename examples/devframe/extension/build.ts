import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { build } from 'vite';

async function main(): Promise<void> {
  const outDir = join(import.meta.dirname, '../dist/extension');
  for (const entry of ['worker', 'popup']) {
    await build({ configFile: false, logLevel: 'silent', build: { outDir, emptyOutDir: entry === 'worker', lib: { entry: join(import.meta.dirname, `${entry}.ts`), formats: ['es'], fileName: () => `${entry}.js` } } });
  }
  await mkdir(outDir, { recursive: true });
  await copyFile(join(import.meta.dirname, 'popup.html'), join(outDir, 'popup.html'));
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'CDB Devframe example', version: '0.1.0', action: { default_popup: 'popup.html' }, background: { service_worker: 'worker.js', type: 'module' }, permissions: ['debugger', 'tabs', 'tabGroups', 'webNavigation', 'storage', 'alarms'], host_permissions: ['http://127.0.0.1/*'] } satisfies chrome.runtime.ManifestV3, null, 2));
}

void main();
