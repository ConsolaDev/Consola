// @effect-diagnostics nodeBuiltinImport:off - It builds a throwaway machine on disk for a test.
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vite-plus/test';

/** The CLIs the host's drivers look for on the PATH. */
export const FAKE_CLIS = ['claude', 'codex', 'opencode', 'pi'] as const;

/**
 * The variables t3's five drivers, and the tools they run to find out how a CLI was installed,
 * read for a CLI's config, login, data or install (found in their source). `cliVariablesIn` adds
 * every variable set under one of `CLI_VARIABLE_PREFIXES`, as t3's own tests clear them
 * (`packages/shared/src/testing/providerEnv.ts`).
 */
const CLI_VARIABLES = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_API_KEY',
  'OPENCODE_DB',
  'OPENCODE_DATA_DIR',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_PASSWORD',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'KIMI_CODE_HOME',
  'MISE_DATA_DIR',
  'MISE_INSTALLS_DIR',
  'MISE_INSTALL_STORE_DIR',
  'MISE_SYSTEM_DATA_DIR',
  'MISE_SYSTEM_INSTALLS_DIR',
  'FNM_DIR',
  'FNM_MULTISHELL_PATH',
  'VP_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
];

const CLI_VARIABLE_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'CODEX_',
  'OPENAI_',
  'OPENCODE_',
  'PI_',
  'KIMI_',
  'T3CODE_',
  'MISE_',
  'FNM_',
];

/** The CLI variables to clear from `env`: `CLI_VARIABLES` and every one set under a prefix. */
export const cliVariablesIn = (env: NodeJS.ProcessEnv): string[] => [
  ...new Set([
    ...CLI_VARIABLES,
    ...Object.keys(env).filter((name) =>
      CLI_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  ]),
];

/** `HOME`, `USERPROFILE` and the XDG folders, all under `home`. */
export const homeVariables = (home: string): Record<string, string> => ({
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  XDG_CACHE_HOME: join(home, '.cache'),
});

/** The `PATH` of a machine whose CLIs are the fakes in `bin`; `/usr/bin:/bin` for `git`, `sh`. */
export const pathWith = (bin: string): string => `${bin}:/usr/bin:/bin`;

/** One run of a fake CLI: which, the HOME and config folders it saw, and its arguments. */
export type CliCall = {
  cli: string;
  home: string;
  claudeConfigDir: string;
  codexHome: string;
  args: string;
};

/** A fake CLI: it records its call and fails, so no real CLI on the machine ever runs. */
const fakeCli = (name: string, record: string) =>
  [
    '#!/bin/sh',
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\n' '${name}' "\${HOME-}" "\${CLAUDE_CONFIG_DIR-}" "\${CODEX_HOME-}" "$*" >> '${record}'`,
    'exit 1',
    '',
  ].join('\n');

/** Writes a fake of each CLI in `names` into `bin`, every one recording to `record`. */
export const writeFakeClis = (
  bin: string,
  record: string,
  names: ReadonlyArray<string> = FAKE_CLIS,
) => {
  for (const name of names) {
    const script = join(bin, name);
    writeFileSync(script, fakeCli(name, record));
    chmodSync(script, 0o755);
  }
};

/** Every call recorded in `record`. */
export const readCalls = (record: string): CliCall[] =>
  readFileSync(record, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [cli = '', home = '', claudeConfigDir = '', codexHome = '', args = ''] =
        line.split('\t');
      return { cli, home, claudeConfigDir, codexHome, args };
    });

/**
 * Where to copy every recorded call, for a person reading a run (`CONSOLA_HOST_CLI_RECORD`); read
 * once, before any test changes the environment.
 */
const RECORD_COPY = process.env.CONSOLA_HOST_CLI_RECORD;

/** Appends `calls` (or that none ran) to `RECORD_COPY`, each line headed by `label`. */
export const copyRecord = (label: string, calls: ReadonlyArray<CliCall>) => {
  if (RECORD_COPY === undefined) return;
  const lines = calls.map((call) => `${label}\t${Object.values(call).join('\t')}\n`);
  appendFileSync(RECORD_COPY, lines.length > 0 ? lines.join('') : `${label}\t(no CLI ran)\n`);
};

type Machine = { root: string; home: string; bin: string; binWithout: string; record: string };

/**
 * Runs each test of the file on a machine of its own: the test process's `HOME` (and
 * `USERPROFILE`, the XDG folders) is a temporary folder, every variable a driver reads for a CLI's
 * config or login is cleared, and `PATH` is a folder of fake CLIs (`FAKE_CLIS`) before
 * `/usr/bin:/bin` (for `git` and `sh`). A fake records its call and exits 1, so the developer's
 * own CLIs never run. After each test, every recorded call must have seen the test's home and no
 * CLI config folder. `withoutCli(name)` takes one fake off the PATH for the rest of a test.
 * `vi.stubEnv` restores the environment after each test, to the one `./setup.ts` gave the process.
 */
export function isolateMachine() {
  let machine: Machine | undefined;
  const current = (): Machine => {
    if (machine === undefined) throw new Error('isolateMachine: no test is running.');
    return machine;
  };

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'consola-host-machine-'));
    const next: Machine = {
      root,
      home: join(root, 'home'),
      bin: join(root, 'bin'),
      binWithout: join(root, 'bin-without'),
      record: join(root, 'cli-calls.tsv'),
    };
    for (const dir of [next.home, next.bin, next.binWithout]) mkdirSync(dir, { recursive: true });
    writeFileSync(next.record, '');
    writeFakeClis(next.bin, next.record);
    machine = next;

    for (const [name, value] of Object.entries(homeVariables(next.home))) vi.stubEnv(name, value);
    vi.stubEnv('PATH', pathWith(next.bin));
    for (const name of cliVariablesIn(process.env)) vi.stubEnv(name, undefined);
  });

  afterEach(({ task }) => {
    const { root, home } = current();
    const recorded = calls();
    copyRecord(task.fullName ?? task.name, recorded);
    vi.unstubAllEnvs();
    machine = undefined;
    rmSync(root, { recursive: true, force: true });
    for (const call of recorded) {
      expect(call).toMatchObject({ home, claudeConfigDir: '', codexHome: '' });
    }
  });

  /** Every fake CLI run so far in this test. */
  const calls = (): CliCall[] => readCalls(current().record);

  /** Takes the fake `name` off the PATH, leaving the other fakes. */
  const withoutCli = (name: (typeof FAKE_CLIS)[number]) => {
    const { binWithout, record } = current();
    writeFakeClis(
      binWithout,
      record,
      FAKE_CLIS.filter((other) => other !== name),
    );
    vi.stubEnv('PATH', pathWith(binWithout));
  };

  return {
    calls,
    withoutCli,
    /** The test's home. */
    home: () => current().home,
  };
}
