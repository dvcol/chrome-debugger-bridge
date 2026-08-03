import type { UserConfig } from 'tsdown';

import { defineConfig } from 'tsdown';

const sharedConfiguration = {
  deps: {
    neverBundle: true,
  },
  dts: {
    sourcemap: true,
  },
  format: 'esm' as const,
  outDir: 'dist',
  publint: true,
  sourcemap: true,
} satisfies UserConfig;

export default defineConfig([
  {
    ...sharedConfiguration,
    clean: true,
    entry: ['src/browser.ts', 'src/testing.ts'],
    platform: 'browser',
    target: 'chrome125',
  },
  {
    ...sharedConfiguration,
    clean: false,
    entry: ['src/node.ts'],
    platform: 'node',
    target: 'node24',
  },
]);
