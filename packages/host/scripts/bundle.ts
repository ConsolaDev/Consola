// @effect-diagnostics nodeBuiltinImport:off - A build script: it reads the source tree and writes the bundle.
/**
 * Builds the host as the `consola-session` sandbox template runs it (`sandbox-template/`), for
 * Node 26, from the repository root:
 *
 *   pnpm --filter @consola/host bundle
 *
 * - `dist/consola-host.mjs`: the host, one ESM file from the bin (`src/main.ts`), which listens for
 *   SIGTERM and SIGINT before it loads the program (`AGENTS.md`, "Signals").
 * - `dist/claude-history-worker.mjs`: t3's Claude history worker (`t3/claude-history-worker.ts`),
 *   which t3's Claude adapter runs as a process of its own, from beside the file it runs in
 *   (`./claude-history-worker.mjs`), to read a Claude conversation it resumes.
 *
 * Each holds everything it runs but Node's own modules, so the two run from a folder of their own
 * (`/opt/consola` in the template), with these exceptions:
 *
 * - `@ff-labs/fff-node` (t3's workspace file search) and `ffi-rs` (the native bridge it, and t3 on
 *   demand, load), which t3 loads with a `require` it makes at run time
 *   (`createRequire(import.meta.url)`), so from beside the bundle: the host loads `fff-node` as it
 *   starts. Both are external, and the template installs them under `/opt/consola/node_modules`,
 *   with their `linux-x64-gnu` builds and t3's patch to `fff-node` (`patches/`).
 * - `@napi-rs/keyring`, which t3's Antigravity driver requires the same way, to read
 *   Antigravity's sign-in from the system keyring (`antigravityUsageLimits.ts`). The template
 *   leaves it out on purpose: the host never hydrates that driver (a sandbox runs claude or
 *   codex), so nothing reaches the require. `ws`'s optional `bufferutil` and `utf-8-validate`,
 *   required inside a `try`, are left out too. `bundle.test.ts` fails on a run-time require
 *   it does not name.
 * - The Cursor SDK (`@cursor/sdk`), which is never in the bundle: t3's orchestration reaches
 *   `@t3tools/provider-cursor/server*` statically (`AGENTS.md`, "The Cursor SDK is in the
 *   runtime's module graph"), so those modules are stubbed (`CURSOR_STUBS`), and the build fails
 *   should `@cursor/sdk` still appear in what it wrote.
 *
 * The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is bundled, at the version the lockfile
 * resolves: neither file is published, and they live only in Consola's private template
 * (`AGENTS.md`, "Licensing").
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as esbuild from 'esbuild';

const PACKAGE = join(import.meta.dirname, '..');
const DIST = join(PACKAGE, 'dist');
/** Each file written, by name, from its entry. */
const ENTRIES: Readonly<Record<string, string>> = {
  'consola-host': join(PACKAGE, 'src', 'main.ts'),
  // The `t3` package is t3's server, lifted (`vendor/t3code/apps/server`).
  'claude-history-worker': join(PACKAGE, 'node_modules', 't3', 'src', 'claude-history-worker.ts'),
};
/** What esbuild says went into each file, and what each imports (`bundle.test.ts` reads it). */
const METAFILE = join(DIST, 'consola-host.meta.json');
/** The packages t3 requires at run time from beside the bundle, which the template installs. */
const RUN_TIME_PACKAGES = ['@ff-labs/fff-node', 'ffi-rs'];

/** What the bundle may never hold. */
const CURSOR_SDK = '@cursor/sdk';

/** The modules of t3's Cursor provider that load its SDK, each stubbed. */
const CURSOR_SERVER = /^@t3tools\/provider-cursor\/server(?:\/.*)?$/;

/** What calling into a stub says: Cursor is no harness of the host's. */
const NOT_BUNDLED = `const notBundled = (what) => () => {
  throw new Error(\`\${what}: t3's Cursor provider is not in the Consola host's bundle.\`);
};`;

/**
 * A stand-in for each module of `@t3tools/provider-cursor/server*` the host's graph imports, with
 * the exports its importers read as their modules load, and nothing that reaches the SDK:
 *
 * - `server`: `CursorDriver`, which t3's `builtInDrivers.ts` lists, and whose kind and metadata
 *   `deriveProviderInstanceConfigMap` reads (as the real driver's: `cursor`, a default instance).
 *   The host hydrates only its session's driver (`hostDriverFor`), never Cursor's, so creating
 *   one, or reading its settings, throws.
 * - `server/CursorSdk`: the `CursorSdk` service and its `layer`, which t3's
 *   `ProviderOrchestrationAdapterInfrastructure.layer` merges. The layer provides the service,
 *   as the real one does; loading the SDK through it throws.
 * - `server/CursorAgentSdkProcessRunner`: its `layer`, merged there too, which provides nothing:
 *   only Cursor's adapter, never created, reads its runner.
 *
 * Any other path is a build failure, so a re-sync that reaches another of them is noticed here.
 */
const CURSOR_STUBS: Readonly<Record<string, string>> = {
  '@t3tools/provider-cursor/server': `${NOT_BUNDLED}
export const CursorDriver = {
  driverKind: 'cursor',
  metadata: { displayName: 'Cursor', supportsMultipleInstances: true },
  get configSchema() {
    return notBundled('CursorDriver.configSchema')();
  },
  defaultConfig: notBundled('CursorDriver.defaultConfig'),
  create: notBundled('CursorDriver.create'),
};`,
  '@t3tools/provider-cursor/server/CursorSdk': `${NOT_BUNDLED}
import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';
export class CursorSdk extends Context.Service()('@t3tools/provider-cursor/server/CursorSdk') {}
export const layer = Layer.succeed(CursorSdk, {
  load: notBundled('CursorSdk.load'),
  loadSqlite: notBundled('CursorSdk.loadSqlite'),
});`,
  '@t3tools/provider-cursor/server/CursorAgentSdkProcessRunner': `import * as Layer from 'effect/Layer';
export const layer = () => Layer.empty;`,
};

const stubCursor: esbuild.Plugin = {
  name: 'consola-stub-cursor',
  setup(build) {
    build.onResolve({ filter: CURSOR_SERVER }, (args) => {
      if (CURSOR_STUBS[args.path] === undefined) {
        return {
          errors: [
            {
              text: `${args.path} has no stub: the host's graph reaches it now (from ${relative(PACKAGE, args.importer)}); add one to CURSOR_STUBS in scripts/bundle.ts.`,
            },
          ],
        };
      }
      // Resolved where its importer sits, so `effect` is the copy the importer uses.
      return { path: args.path, namespace: 'cursor-stub', pluginData: args.resolveDir };
    });
    build.onLoad({ filter: /.*/, namespace: 'cursor-stub' }, (args) => ({
      contents: CURSOR_STUBS[args.path] ?? '',
      loader: 'js',
      resolveDir: args.pluginData as string,
    }));
  },
};

/**
 * CommonJS modules in an ESM bundle reach `require`, `__filename` and `__dirname`, which ESM
 * does not have: the bundle makes them, for its own file.
 */
const BANNER = [
  "import { createRequire as __consolaCreateRequire } from 'node:module';",
  "import { fileURLToPath as __consolaFileURLToPath } from 'node:url';",
  "import { dirname as __consolaDirname } from 'node:path';",
  'const require = __consolaCreateRequire(import.meta.url);',
  'const __filename = __consolaFileURLToPath(import.meta.url);',
  'const __dirname = __consolaDirname(__filename);',
].join('\n');

const built = await esbuild.build({
  // Paths in the metafile are the package's, wherever the script runs from.
  absWorkingDir: PACKAGE,
  entryPoints: ENTRIES,
  outdir: DIST,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  external: RUN_TIME_PACKAGES,
  plugins: [stubCursor],
  banner: { js: BANNER },
  // Names stay as written where two modules share one, for code that reads a class's name.
  keepNames: true,
  logLevel: 'warning',
  metafile: true,
});
writeFileSync(METAFILE, JSON.stringify(built.metafile));

for (const name of Object.keys(ENTRIES)) {
  const file = join(DIST, `${name}.mjs`);
  if (readFileSync(file, 'utf8').includes(CURSOR_SDK)) {
    throw new Error(
      `${relative(PACKAGE, file)} names ${CURSOR_SDK}, which is never bundled: find what reaches it, and stub it.`,
    );
  }
  const megabytes = (statSync(file).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`Wrote ${relative(PACKAGE, file)} (${megabytes} MB).\n`);
}
