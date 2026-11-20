import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Deliberately not extending vite.config.ts: that config roots itself at
// src/renderer, which would make main-process and shared tests invisible.
export default defineConfig({
  resolve: {
    // Tests read the workspace package from source, so `pnpm test` works on a
    // fresh clone without building it first. The app itself loads its dist.
    alias: {
      '@consola/factory-spec': path.resolve(__dirname, '../../packages/factory-spec/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Node 25+ defines a global `localStorage` that reads as undefined unless
    // `--localstorage-file` is given. zustand's persist storage then wraps
    // undefined and throws on the first write, where a missing global made it
    // a quiet no-op, as it is on Node 22. Off, the stores see no storage again.
    execArgv: ['--no-experimental-webstorage'],
  },
});
