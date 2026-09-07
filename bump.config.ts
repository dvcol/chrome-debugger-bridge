import { defineConfig } from 'bumpp';

export default defineConfig({
  commit: 'chore: release v%s',
  execute: 'pnpm verify',
  push: false,
  recursive: true,
  tag: 'v%s',
});
