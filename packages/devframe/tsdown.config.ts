import { defineConfig } from 'tsdown';

export default defineConfig({ deps: { neverBundle: true }, dts: { sourcemap: true }, entry: ['src/index.ts', 'src/client.ts', 'src/panel.ts', 'src/page-script.ts'], format: 'esm', platform: 'node', sourcemap: true, target: 'es2024' });
