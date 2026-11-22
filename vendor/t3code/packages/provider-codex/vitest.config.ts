// Consola's file (vendor/t3code/UPSTREAM.md, "Lifted by Consola"). Codex's tests
// live in the lifted server tree, which `test` runs from (`--dir .` in
// apps/server). They are selected by their path under it: every Codex test
// file's name starts with `Codex` or `codex`, and nothing else is matched, so
// the selection does not depend on where the checkout lives. The server's own
// config supplies the tests that are not run here.
import serverConfig from "../../apps/server/vitest.config.ts";

export default {
  ...serverConfig,
  test: {
    ...serverConfig.test,
    include: ["src/**/{Codex,codex}*.test.ts"],
  },
};
