import { defineConfig } from 'vitest/config';

// Deliberately not extending vite.config.ts: that config roots itself at
// src/renderer, which would make main-process and shared tests invisible.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
