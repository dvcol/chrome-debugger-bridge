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
    'src/cdp-catalogue.ts',
    'src/client.ts',
    'src/embedded.ts',
    'src/protocol.ts',
    'src/protocol-json-schema.ts',
    'src/testing.ts',
  ],
  format: 'esm',
  platform: 'neutral',
  sourcemap: true,
  target: 'es2024',
});
