import { defineConfig } from 'tsdown';

export default defineConfig({
  deps: {
    neverBundle: true,
  },
  dts: {
    sourcemap: true,
  },
  entry: [
    'src/index.ts',
    'src/bootstrap.ts',
    'src/testing.ts',
  ],
  format: 'esm',
  platform: 'browser',
  publint: true,
  sourcemap: true,
  target: 'chrome125',
});
