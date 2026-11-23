// Consola's file (vendor/t3code/UPSTREAM.md, "Lifted by Consola"). The lifted
// server's test config: the shared `../../vite.config.ts`, minus the tests that
// need a file t3's server has and Consola does not lift (below).
import baseConfig from "../../vite.config.ts";

// Not run here: this test starts t3's CLI entry (`src/bin.ts`) as a child
// process to run the managed-ChatGPT token helper. `bin.ts` is not lifted (it
// pulls t3's whole CLI and HTTP server), and Consola never signs a CLI in. The
// file's other three tests run. A test whose name matches is skipped.
export const NOT_RUN_HERE = [
  "managed Codex primary account shares home state without routing owned tokens through ambient CLI overrides",
];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    testNamePattern: `^(?!.*(?:${NOT_RUN_HERE.map(escapeRegExp).join("|")}))`,
  },
};
