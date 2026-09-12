import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./src/', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/view/', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome125',
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: { 'page-script': fileURLToPath(new URL('./src/page-script.ts', import.meta.url)) },
      output: { entryFileNames: '[name].js' },
    },
  },
});
