// Consola's file (vendor/t3code/UPSTREAM.md, "Lifted by Consola"). Claude's tests
// live in the lifted server tree, which `test` runs from (`--dir .` in
// apps/server). They are selected by their path under it: every Claude test
// file's name starts with `Claude` or `claude`, and nothing else is matched, so
// the selection does not depend on where the checkout lives.
import baseConfig from "../../vite.config.ts";

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["src/**/{Claude,claude}*.test.ts"],
  },
};
