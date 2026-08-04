import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
    },
    projects: [
      'packages/*/vitest.config.ts',
      {
        test: {
          environment: 'jsdom',
          include: ['tests/jsdom/**/*.test.ts'],
          name: 'unit-jsdom',
        },
      },
      {
        test: {
          browser: {
            enabled: true,
            headless: true,
            instances: [{ browser: 'chromium' }],
            provider: playwright(),
            trace: 'retain-on-failure',
          },
          include: ['tests/browser/**/*.test.ts'],
          globalSetup: ['tests/browser/global-setup.ts'],
          name: 'browser-chromium',
        },
      },
      {
        test: {
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          name: 'extension-e2e',
        },
      },
      {
        test: {
          environment: 'node',
          include: ['tests/package-consumers/**/*.test.ts'],
          name: 'package-consumers',
        },
      },
    ],
  },
});
