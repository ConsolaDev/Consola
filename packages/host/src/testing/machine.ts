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
 * The variables t3's five drivers read to find a CLI's config, login or data (found in their
 * source); each is cleared for a test. `HOME`, `USERPROFILE`, `PATH` and the XDG folders are
 * set to the test's own instead.
 */
const CLI_VARIABLES = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'ANTHROPIC_API_KEY',
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
  'MISE_DATA_DIR',
  'MISE_INSTALLS_DIR',
  'MISE_SYSTEM_DATA_DIR',
  'FNM_DIR',
  'FNM_MULTISHELL_PATH',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
];

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

type Machine = { root: string; home: string; bin: string; binWithout: string; record: string };

/**
 * Where to copy every test's calls, for a person reading a run (`CONSOLA_HOST_CLI_RECORD`); read
 * once, before any test changes the environment.
 */
const RECORD_COPY = process.env.CONSOLA_HOST_CLI_RECORD;

/**
 * Runs each test of the file on a machine of its own: the test process's `HOME` (and
 * `USERPROFILE`, the XDG folders) is a temporary folder, every variable a driver reads for a CLI's
 * config or login is cleared, and `PATH` is a folder of fake CLIs (`FAKE_CLIS`) before
 * `/usr/bin:/bin` (for `git` and `sh`). A fake records its call and exits 1, so the developer's
 * own CLIs never run. After each test, every recorded call must have seen the test's home and no
 * CLI config folder. `withoutCli(name)` takes one fake off the PATH for the rest of a test.
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
    for (const name of FAKE_CLIS) {
      const script = join(next.bin, name);
      writeFileSync(script, fakeCli(name, next.record));
      chmodSync(script, 0o755);
    }
    machine = next;

    vi.stubEnv('HOME', next.home);
    vi.stubEnv('USERPROFILE', next.home);
    vi.stubEnv('XDG_CONFIG_HOME', join(next.home, '.config'));
    vi.stubEnv('XDG_DATA_HOME', join(next.home, '.local', 'share'));
    vi.stubEnv('XDG_STATE_HOME', join(next.home, '.local', 'state'));
    vi.stubEnv('XDG_CACHE_HOME', join(next.home, '.cache'));
    vi.stubEnv('PATH', `${next.bin}:/usr/bin:/bin`);
    for (const name of CLI_VARIABLES) vi.stubEnv(name, undefined);
  });

  afterEach(({ task }) => {
    const { root, home } = current();
    const recorded = calls();
    if (RECORD_COPY !== undefined) {
      const test = task.fullName ?? task.name;
      const lines = recorded.map((call) => `${test}\t${Object.values(call).join('\t')}\n`);
      appendFileSync(RECORD_COPY, lines.length > 0 ? lines.join('') : `${test}\t(no CLI ran)\n`);
    }
    vi.unstubAllEnvs();
    machine = undefined;
    rmSync(root, { recursive: true, force: true });
    for (const call of recorded) {
      expect(call).toMatchObject({ home, claudeConfigDir: '', codexHome: '' });
    }
  });

  /** Every fake CLI run so far in this test. */
  const calls = (): CliCall[] =>
    readFileSync(current().record, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [cli = '', home = '', claudeConfigDir = '', codexHome = '', args = ''] =
          line.split('\t');
        return { cli, home, claudeConfigDir, codexHome, args };
      });

  /** Takes the fake `name` off the PATH, leaving the other fakes. */
  const withoutCli = (name: (typeof FAKE_CLIS)[number]) => {
    const { bin, binWithout, record } = current();
    for (const other of FAKE_CLIS) {
      if (other === name) continue;
      const script = join(binWithout, other);
      writeFileSync(script, fakeCli(other, record));
      chmodSync(script, 0o755);
    }
    vi.stubEnv('PATH', `${binWithout}:/usr/bin:/bin`);
    return bin;
  };

  return {
    calls,
    withoutCli,
    /** The test's home. */
    home: () => current().home,
  };
}
