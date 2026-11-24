import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What keeps a desktop unit test from finding or starting the person's own
 * agent CLI. `realCliIsolation.setup.ts` applies it to every test process
 * (vitest's `setupFiles`), before any test file is imported.
 *
 * A driver that is given no `binaryPath` looks for its CLI on the login
 * shell's PATH, then under `~/.local/bin`, then where Homebrew installs, and
 * caches what it finds: run from the person's environment, that is their real
 * CLI with their login, where an unattended turn spends their tokens. So a
 * test process gets a home and config dirs of its own (no `~/.local/bin`, no
 * profile), a login shell that reads none of the person's startup files, a
 * PATH without any folder holding an agent CLI, and none of their API keys or
 * of an enclosing Claude session's variables. A CLI installed system-wide,
 * where a driver looks whatever the home and PATH say, cannot be hidden: the
 * setup refuses to run there instead. So does one the login shell's own PATH
 * reaches, which the drivers search rather than the process's: a login shell
 * adds `/etc/paths`, `/etc/paths.d` (macOS's `path_helper`) and whatever
 * `/etc/profile` sets, none of which a home or PATH hides (review S2).
 *
 * Only node's own modules are imported, so loading this from the setup file
 * caches nothing a test file mocks.
 */

/** The binary every driver looks for: Claude's, Codex's and Antigravity's. */
export const AGENT_CLIS: readonly string[] = ['claude', 'codex', 'agy'];

/** Where the drivers look for their CLI when PATH finds none, whatever the home is. */
export const SYSTEM_INSTALL_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The person's credentials and an enclosing session: names starting with these are removed. */
const REMOVED_PREFIXES = ['ANTHROPIC_', 'CLAUDE', 'CODEX_', 'OPENAI_', 'GEMINI_'];

/** What the drivers count as their CLI being there (`isExecutable` in each driver). */
function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH without empty entries and without any folder holding a runnable agent CLI. */
export function withoutAgentClis(value: string): string {
  return value
    .split(path.delimiter)
    .filter((dir) => dir !== '' && !AGENT_CLIS.some((name) => isExecutable(path.join(dir, name))))
    .join(path.delimiter);
}

/** Why the unit tests must not run here: a CLI installed where no home or PATH hides it; else null. */
export function systemInstallProblem(dirs: readonly string[] = SYSTEM_INSTALL_DIRS): string | null {
  for (const dir of dirs) {
    for (const name of AGENT_CLIS) {
      const file = path.join(dir, name);
      if (isExecutable(file)) {
        return `A real CLI is installed at ${file}, where a driver looks when PATH finds none, so a unit test could reach it; the desktop unit tests do not run on this machine until it is moved.`;
      }
    }
  }
  return null;
}

/** How long the setup waits for the login shell: `getLoginEnv`'s retry allows as long. */
const LOGIN_PROBE_TIMEOUT_MS = 20_000;

/**
 * The PATH a login shell gives the drivers: `getLoginEnv`'s own probe
 * (`<shell> -ilc 'env -0'`, the shell `env.SHELL` names), asked with `env`,
 * whose PATH stands when the shell prints none. Throws when the shell cannot
 * be asked.
 */
export function loginShellPath(
  env: NodeJS.ProcessEnv,
  shell: string = env.SHELL || '/bin/sh',
): string {
  // Detached, as `getLoginEnv`'s probe is: an interactive shell must not take the terminal.
  const options: ExecFileSyncOptionsWithStringEncoding & { detached: boolean } = {
    env,
    encoding: 'utf8',
    timeout: LOGIN_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  };
  const printed = execFileSync(shell, ['-ilc', 'env -0'], options);
  const entry = printed.split('\0').find((line) => line.startsWith('PATH='));
  return entry !== undefined ? entry.slice('PATH='.length) : (env.PATH ?? '');
}

/** Why the unit tests must not run here: a folder on the login shell's PATH holds an agent CLI; else null. */
export function loginPathProblem(loginPath: string): string | null {
  for (const dir of loginPath.split(path.delimiter)) {
    if (dir === '') continue;
    for (const name of AGENT_CLIS) {
      const file = path.join(dir, name);
      if (isExecutable(file)) {
        return `A real CLI is installed at ${file}, on the login shell's PATH (which /etc/paths, /etc/paths.d or /etc/profile set), where every driver looks, so a unit test could reach it; the desktop unit tests do not run on this machine until it is moved.`;
      }
    }
  }
  return null;
}

/**
 * Point `env` at `home` (created, with an empty `.claude` and `.codex`):
 * `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`; `SHELL` is `/bin/sh` and `ENV`
 * goes, so the login shell reads nothing of the person's; PATH loses every
 * folder holding an agent CLI; every variable of the person's credentials or
 * of an enclosing Claude session goes.
 */
export function isolateFromRealClis(env: NodeJS.ProcessEnv, home: string): void {
  for (const name of Object.keys(env)) {
    if (REMOVED_PREFIXES.some((prefix) => name.startsWith(prefix))) delete env[name];
  }
  delete env.ENV;
  const claudeConfigDir = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  env.HOME = home;
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  env.CODEX_HOME = codexHome;
  env.SHELL = '/bin/sh';
  env.PATH = withoutAgentClis(env.PATH ?? '');
}

/**
 * The setup's whole job, for a process about to run tests: refuses (throws
 * `systemInstallProblem`'s words, touching nothing) where a CLI is installed
 * in `systemDirs`; else isolates a copy of `env` in a fresh home under `tmp`
 * and asks its login shell for the PATH the drivers will search
 * (`loginPath`), refusing, the home removed and `env` untouched, when a
 * folder on it holds an agent CLI or the shell cannot be asked; else
 * isolates `env` there and returns the home, for the setup to remove once
 * the file's tests are done.
 */
export function isolateTestProcess(
  env: NodeJS.ProcessEnv,
  {
    tmp = os.tmpdir(),
    systemDirs = SYSTEM_INSTALL_DIRS,
    loginPath = loginShellPath,
  }: {
    tmp?: string;
    systemDirs?: readonly string[];
    loginPath?: (env: NodeJS.ProcessEnv) => string;
  } = {},
): string {
  const problem = systemInstallProblem(systemDirs);
  if (problem) throw new Error(problem);
  const home = fs.mkdtempSync(path.join(tmp, 'consola-unit-home-'));
  const isolated: NodeJS.ProcessEnv = { ...env };
  isolateFromRealClis(isolated, home);
  let onLogin: string | null;
  try {
    onLogin = loginPathProblem(loginPath(isolated));
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    onLogin = `Could not ask the login shell for its PATH (${reason}), so it may reach a real CLI; the desktop unit tests do not run until it answers.`;
  }
  if (onLogin) {
    fs.rmSync(home, { recursive: true, force: true });
    throw new Error(onLogin);
  }
  isolateFromRealClis(env, home);
  return home;
}
