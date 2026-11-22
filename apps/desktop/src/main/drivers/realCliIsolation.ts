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
 * setup refuses to run there instead.
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
 * in `systemDirs`; else isolates `env` in a fresh home under `tmp`, which it
 * returns for the setup to remove once the file's tests are done.
 */
export function isolateTestProcess(
  env: NodeJS.ProcessEnv,
  {
    tmp = os.tmpdir(),
    systemDirs = SYSTEM_INSTALL_DIRS,
  }: { tmp?: string; systemDirs?: readonly string[] } = {},
): string {
  const problem = systemInstallProblem(systemDirs);
  if (problem) throw new Error(problem);
  const home = fs.mkdtempSync(path.join(tmp, 'consola-unit-home-'));
  isolateFromRealClis(env, home);
  return home;
}
