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
    'src/agent.ts',
    'src/authority.ts',
    'src/automation.ts',
    'src/broker.ts',
    'src/cdp-catalogue.ts',
    'src/client.ts',
    'src/embedded.ts',
    'src/grant-request.ts',
    'src/protocol.ts',
    'src/protocol-json-schema.ts',
    'src/session.ts',
    'src/testing.ts',
    'src/timing.ts',
  ],
  format: 'esm',
  platform: 'neutral',
  sourcemap: true,
  target: 'es2024',
});
