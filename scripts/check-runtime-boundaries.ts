import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { styleText } from 'node:util';

const browserEntryPaths = [
  'packages/extension/src/index.ts',
  'packages/extension/src/bootstrap.ts',
  'packages/extension/src/pairing-store.ts',
  'packages/websocket/src/browser.ts',
  'packages/websocket/src/authentication.ts',
  'packages/devframe/src/client.ts',
];
const browserOutputPaths = [
  'packages/extension/dist/bootstrap.js',
  'packages/extension/dist/index.js',
  'packages/extension/dist/testing.js',
  'packages/websocket/dist/browser.js',
  'packages/websocket/dist/testing.js',
  'packages/devframe/dist/client.js',
];
const nodeImportMarkers = [
  "from 'node:",
  'from "node:',
  "import('node:",
  'import("node:',
  "require('node:",
  'require("node:',
];
const workspaceRoot = process.cwd();
const violations: string[] = [];

for (const browserFilePath of [...browserEntryPaths, ...browserOutputPaths]) {
  let source;
  try {
    source = await readFile(join(workspaceRoot, browserFilePath), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && browserOutputPaths.includes(browserFilePath)) {
      continue;
    }
    throw error;
  }
  if (nodeImportMarkers.some(nodeImportMarker => source.includes(nodeImportMarker))) {
    violations.push(`${browserFilePath} imports a Node built-in module`);
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(styleText('red', '❌ [runtime]'), violation);
  }
  process.exitCode = 1;
} else {
  console.info(styleText('green', '✅ [runtime]'), 'validated browser entry boundaries');
}
