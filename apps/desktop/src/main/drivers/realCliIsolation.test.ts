import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { AntigravityDriver } from './AntigravityDriver';
import { ClaudeDriver } from './ClaudeDriver';
import { CodexDriver } from './CodexDriver';
import {
  AGENT_CLIS,
  isolateFromRealClis,
  isolateTestProcess,
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

describe('isolateTestProcess', () => {
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
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice', PATH: '/usr/bin' };
    const home = isolateTestProcess(env, { tmp, systemDirs: [scratch()] });
    expect(path.dirname(home)).toBe(tmp);
    expect(path.basename(home)).toMatch(/^consola-unit-home-/);
    expect(env.HOME).toBe(home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude'));
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
