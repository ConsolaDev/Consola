import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { getLoginEnv } from '../LoginEnvironment';
import { AntigravityDriver } from './AntigravityDriver';
import { ClaudeDriver } from './ClaudeDriver';
import { CodexDriver } from './CodexDriver';
import {
  AGENT_CLIS,
  isolateFromRealClis,
  isolateTestProcess,
  loginPathProblem,
  loginShellPath,
  systemInstallProblem,
  withoutAgentClis,
} from './realCliIsolation';

/*
 * Every desktop unit test runs after `realCliIsolation.setup.ts` (vitest's
 * `setupFiles`): its own home, config dirs and login shell, and a PATH that
 * holds no agent CLI. These tests prove it of the environment they run in,
 * through the drivers' own `resolveBinary`, with no mock in between: a
 * harness that names no binary finds nothing, so no unit test can reach the
 * person's CLI or profile. Nothing here spawns a CLI.
 */

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-cli-isolation-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeCli(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return file;
}

/**
 * A decoy standing for a real install: a runnable `name` in `dir` that only
 * records, in `ran`, that something ran it.
 */
function decoyCli(dir: string, name: string, ran: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "$0" >> '${ran}'\nexit 1\n`, { mode: 0o755 });
  return file;
}

/**
 * A login shell whose profile adds `added` to PATH, as macOS's `path_helper`
 * adds every folder of `/etc/paths` and `/etc/paths.d`: it answers
 * `-ilc 'env -0'` as a real one does, with what it was given and `added` first.
 */
function loginShellAdding(dir: string, added: string): string {
  const file = path.join(dir, 'login-sh');
  fs.writeFileSync(
    file,
    `#!/bin/sh\n[ "$1" = -ilc ] && [ "$2" = 'env -0' ] || exit 2\nprintf 'HOME=%s\\0PATH=%s\\0' "$HOME" '${added}':"$PATH"\n`,
    { mode: 0o755 },
  );
  return file;
}

const inside = (dir: string, root: string) =>
  path.relative(fs.realpathSync(root), fs.realpathSync(dir)).split(path.sep)[0] !== '..';

describe('the environment every unit test runs in', () => {
  it('has a home of its own, empty, never the person’s', () => {
    const home = os.homedir();
    expect(process.env.HOME).toBe(home);
    expect(home).not.toBe(os.userInfo().homedir);
    expect(inside(home, os.tmpdir())).toBe(true);
    expect(fs.existsSync(path.join(home, '.local'))).toBe(false);
  });

  it('points every CLI’s config dir inside that home, each empty', () => {
    for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const) {
      const dir = process.env[name];
      expect(dir, name).toBeDefined();
      expect(inside(dir!, os.homedir()), name).toBe(true);
      expect(fs.readdirSync(dir!), name).toEqual([]);
    }
  });

  it('holds no agent CLI on PATH, and no credential or enclosing session of the person’s', () => {
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    for (const dir of dirs) {
      for (const name of AGENT_CLIS) expect(fs.existsSync(path.join(dir, name)), dir).toBe(false);
    }
    const left = Object.keys(process.env).filter((name) =>
      /^(ANTHROPIC_|CLAUDE|CODEX_|OPENAI_|GEMINI_)/.test(name),
    );
    expect(left.sort()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
  });

  it('logs in through a shell that reads nothing of the person’s', () => {
    expect(process.env.SHELL).toBe('/bin/sh');
    expect(process.env.ENV).toBeUndefined();
  });

  it('gives the login shell, whose PATH every driver searches, no folder holding an agent CLI either (review S2)', () => {
    // The real login environment, as the drivers read it: `/etc/paths`, `/etc/paths.d` and `/etc/profile` included.
    const dirs = (getLoginEnv().PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      for (const name of AGENT_CLIS) expect(fs.existsSync(path.join(dir, name)), dir).toBe(false);
    }
  });

  it('gives every driver nothing to find for a harness that names no binary', () => {
    // The real drivers, the real login shell: what a test that forgets
    // `binaryPath` would reach. A bare name is "found nothing": its spawn fails.
    expect(new ClaudeDriver().resolveBinary({ extraArgs: [] })).toBe('claude');
    expect(new CodexDriver().resolveBinary({ extraArgs: [] })).toBe('codex');
    expect(new AntigravityDriver().resolveBinary({ extraArgs: [] })).toBe('agy');
  });
});

describe('withoutAgentClis', () => {
  it('drops each folder that holds an agent CLI, and empty entries, and keeps the rest in order', () => {
    const plain = scratch();
    const withClaude = scratch();
    const withCodex = scratch();
    const withAgy = scratch();
    fakeCli(withClaude, 'claude');
    fakeCli(withCodex, 'codex');
    fakeCli(withAgy, 'agy');
    fakeCli(plain, 'claude-notes');
    const value = ['/usr/bin', withClaude, '', plain, withCodex, withAgy, '/bin'].join(
      path.delimiter,
    );
    expect(withoutAgentClis(value)).toBe(['/usr/bin', plain, '/bin'].join(path.delimiter));
  });

  it('drops a folder whose CLI is a link, and keeps one whose file of that name cannot run', () => {
    const linked = scratch();
    const target = fakeCli(scratch(), 'claude-2.1.330');
    fs.symlinkSync(target, path.join(linked, 'claude'));
    const notRunnable = scratch();
    fs.writeFileSync(path.join(notRunnable, 'codex'), 'notes\n', { mode: 0o644 });
    expect(withoutAgentClis([linked, notRunnable].join(path.delimiter))).toBe(notRunnable);
  });
});

describe('systemInstallProblem', () => {
  it('names a CLI installed where a driver looks when PATH finds none', () => {
    const dir = scratch();
    fakeCli(dir, 'codex');
    expect(systemInstallProblem([dir])).toBe(
      `A real CLI is installed at ${path.join(dir, 'codex')}, where a driver looks when PATH finds none, so a unit test could reach it; the desktop unit tests do not run on this machine until it is moved.`,
    );
  });

  it('is null where none is installed', () => {
    expect(systemInstallProblem([scratch()])).toBeNull();
  });
});

describe('loginShellPath', () => {
  it('is the PATH a login shell prints, asked with the environment it is given', () => {
    const shell = loginShellAdding(scratch(), '/added/by/profile');
    const home = scratch();
    expect(loginShellPath({ HOME: home, PATH: '/usr/bin:/bin' }, shell)).toBe(
      '/added/by/profile:/usr/bin:/bin',
    );
  });

  it("asks the environment's own login shell when none is named, reading none of the person's files", () => {
    const home = scratch();
    const found = loginShellPath({ HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh' });
    expect(found.split(path.delimiter)).toEqual(expect.arrayContaining(['/usr/bin', '/bin']));
  });

  it('throws when the shell cannot be asked', () => {
    expect(() =>
      loginShellPath({ HOME: scratch(), PATH: '/usr/bin' }, path.join(scratch(), 'no-shell')),
    ).toThrow();
  });
});

describe('loginPathProblem', () => {
  it("names a CLI on the login shell's PATH", () => {
    const dir = scratch();
    fakeCli(dir, 'agy');
    expect(loginPathProblem(['/usr/bin', dir].join(path.delimiter))).toBe(
      `A real CLI is installed at ${path.join(dir, 'agy')}, on the login shell's PATH (which /etc/paths, /etc/paths.d or /etc/profile set), where every driver looks, so a unit test could reach it; the desktop unit tests do not run on this machine until it is moved.`,
    );
  });

  it('is null where no folder on it holds one', () => {
    const dir = scratch();
    fakeCli(dir, 'claude-notes');
    expect(loginPathProblem(['', '/usr/bin', dir].join(path.delimiter))).toBeNull();
  });
});

describe('isolateTestProcess', () => {
  it("refuses, touching nothing, where the login shell's PATH reaches a CLI the process's PATH does not (review S2)", () => {
    // A decoy in a folder only the login profile adds, as an installer's /etc/paths.d entry would.
    const added = scratch();
    const ran = path.join(scratch(), 'ran.log');
    const decoy = decoyCli(added, 'claude', ran);
    const shell = loginShellAdding(scratch(), added);
    const tmp = scratch();
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice', PATH: '/usr/bin', SHELL: '/bin/zsh' };
    expect(() =>
      isolateTestProcess(env, {
        tmp,
        systemDirs: [scratch()],
        loginPath: (isolated) => loginShellPath(isolated, shell),
      }),
    ).toThrow(`A real CLI is installed at ${decoy}, on the login shell's PATH`);
    expect(env).toEqual({ HOME: '/Users/alice', PATH: '/usr/bin', SHELL: '/bin/zsh' });
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('refuses, touching nothing, when the login shell cannot be asked for its PATH (review S2)', () => {
    const tmp = scratch();
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice', PATH: '/usr/bin' };
    expect(() =>
      isolateTestProcess(env, {
        tmp,
        systemDirs: [scratch()],
        loginPath: () => {
          throw new Error('`/bin/sh -ilc` did not finish');
        },
      }),
    ).toThrow(
      'Could not ask the login shell for its PATH (`/bin/sh -ilc` did not finish), so it may reach a real CLI; the desktop unit tests do not run until it answers.',
    );
    expect(env).toEqual({ HOME: '/Users/alice', PATH: '/usr/bin' });
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('refuses, touching nothing, where a CLI is installed system-wide', () => {
    const system = scratch();
    const installed = fakeCli(system, 'claude');
    const tmp = scratch();
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice', PATH: '/usr/bin' };
    expect(() => isolateTestProcess(env, { tmp, systemDirs: [system] })).toThrow(
      `A real CLI is installed at ${installed}, where a driver looks when PATH finds none`,
    );
    expect(env).toEqual({ HOME: '/Users/alice', PATH: '/usr/bin' });
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('else isolates the environment in a fresh home under tmp, and returns it', () => {
    const tmp = scratch();
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice', PATH: '/usr/bin', SHELL: '/bin/zsh' };
    const asked: NodeJS.ProcessEnv[] = [];
    const home = isolateTestProcess(env, {
      tmp,
      systemDirs: [scratch()],
      loginPath: (isolated) => {
        asked.push({ ...isolated });
        return '/usr/bin';
      },
    });
    expect(path.dirname(home)).toBe(tmp);
    expect(path.basename(home)).toMatch(/^consola-unit-home-/);
    expect(env.HOME).toBe(home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude'));
    // The login shell was asked as the isolated process will ask it: its home, its plain shell.
    expect(asked).toEqual([env]);
  });
});

describe('isolateFromRealClis', () => {
  it('gives an environment a home and config dirs of its own, a plain login shell and a PATH without CLIs', () => {
    const cliDir = scratch();
    fakeCli(cliDir, 'claude');
    const home = path.join(scratch(), 'home');
    const env: NodeJS.ProcessEnv = {
      HOME: '/Users/alice',
      PATH: ['/usr/bin', cliDir, '/bin'].join(path.delimiter),
      SHELL: '/bin/zsh',
      ENV: '/Users/alice/.shrc',
      CLAUDE_CONFIG_DIR: '/Users/alice/.claude-work',
      CODEX_HOME: '/Users/alice/.codex',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      ANTHROPIC_API_KEY: 'not-a-key',
      OPENAI_API_KEY: 'not-a-key',
      GEMINI_API_KEY: 'not-a-key',
      LANG: 'en_US.UTF-8',
    };
    isolateFromRealClis(env, home);
    expect(env).toEqual({
      HOME: home,
      PATH: ['/usr/bin', '/bin'].join(path.delimiter),
      SHELL: '/bin/sh',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'),
      LANG: 'en_US.UTF-8',
    });
    expect(fs.readdirSync(home).sort()).toEqual(['.claude', '.codex']);
  });
});
