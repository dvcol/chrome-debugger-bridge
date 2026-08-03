import { defineConfig } from 'tsdown';

export default defineConfig({
  deps: {
    neverBundle: true,
  },
  dts: {
    sourcemap: true,
  },
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  publint: true,
  sourcemap: true,
  target: 'node24',
});
