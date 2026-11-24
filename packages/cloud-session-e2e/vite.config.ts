// @effect-diagnostics nodeBuiltinImport:off - It finds the host's setup file on disk.
import { createRequire } from 'node:module';
import { defineConfig } from 'vite-plus';

/**
 * The host's own setup file (`@consola/host`'s `src/testing/setup.ts`): before the test file loads,
 * the test process gets a temporary home, no CLI variable, and a `PATH` of fake CLIs, so nothing
 * it runs can reach the developer's own CLIs.
 */
const HOST_SETUP = createRequire(import.meta.url).resolve('@consola/host/src/testing/setup.ts');

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: [HOST_SETUP],
  },
});
