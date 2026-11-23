import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // The boundary test reads every source file's syntax tree, and the contracts' tests
      // generate the APIs' types again; on a busy machine either can run past Vitest's default
      // five seconds. The cell and cloud-global allow thirty, for the same reason.
      testTimeout: 30_000,
    },
  }),
);
