import { defineConfig } from 'tsdown';

export default defineConfig({ deps: { neverBundle: true }, dts: { sourcemap: true }, entry: ['src/index.ts', 'src/contract.ts'], format: 'esm', platform: 'node', sourcemap: true, target: 'node24' });
