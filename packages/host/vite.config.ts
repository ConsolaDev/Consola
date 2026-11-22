import { defineConfig } from 'vite-plus';

// Minimal on purpose: the vendored root config is t3's, with its task cache and
// package list. The host's tests are plain files under src/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Isolates the whole test process before any test file loads: a temporary
    // home, no CLI variables, and fake CLIs on the PATH (see the file).
    setupFiles: ['./src/testing/setup.ts'],
  },
});
