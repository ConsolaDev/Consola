import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILT_IN_HARNESS_ID } from '../../../src/shared/constants';
import { createBuiltInHarness, type Harness } from '../../../src/shared/harness';

export interface LaunchOptions {
  /** Profile directory. Defaults to a fresh temp dir, so runs cannot collide. */
  userDataDir?: string;
  /** Extra environment for the app process (stub gh, worktree root, ...). */
  env?: Record<string, string>;
}

/** The chord for a new window, matching useKeyboardShortcuts on this platform. */
export function newWindowChord(): string {
  return process.platform === 'darwin' ? 'Meta+Alt+KeyN' : 'Control+Alt+KeyN';
}

/** The chord for the global Settings modal, matching useKeyboardShortcuts on this platform. */
export function settingsChord(): string {
  return process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma';
}

/** The command palette chord, matching isCommandPaletteShortcut on this platform. */
export function commandPaletteChord(): string {
  return process.platform === 'darwin' ? 'Meta+KeyK' : 'Control+Shift+KeyP';
}

export function createProfileDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'consola-e2e-'));
}

/**
 * Removes a profile once the app on it has closed. Main keeps its data beside
 * the folder it was given, under its " Test" suffix (main/index.ts), so both go.
 */
export function removeProfile(userDataDir: string): void {
  for (const folder of [userDataDir, `${userDataDir} Test`]) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Stands in for `claude` on the built-in harness. The health check gets a
 * version, and the capabilities handshake and print mode (`-p`) are refused,
 * so neither waits out a timeout; a session's pane gets a line and waits.
 */
const STUB_CLAUDE = [
  '#!/bin/sh',
  'case " $* " in',
  `  *" --version "*) printf '2.1.0 (Claude Code)\\n'; exit 0 ;;`,
  '  *" --input-format "* | *" -p "*) exit 1 ;;',
  'esac',
  `printf 'Agent ready\\n'`,
  'exec sleep 300',
  '',
].join('\n');

/**
 * Keeps a launch off the person's own Claude: no spec reads their config
 * (`~/.claude.json`, `~/.claude`, or the `CLAUDE_CONFIG_DIR` the runner was
 * started with) or runs their `claude`.
 *
 * A Claude harness that pins no folder reads the ambient `CLAUDE_CONFIG_DIR`,
 * so that is a folder of the profile's, returned for the app's environment.
 * The built-in harness pins nothing as seeded, and would also run whatever
 * `claude` the login shell's PATH finds, so its record is pinned to that
 * folder and to a stub, in `harnesses.json` before main loads it. A spec that
 * seeds the built-in record keeps every field it set; one whose file is not
 * JSON keeps it as it is.
 */
function isolateClaude(userDataDir: string): string {
  const home = path.join(userDataDir, 'claude');
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const binaryPath = path.join(home, 'claude');
  fs.writeFileSync(binaryPath, STUB_CLAUDE, { mode: 0o755 });

  // Where main keeps its state (main/index.ts adds the " Test" suffix).
  const effective = `${userDataDir} Test`;
  const file = path.join(effective, 'harnesses.json');
  let harnesses: Harness[] = [];
  if (fs.existsSync(file)) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { harnesses?: unknown };
      if (!Array.isArray(stored.harnesses)) return configDir;
      harnesses = stored.harnesses as Harness[];
    } catch {
      return configDir;
    }
  }
  const builtIn = harnesses.find((harness) => harness.id === BUILT_IN_HARNESS_ID);
  const pinned: Harness = {
    ...(builtIn ?? createBuiltInHarness()),
    binaryPath: builtIn?.binaryPath || binaryPath,
    configDir: builtIn?.configDir || configDir,
  };
  // First when it was missing, where main's own `withBuiltIn` would put it.
  const next = builtIn
    ? harnesses.map((harness) => (harness === builtIn ? pinned : harness))
    : [pinned, ...harnesses];
  fs.mkdirSync(effective, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, harnesses: next }));
  return configDir;
}

export async function launchElectron(
  options: LaunchOptions = {},
): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const userDataDir = options.userDataDir ?? createProfileDir();
  const claudeConfigDir = isolateClaude(userDataDir);

  const app = await electron.launch({
    args: [
      path.join(__dirname, '../../../dist/main/main/index.js'),
      // main/index.ts still appends its " Test" suffix on top of this, which is
      // fine: the point is that the root is ours and nothing else writes here.
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      ...(options.env ?? {}),
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return { app, page, userDataDir };
}
