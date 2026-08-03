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
    'src/broker.ts',
    'src/client.ts',
    'src/protocol.ts',
    'src/testing.ts',
  ],
  format: 'esm',
  platform: 'neutral',
  publint: true,
  sourcemap: true,
  target: 'es2024',
});
