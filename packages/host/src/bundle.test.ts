// @effect-diagnostics nodeBuiltinImport:off - It builds the host's bundle and runs it with node, and runs the sandbox's start script with sh.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Cause from 'effect/Cause';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { HOST_LINE_TYPES, readHostLine } from './core/hostLine.ts';
import { REDACTED, readSessionLine } from './core/runnerDecisions.ts';
import { isolateMachine } from './testing/machine.ts';

/**
 * The host as the `consola-session` sandbox template runs it: the ESM files `scripts/bundle.ts`
 * writes (the host, and t3's Claude history worker beside it), the template's definition, and its
 * start script (`sandbox-template/`), which clones the session's repository and runs the host.
 * Each test runs on a machine of its own (`./testing/machine.ts`): a temporary home and fake CLIs
 * first on the PATH.
 */
const machine = isolateMachine();

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_SCRIPT = join(PACKAGE, 'scripts', 'bundle.ts');
const DIST = join(PACKAGE, 'dist');
/** The files `scripts/bundle.ts` writes, as the template holds them in `/opt/consola`. */
const BUNDLE = join(DIST, 'consola-host.mjs');
const HISTORY_WORKER = join(DIST, 'claude-history-worker.mjs');
const METAFILE = join(DIST, 'consola-host.meta.json');
/** What t3 requires at run time from beside the bundle, which the template installs there. */
const RUN_TIME_PACKAGES = ['@ff-labs/fff-node', 'ffi-rs'];
const TEMPLATE = join(PACKAGE, 'sandbox-template');
const START_SCRIPT = join(TEMPLATE, 'consola-session-start');

/** Building the bundle and starting it (t3 loading, its drivers hydrating) take seconds. */
const BUILD_TIMEOUT_MS = 240_000;
const LINE_TIMEOUT = Duration.seconds(60);
const TEST_TIMEOUT_MS = 150_000;

/** Folders a test made, removed after it. */
const made: string[] = [];
const folder = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Hosts still running when a test ends are killed. */
const running = new Set<ChildProcess>();

afterEach(() => {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Exited = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** A bundle a test started: its stdout lines as they arrive, its stderr, and how it ended. */
type Started = {
  readonly printed: readonly string[];
  readonly next: () => Promise<string>;
  readonly stderr: () => string;
  readonly exited: Promise<Exited>;
  readonly signal: (signal: NodeJS.Signals) => void;
};

/**
 * The test machine's environment less `NODE_PATH`, which pnpm sets for the scripts it runs (the
 * test runner among them): with it, a bundle would find packages in the workspace's store that
 * no sandbox has.
 */
const sandboxedEnv = (): NodeJS.ProcessEnv => {
  const { NODE_PATH: _workspaceStore, ...env } = process.env;
  return env;
};

/** Starts `node <script> <args>` with the test machine's environment. */
const startNode = (script: string, args: readonly string[]): Started => {
  // The machine's PATH holds only fake CLIs and /usr/bin:/bin, so node is named by its path.
  const child = spawn(process.execPath, [script, ...args], {
    env: sandboxedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  const printed: string[] = [];
  const lines = Effect.runSync(Queue.unbounded<string, Cause.Done>());
  let buffered = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      printed.push(line);
      Queue.offerUnsafe(lines, line);
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<Exited>((resolve) => {
    child.on('exit', (code, signal) => {
      running.delete(child);
      Queue.endUnsafe(lines);
      resolve({ code, signal });
    });
  });
  const tail = () => `stderr:\n${stderr.slice(-4000)}`;
  const next = () =>
    Effect.runPromise(
      Queue.take(lines).pipe(
        Effect.catch(() => Effect.die(new Error(`the host ended first; ${tail()}`))),
        Effect.timeoutOrElse({
          duration: LINE_TIMEOUT,
          orElse: () => Effect.die(new Error(`no line from the host in time; ${tail()}`)),
        }),
      ),
    );
  return {
    printed,
    next,
    stderr: () => stderr,
    exited,
    signal: (signal) => child.kill(signal),
  };
};

/** Every line is one JSON object the runner reads as a `HostLine`. */
const expectOnlyHostLines = (printed: readonly string[]) => {
  for (const each of printed) {
    const line = readHostLine(JSON.parse(each));
    expect(line, each).not.toBeNull();
    expect(HOST_LINE_TYPES).toContain(line?.type);
  }
};

/** What esbuild says of the bundle (`scripts/bundle.ts` writes it beside the file). */
type Metafile = {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<
    Record<
      string,
      {
        readonly imports: ReadonlyArray<{
          readonly path: string;
          readonly kind: string;
          readonly external?: boolean;
        }>;
      }
    >
  >;
};

/**
 * `ws` requires its optional native helpers inside a `try`, and runs without them: the only
 * modules but Node's own the bundle names, and never installed.
 */
const OPTIONAL_REQUIRES = ['bufferutil', 'utf-8-validate'];

/**
 * Required at run time and never installed: t3's Antigravity driver reads Antigravity's sign-in
 * from the system keyring with it (`antigravityUsageLimits.ts`). The host never hydrates that
 * driver (a sandbox runs claude or codex), so nothing in it reaches the require.
 */
const ABSENT_ON_PURPOSE = ['@napi-rs/keyring'];

/**
 * Every module a bundled file requires by name as it runs, which esbuild leaves as calls in it
 * and its metafile does not list in full: `__require("…")` (a CommonJS `require` of a module it
 * did not bundle), and a call of each function made with `createRequire`, as t3 loads a package
 * from beside the running file (`requireForFff("@ff-labs/fff-node")`). A call written inside a
 * string (ajv's generated code) is not one.
 */
const runTimeRequiresOf = (text: string): string[] => {
  const escaped = (name: string) => name.replaceAll('$', String.raw`\$`);
  const makers = new Set(['createRequire']);
  for (const [, alias] of text.matchAll(/\bcreateRequire\s+as\s+([\w$]+)/g)) {
    if (alias !== undefined) makers.add(alias);
  }
  const made = new RegExp(
    `(?:^|[^\\w$.])([\\w$]+)\\s*=\\s*(?:/\\*\\s*@__PURE__\\s*\\*/\\s*)?(?:[\\w$]+\\.)?(?:${[...makers].map(escaped).join('|')})\\(`,
    'g',
  );
  const requirers = new Set(['__require']);
  for (const [, name] of text.matchAll(made)) if (name !== undefined) requirers.add(name);
  const targets = new Set<string>();
  for (const name of requirers) {
    const call = new RegExp(
      `(?:^|[^\\w$.'"\`])${escaped(name)}\\(\\s*(["'\`])([^"'\`]+)\\1\\s*\\)`,
      'g',
    );
    for (const [, , target] of text.matchAll(call)) if (target !== undefined) targets.add(target);
  }
  return [...targets].sort();
};

/** Where `name` is installed for t3's server (the lifted `t3` package), as a real path. */
const installedFor = (from: string, name: string): string =>
  dirname(realpathSync(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`)));

/**
 * A folder as the template's `/opt/consola`: the two files, and, unless `bare`, the packages t3
 * requires at run time, each the workspace's own (patched as pnpm installs it), in
 * `node_modules`. Nothing else of the workspace is reachable from it.
 */
const optFolder = ({ bare = false }: { readonly bare?: boolean } = {}): string => {
  const opt = folder('consola-host-opt-');
  copyFileSync(BUNDLE, join(opt, 'consola-host.mjs'));
  copyFileSync(HISTORY_WORKER, join(opt, 'claude-history-worker.mjs'));
  if (bare) return opt;
  const server = join(PACKAGE, 'node_modules', 't3');
  const fff = installedFor(server, '@ff-labs/fff-node');
  const installed: Record<string, string> = {
    '@ff-labs/fff-node': fff,
    'ffi-rs': installedFor(fff, 'ffi-rs'),
  };
  for (const name of RUN_TIME_PACKAGES) {
    const target = installed[name];
    if (target === undefined) throw new Error(`${name} is not installed for t3`);
    mkdirSync(dirname(join(opt, 'node_modules', name)), { recursive: true });
    symlinkSync(target, join(opt, 'node_modules', name));
  }
  return opt;
};

/** t3's settings in a state folder of the test's, update checks off: the host asks no one online. */
const offlineStateDir = (): string => {
  const stateDir = folder('consola-host-bundle-state-');
  mkdirSync(join(stateDir, 'userdata'));
  writeFileSync(
    join(stateDir, 'userdata', 'settings.json'),
    JSON.stringify({ enableProviderUpdateChecks: false }),
  );
  return stateDir;
};

describe('the host bundle', () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, [BUNDLE_SCRIPT], {
      cwd: PACKAGE,
      encoding: 'utf8',
      timeout: BUILD_TIMEOUT_MS,
    });
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
  }, BUILD_TIMEOUT_MS);

  it("is the host and t3's history worker, each one ESM file that imports nothing but Node, with no Cursor SDK", () => {
    const meta = JSON.parse(readFileSync(METAFILE, 'utf8')) as Metafile;
    expect(Object.keys(meta.outputs).sort()).toEqual([
      'dist/claude-history-worker.mjs',
      'dist/consola-host.mjs',
    ]);
    for (const [output, { imports }] of Object.entries(meta.outputs)) {
      expect(readFileSync(join(PACKAGE, output), 'utf8')).not.toContain('@cursor/sdk');
      expect(imports.length, output).toBeGreaterThan(0);
      for (const { path, kind, external } of imports) {
        expect(external, path).toBe(true);
        const allowed =
          isBuiltin(path) || (kind === 'require-call' && OPTIONAL_REQUIRES.includes(path));
        expect(allowed, `${output}: ${kind} ${path}`).toBe(true);
      }
    }
    // No module of t3's Cursor provider that loads its SDK, and no SDK; Claude's SDK is in it.
    const inputs = Object.keys(meta.inputs);
    expect(
      inputs.filter((input) => /@cursor\/sdk|provider-cursor\/src\/server/.test(input)),
    ).toEqual([]);
    expect(inputs.some((input) => input.includes('@anthropic-ai/claude-agent-sdk/'))).toBe(true);
  });

  it("requires as it runs only Node's modules, the packages the template installs beside it, ws's optional helpers, and Antigravity's keyring, which it never reaches", () => {
    const requiredBy = (file: string) =>
      runTimeRequiresOf(readFileSync(file, 'utf8')).filter((name) => !isBuiltin(name));
    expect(requiredBy(BUNDLE)).toEqual(
      [...RUN_TIME_PACKAGES, ...OPTIONAL_REQUIRES, ...ABSENT_ON_PURPOSE].sort(),
    );
    expect(requiredBy(HISTORY_WORKER)).toEqual([]);
    // The template installs the first, and leaves out the rest.
    for (const name of [...OPTIONAL_REQUIRES, ...ABSENT_ON_PURPOSE]) {
      expect(readFileSync(join(TEMPLATE, 'Dockerfile'), 'utf8')).not.toContain(name);
    }
  });

  it('reads what a bundle requires as it runs, however esbuild names the function', () => {
    expect(
      runTimeRequiresOf(
        [
          'import { createRequire as __consolaCreateRequire } from "node:module";',
          'import { createRequire as sX } from "node:module";',
          'const require = __consolaCreateRequire(import.meta.url);',
          'var a = __require("bufferutil");',
          'requireForFff = NodeModule4.createRequire(import.meta.url);',
          '({ FileFinder } = requireForFff("@ff-labs/fff-node"));',
          'var iX = sX(import.meta.url);',
          "iX('ffi-rs');",
          'Uj.code = \'require("ajv/dist/runtime/uri").default\';',
          'other("not-a-require");',
        ].join('\n'),
      ),
    ).toEqual(['@ff-labs/fff-node', 'bufferutil', 'ffi-rs']);
  });

  it.each(['claude', 'codex'])(
    'runs a %s session from a folder of its own to ready and dev-pass against fake CLIs, and exits 0 on SIGTERM',
    async (harness) => {
      const opt = optFolder();
      const cwd = folder('consola-host-bundle-acme-');
      const host = startNode(join(opt, 'consola-host.mjs'), [
        'session',
        '--dev',
        '--harness',
        harness,
        '--cwd',
        cwd,
        '--port',
        '0',
        '--state-dir',
        offlineStateDir(),
      ]);
      const ready = JSON.parse(await host.next());
      expect(ready).toEqual({ type: 'ready', port: expect.any(Number) });
      const devPass = JSON.parse(await host.next());
      expect(devPass).toEqual({
        type: 'dev-pass',
        pass: expect.any(String),
        expiresInSeconds: 43_200,
      });
      expect(host.stderr()).toContain(`consola-host: warning: turns in ${cwd} `);

      host.signal('SIGTERM');
      expect(await host.exited).toEqual({ code: 0, signal: null });
      expect(host.printed.map((each) => JSON.parse(each).type)).toEqual(['ready', 'dev-pass']);
      expectOnlyHostLines(host.printed);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not start without the packages t3 requires beside it, which the template installs',
    async () => {
      const host = startNode(join(optFolder({ bare: true }), 'consola-host.mjs'), [
        'session',
        '--dev',
        '--harness',
        'claude',
        '--cwd',
        folder('consola-host-bundle-acme-'),
        '--port',
        '0',
      ]);
      expect(await host.exited).toEqual({ code: 1, signal: null });
      expect(host.printed).toEqual([]);
      expect(host.stderr()).toContain("Cannot find module '@ff-labs/fff-node'");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs t3's history worker from the same folder, reading a Claude conversation",
    () => {
      const opt = optFolder();
      const sessionId = '7d3c3b5e-0000-4000-8000-00000000ac3e';
      const projects = join(machine.home(), '.claude', 'projects', 'sprocket');
      mkdirSync(projects, { recursive: true });
      writeFileSync(
        join(projects, `${sessionId}.jsonl`),
        `${JSON.stringify({
          type: 'user',
          uuid: 'message-sprocket-1',
          sessionId,
          parentUuid: null,
          cwd: '/workspace/repo',
          timestamp: '2026-11-23T10:00:00Z',
          message: { role: 'user', content: 'Tidy the Sprocket catalog' },
        })}\n`,
      );
      const ran = spawnSync(
        process.execPath,
        [join(opt, 'claude-history-worker.mjs'), 'getSessionMessages', sessionId, '{}'],
        { encoding: 'utf8', env: sandboxedEnv() },
      );
      expect(ran.status, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual([
        expect.objectContaining({
          type: 'user',
          uuid: 'message-sprocket-1',
          message: { role: 'user', content: 'Tidy the Sprocket catalog' },
        }),
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the consola-session template', () => {
  const dockerfile = () => readFileSync(join(TEMPLATE, 'Dockerfile'), 'utf8');

  it('is one stage of the instructions E2B builds', () => {
    const instructions = dockerfile()
      .split('\n')
      .filter((line) => /^[A-Z]+\s/.test(line))
      .map((line) => line.split(/\s/)[0]);
    expect(instructions.filter((name) => name === 'FROM')).toHaveLength(1);
    const built = [
      'FROM',
      'RUN',
      'COPY',
      'ADD',
      'WORKDIR',
      'USER',
      'ENV',
      'ARG',
      'CMD',
      'ENTRYPOINT',
    ];
    for (const name of instructions) expect(built, name).toContain(name);
  });

  it("pins Node 26.13.1, GitHub's CLI, both agent CLIs and t3's run-time packages, and its README names each", () => {
    const readme = readFileSync(join(TEMPLATE, 'README.md'), 'utf8');
    const pins: ReadonlyArray<readonly [string, RegExp]> = [
      ['Node', /node-v(\d+\.\d+\.\d+)-linux-x64\.tar\.xz/],
      ['GitHub CLI', /gh_(\d+\.\d+\.\d+)_linux_amd64\.tar\.gz/],
      ['Claude Code', /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)\s/],
      ['Codex', /@openai\/codex@(\d+\.\d+\.\d+)\s/],
      ['@ff-labs/fff-node', /@ff-labs\/fff-node@(\d+\.\d+\.\d+)\s/],
      ['@ff-labs/fff-bin-linux-x64-gnu', /@ff-labs\/fff-bin-linux-x64-gnu@(\d+\.\d+\.\d+)\s/],
      ['ffi-rs', /\sffi-rs@(\d+\.\d+\.\d+)\s/],
      ['@yuuang/ffi-rs-linux-x64-gnu', /@yuuang\/ffi-rs-linux-x64-gnu@(\d+\.\d+\.\d+)\s/],
    ];
    const versions = Object.fromEntries(
      pins.map(([name, pattern]) => [name, pattern.exec(dockerfile())?.[1] ?? null]),
    );
    expect(versions.Node).toBe('26.13.1');
    for (const [name, version] of Object.entries(versions)) {
      expect(version, name).not.toBeNull();
      expect(readme, name).toContain(`${version}`);
    }
    // E2B keeps an ARG as a variable of every command the sandbox runs.
    expect(dockerfile()).not.toMatch(/^ARG\s/m);
  });

  it('installs beside the bundle the run-time packages the workspace runs it with, fff-node patched as pnpm patches it', () => {
    const fff = installedFor(join(PACKAGE, 'node_modules', 't3'), '@ff-labs/fff-node');
    const installed: Record<string, string> = {
      '@ff-labs/fff-node': fff,
      'ffi-rs': installedFor(fff, 'ffi-rs'),
    };
    for (const name of RUN_TIME_PACKAGES) {
      const { version } = JSON.parse(
        readFileSync(join(installed[name] ?? '', 'package.json'), 'utf8'),
      ) as { readonly version: string };
      expect(dockerfile(), name).toMatch(
        new RegExp(`\\s${name}@${version.replaceAll('.', String.raw`\.`)}\\s`),
      );
    }
    // The patch pnpm applies to that version, which the Dockerfile applies too.
    const workspace = readFileSync(join(PACKAGE, '..', '..', 'pnpm-workspace.yaml'), 'utf8');
    const { version } = JSON.parse(readFileSync(join(fff, 'package.json'), 'utf8')) as {
      readonly version: string;
    };
    expect(workspace).toContain(
      `'@ff-labs/fff-node@${version}': patches/@ff-labs__fff-node@${version}.patch`,
    );
    expect(dockerfile()).toContain('git apply /tmp/fff-node.patch');
    expect(dockerfile()).toMatch(
      /COPY consola-host\.mjs claude-history-worker\.mjs \/opt\/consola\//,
    );
  });

  it("unpacks Node whole, so the licence notices in it, npm's own packages' among them, stay", () => {
    const node = /^RUN curl [^\n]*node-v[^\n]*(?:\n [^\n]*)*/m.exec(dockerfile())?.[0] ?? '';
    expect(node).toContain('tar -xJf /tmp/node.tar.xz');
    expect(node).not.toContain('--exclude');
  });

  it("removes the base image's own Node before unpacking Node 26 where it was", () => {
    // e2bdev/base has Node 20 with npm 10 in /usr/local: unpacked over it, npm 10's files stay
    // among npm 11's and npm fails to start.
    const text = dockerfile();
    const removal = /^RUN rm -rf \/usr\/local\/lib\/node_modules[^\n]*(?:\n [^\n]*)*/m.exec(text);
    expect(removal?.[0]).toMatch(/\/usr\/local\/bin\/npm\b/);
    expect(removal?.[0]).toMatch(/\/usr\/local\/bin\/corepack\b/);
    expect(removal?.index ?? Number.POSITIVE_INFINITY).toBeLessThan(
      text.indexOf('tar -xJf /tmp/node.tar.xz'),
    );
  });

  it("allows Claude Code's postinstall, which puts its native build in place of a placeholder, and no other", () => {
    const install = /^RUN npm install --global[^\n]*(?:\n [^\n]*)*/m.exec(dockerfile())?.[0] ?? '';
    expect(install).toContain('@anthropic-ai/claude-code@');
    expect([...install.matchAll(/--allow-scripts=(\S+)/g)].map((match) => match[1])).toEqual([
      '@anthropic-ai/claude-code',
    ]);
  });

  it('pins a Claude Code no older than the one the bundled Agent SDK names, nor than any model t3 offers needs', () => {
    const claudeCode = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)\s/.exec(dockerfile())?.[1];
    const server = join(PACKAGE, 'node_modules', 't3');
    const sdk = JSON.parse(
      readFileSync(
        join(
          dirname(
            realpathSync(
              createRequire(join(server, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk'),
            ),
          ),
          'package.json',
        ),
        'utf8',
      ),
    ) as { readonly claudeCodeVersion: string };
    const minimums: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      const { claudeCode } = value as { readonly claudeCode?: { readonly minVersion?: unknown } };
      if (typeof claudeCode?.minVersion === 'string') minimums.push(claudeCode.minVersion);
      for (const each of Object.values(value)) visit(each);
    };
    visit(JSON.parse(readFileSync(join(server, 'src', 'provider', 'model-manifest.json'), 'utf8')));
    expect(minimums.length).toBeGreaterThan(0);
    const parts = (version: string) => version.split('.').map(Number);
    const atLeast = (version: string, floor: string) => {
      const [a, b] = [parts(version), parts(floor)];
      for (let index = 0; index < 3; index += 1) {
        if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
      }
      return true;
    };
    expect(claudeCode).toBeDefined();
    for (const floor of [sdk.claudeCodeVersion, ...minimums]) {
      expect(atLeast(claudeCode ?? '0.0.0', floor), `${claudeCode} against ${floor}`).toBe(true);
    }
    // The README says why it is not the SDK's own.
    const readme = readFileSync(join(TEMPLATE, 'README.md'), 'utf8');
    expect(readme).toContain(sdk.claudeCodeVersion);
  });

  it("writes no t3 settings, whose launch arguments would override the host's approval mode", () => {
    for (const file of [dockerfile(), readFileSync(START_SCRIPT, 'utf8')]) {
      expect(file).not.toMatch(/settings\.json|userdata|--state-dir/);
    }
  });
});

describe('consola-session-start', () => {
  const SESSION_ID = 'session-sprocket-7';
  const REPOSITORY = 'sprocket/catalog-portal';
  /** Not a real token; its `/` and `+` make its URL-encoded form differ from it. */
  const GIT_TOKEN = 'ghs_Sprocket/Token+0123456789';
  const ANTHROPIC_KEY = 'sk-ant-sprocket-session-0123456789';
  const OPENAI_KEY = 'sk-openai-sprocket-session-0123456789';
  const PASS_PUBLIC_KEY = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();

  /** The real git, found on the machine's own folders (the fakes hold none). */
  const realGit = (): string => {
    const found = spawnSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    return found.stdout.trim();
  };

  const writeScript = (dir: string, name: string, lines: readonly string[]) => {
    const file = join(dir, name);
    writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'));
    chmodSync(file, 0o755);
  };

  /**
   * A machine for the script: a folder of stand-ins first on the PATH (each recording its
   * arguments, one per line, to `<name>.args`), and the workspace the script clones into.
   */
  const scriptMachine = () => {
    const root = folder('consola-session-start-');
    const bin = join(root, 'bin');
    const workspace = join(root, 'workspace');
    mkdirSync(bin);
    mkdirSync(workspace);
    const record = (name: string) =>
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${join(root, `${name}.args`)}'`;
    const argsOf = (name: string): string[] | null => {
      const file = join(root, `${name}.args`);
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1) : null;
    };
    return { root, bin, workspace, record, argsOf };
  };

  /** Runs the script with `sh`, with a sandbox's variables (and `env` over them). */
  const runScript = (
    scripted: ReturnType<typeof scriptMachine>,
    env: Readonly<Record<string, string | undefined>> = {},
  ) => {
    const variables: Record<string, string> = {
      HOME: machine.home(),
      PATH: `${scripted.bin}:${process.env.PATH ?? ''}`,
      CONSOLA_WORKSPACE: scripted.workspace,
      CONSOLA_SESSION_ID: SESSION_ID,
      CONSOLA_HARNESS: 'claude',
      CONSOLA_REPOSITORY: REPOSITORY,
      CONSOLA_PASS_PUBLIC_KEY: PASS_PUBLIC_KEY,
      CONSOLA_SESSION_IDLE_MINUTES: '10',
      GIT_TOKEN,
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete variables[name];
      else variables[name] = value;
    }
    return spawnSync('/bin/sh', [START_SCRIPT], { encoding: 'utf8', env: variables });
  };

  /** A git that clones as git would (an empty repository at the target) and is git otherwise. */
  const writeCloningGit = (scripted: ReturnType<typeof scriptMachine>) =>
    writeScript(scripted.bin, 'git', [
      'for arg in "$@"; do last="$arg"; done',
      'for arg in "$@"; do',
      '  if [ "$arg" = clone ]; then',
      `    ${scripted.record('git')}`,
      `    exec '${realGit()}' init -q "$last"`,
      '  fi',
      'done',
      `exec '${realGit()}' "$@"`,
    ]);

  /** A node that records how it was started, standing in for the host. */
  const writeRecordingNode = (scripted: ReturnType<typeof scriptMachine>) =>
    writeScript(scripted.bin, 'node', [scripted.record('node'), 'exit 0']);

  const hostArgs = (scripted: ReturnType<typeof scriptMachine>, harness: string) => [
    '/opt/consola/consola-host.mjs',
    'session',
    '--session-id',
    SESSION_ID,
    '--harness',
    harness,
    '--cwd',
    join(scripted.workspace, 'repo'),
    '--bind',
    '0.0.0.0',
    '--port',
    '7420',
    '--pass-public-key',
    join(scripted.workspace, '.consola', 'pass-public-key.pem'),
    '--idle-minutes',
    '10',
  ];

  const gitConfig = (repo: string, key: string): string =>
    spawnSync(realGit(), ['-C', repo, 'config', '--get', key], { encoding: 'utf8' }).stdout.trim();

  it(
    'on a failed clone prints one clone-failed line without the token, and exits 1',
    () => {
      const scripted = scriptMachine();
      // git puts a URL with credentials in its error text: the script takes the token out.
      writeScript(scripted.bin, 'git', [
        scripted.record('git'),
        `echo "fatal: unable to access 'https://x-access-token:${GIT_TOKEN}@github.com/${REPOSITORY}.git/': The requested URL returned error: 403" >&2`,
        `echo "remote: invalid credentials ${encodeURIComponent(GIT_TOKEN)}" >&2`,
        'exit 128',
      ]);
      symlinkSync(process.execPath, join(scripted.bin, 'node'));

      const ran = runScript(scripted);
      expect(ran.status, ran.stderr).toBe(1);
      const lines = ran.stdout.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const read = readSessionLine(lines[0] ?? '');
      expect(read).toEqual({ kind: 'clone-failed', message: expect.any(String) });
      const message = read.kind === 'clone-failed' ? read.message : '';
      expect(message).toContain(REPOSITORY);
      expect(message).toContain('The requested URL returned error: 403');
      expect(message).toContain(REDACTED);
      for (const output of [ran.stdout, ran.stderr]) {
        expect(output).not.toContain(GIT_TOKEN);
        expect(output).not.toContain(encodeURIComponent(GIT_TOKEN));
      }
      // The token was never on git's command line, and the address is the whole URL.
      const gitArgs = scripted.argsOf('git') ?? [];
      expect(gitArgs.join('\n')).not.toContain(GIT_TOKEN);
      expect(gitArgs.slice(-2)).toEqual([
        `https://github.com/${REPOSITORY}.git`,
        join(scripted.workspace, 'repo'),
      ]);
      // Nothing ran after the clone.
      expect(existsSync(join(scripted.workspace, '.consola'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'clones with a credential helper the repository keeps, writes the key, then runs the host',
    () => {
      const scripted = scriptMachine();
      writeCloningGit(scripted);
      writeRecordingNode(scripted);
      writeScript(scripted.bin, 'codex', [scripted.record('codex'), 'exit 0']);

      const ran = runScript(scripted, { CONSOLA_SESSION_IDLE_MINUTES: undefined });
      expect(ran.status, ran.stderr).toBe(0);
      // Stdout is the host's; the script says nothing there.
      expect(ran.stdout).toBe('');
      expect(scripted.argsOf('node')).toEqual(hostArgs(scripted, 'claude'));
      // A Claude session signs no Codex in.
      expect(scripted.argsOf('codex')).toBeNull();
      expect(
        readFileSync(join(scripted.workspace, '.consola', 'pass-public-key.pem'), 'utf8'),
      ).toBe(`${PASS_PUBLIC_KEY.trimEnd()}\n`);

      const gitArgs = scripted.argsOf('git') ?? [];
      expect(gitArgs.join('\n')).not.toContain(GIT_TOKEN);
      expect(gitArgs.slice(-2)).toEqual([
        `https://github.com/${REPOSITORY}.git`,
        join(scripted.workspace, 'repo'),
      ]);
      const repo = join(scripted.workspace, 'repo');
      expect(gitConfig(repo, 'user.name')).toBe('Consola session');
      expect(gitConfig(repo, 'user.email')).toBe('session@consola.invalid');
      expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain(GIT_TOKEN);

      // The helper the repository keeps reads the token from the environment when git asks.
      const helper = gitConfig(repo, 'credential.https://github.com.helper');
      expect(helper.startsWith('!')).toBe(true);
      const ask = (operation: string, token: string | undefined) =>
        spawnSync('/bin/sh', ['-c', `${helper.slice(1)} "$@"`, 'helper', operation], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', ...(token === undefined ? {} : { GIT_TOKEN: token }) },
        }).stdout;
      expect(ask('get', GIT_TOKEN)).toBe(`username=x-access-token\npassword=${GIT_TOKEN}\n`);
      expect(ask('store', GIT_TOKEN)).toBe('');
      expect(ask('get', undefined)).toBe('');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "signs Codex in with the session's API key on stdin before it runs the host",
    () => {
      const scripted = scriptMachine();
      writeCloningGit(scripted);
      writeRecordingNode(scripted);
      writeScript(scripted.bin, 'codex', [
        scripted.record('codex'),
        `cat > '${join(scripted.root, 'codex.stdin')}'`,
        'echo "Successfully logged in"',
      ]);

      const ran = runScript(scripted, {
        CONSOLA_HARNESS: 'codex',
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: OPENAI_KEY,
      });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stdout).toBe('');
      expect(scripted.argsOf('codex')).toEqual(['login', '--with-api-key']);
      expect(readFileSync(join(scripted.root, 'codex.stdin'), 'utf8')).toBe(OPENAI_KEY);
      expect(scripted.argsOf('node')).toEqual(hostArgs(scripted, 'codex'));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops before the host when Codex cannot sign in, saying so without the key',
    () => {
      const scripted = scriptMachine();
      writeCloningGit(scripted);
      writeRecordingNode(scripted);
      writeScript(scripted.bin, 'codex', [
        'cat > /dev/null',
        'echo "error: bad key" >&2',
        'exit 1',
      ]);

      const ran = runScript(scripted, {
        CONSOLA_HARNESS: 'codex',
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: OPENAI_KEY,
      });
      expect(ran.status).toBe(1);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toMatch(/consola-session-start: Codex could not sign in/);
      expect(ran.stderr).not.toContain(OPENAI_KEY);
      expect(scripted.argsOf('node')).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
