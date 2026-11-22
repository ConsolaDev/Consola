import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Most tests open a fresh PGlite database (Postgres compiled to WASM). One opens in about
    // half a second, but with every test file opening its first at once on a busy machine, one
    // can take ten seconds, past Vitest's defaults of five for a test and ten for a hook.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
