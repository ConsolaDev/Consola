import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests read the workspace package from source, so they run on a fresh
    // clone without building it first.
    alias: {
      '@consola/factory-spec': path.resolve(__dirname, '../factory-spec/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
