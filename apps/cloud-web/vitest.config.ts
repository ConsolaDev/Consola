import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // The boundary test reads every source file's syntax tree, and the contract's test
      // generates the API's types again; on a busy machine either can run past Vitest's default
      // five seconds. The API allows thirty, for the same reason.
      testTimeout: 30_000,
    },
  }),
);
