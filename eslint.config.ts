import { defineTypescriptConfig } from '@dvcol/eslint-config';

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
      'eslint.config.ts',
      'packages/*/test/**/*.ts',
      'packages/*/tsdown.config.ts',
      'packages/*/vitest.config.ts',
      'scripts/**/*.ts',
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
