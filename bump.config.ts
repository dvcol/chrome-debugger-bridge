import { defineConfig } from 'bumpp';

export default defineConfig({
  commit: 'chore: release v%s',
  execute: 'pnpm verify',
  files: ['package.json', 'packages/*/package.json'],
  push: false,
  tag: 'v%s',
});
