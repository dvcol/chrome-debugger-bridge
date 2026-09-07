import { builtinModules } from 'node:module';

import { defineTypescriptConfig } from '@dvcol/eslint-config';

const browserRestrictedImports = [
  ...builtinModules,
  'node:*',
  '@dvcol/cdb-mcp',
  '@dvcol/cdb-automation-playwright',
  '@dvcol/cdb-websocket/node',
  '@dvcol/cdb-birpc/node',
];

export default defineTypescriptConfig(
  {
    pnpm: {
      catalogs: true,
      sort: true,
    },
    type: 'lib',
  },
  {
    ignores: [
      '**/__traces__/**',
      '**/artifacts/**',
      '**/coverage/**',
      '**/dist/**',
      '**/*.md',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  {
    files: [
      'bump.config.ts',
      'eslint.config.ts',
      'examples/**/*.ts',
      'packages/*/scripts/**/*.ts',
      'packages/*/test/**/*.ts',
      'packages/*/tsdown.config.ts',
      'packages/*/vitest.config.ts',
      'tests/browser/**/*.ts',
      'tests/e2e/**/*.ts',
      'tests/fixtures/**/*.ts',
      'vitest.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.scripts.json'],
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/core/src/**/*.ts', 'packages/extension/src/**/*.ts', 'packages/websocket/src/**/*.ts', 'packages/birpc/src/client.ts'],
    ignores: ['packages/websocket/src/node.ts', 'packages/websocket/src/artifact-http.ts', 'packages/websocket/src/file-artifact-store.ts'],
    rules: {
      'node/no-restricted-import': ['error', browserRestrictedImports],
      'node/no-restricted-require': ['error', browserRestrictedImports],
      'ts/no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/node.*', '**/artifact-http.*', '**/file-artifact-store.*'],
          allowTypeImports: true,
        }],
      }],
    },
  },
  {
    files: ['package.json', '**/package.json'],
    rules: {
      'pnpm/json-enforce-catalog': [
        'error',
        {
          allowedProtocols: ['workspace'],
          conflicts: 'error',
          fields: [
            'dependencies',
            'devDependencies',
            'optionalDependencies',
            'peerDependencies',
          ],
        },
      ],
    },
  },
);
