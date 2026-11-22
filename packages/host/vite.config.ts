import { defineConfig } from 'vite-plus';

// Minimal on purpose: the vendored root config is t3's, with its task cache and
// package list. The host's tests are plain files under src/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
