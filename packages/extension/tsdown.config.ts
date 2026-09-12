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
    'src/chrome.ts',
    'src/notifications.ts',
    'src/bootstrap.ts',
    'src/presentation.ts',
    'src/testing.ts',
  ],
  format: 'esm',
  platform: 'browser',
  sourcemap: true,
  target: 'chrome125',
});
