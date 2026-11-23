// Consola's file (vendor/t3code/UPSTREAM.md, "Local changes to copied files"). The
// package's test config: the shared `../../vite.config.ts`, minus the tests of
// what Consola's copy no longer does (below).
import baseConfig from "../../vite.config.ts";

// Not run here: Consola's copy of `src/server/driver.ts` never reads OpenCode Go
// usage, because that read takes the person's OpenCode API key from OpenCode's
// own `auth.json` and `opencode.db` (`usageLimits.ts`), and Consola never reads a
// CLI's credentials. These tests drive that read through the driver. The tests
// of `readOpenCodeGoUsageLimits` itself (`status.test.ts`) still run.
export const NOT_RUN_HERE = [
  "Go usage recovery recovers without restarting a ready catalog",
  "Go usage recovery skips without demand without restarting a ready catalog",
  "Go usage recovery respects a disabled interval without restarting a ready catalog",
  "Go usage recovery skips unsupported usage without restarting a ready catalog",
  "reads Go usage from a stored key when the local server has no Console workspace",
];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    testNamePattern: `^(?!.*(?:${NOT_RUN_HERE.map(escapeRegExp).join("|")}))`,
  },
};
