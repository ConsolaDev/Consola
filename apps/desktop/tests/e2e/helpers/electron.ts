import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LaunchOptions {
  /** Profile directory. Defaults to a fresh temp dir, so runs cannot collide. */
  userDataDir?: string;
  /** Extra environment for the app process (stub gh, worktree root, ...). */
  env?: Record<string, string>;
  /**
   * Every launch is this spec's own stub: closing the app fails when any
   * launch got the stand-in for the ambient CLI instead (a harness that names
   * no binary). Without it, only a refused launch fails the spec.
   */
  strictLaunches?: boolean;
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

export async function launchElectron(
  options: LaunchOptions = {},
): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const userDataDir = options.userDataDir ?? createProfileDir();

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
      // Wherever a harness names no binary of its own, this runs instead of
      // the person's real CLI (`drivers/testLaunchGuard.ts`).
      CONSOLA_TEST_AMBIENT_CLI: ambientStandIn(),
      ...(options.env ?? {}),
    },
  });

  failOnStrayLaunches(app, options.strictLaunches === true);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return { app, page, userDataDir };
}

/**
 * The stand-in for the ambient CLI: `tests/fixtures/ambient-cli.cjs`, through
 * a wrapper that runs it with the test runner's own Node, since a login PATH
 * may have none. Written once per run, beside the profiles.
 */
function ambientStandIn(): string {
  const wrapper = path.join(os.tmpdir(), `consola-e2e-ambient-cli-${process.pid}.sh`);
  if (!fs.existsSync(wrapper)) {
    const fixture = path.resolve(__dirname, '../../fixtures/ambient-cli.cjs');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, {
      mode: 0o755,
    });
  }
  return wrapper;
}

/**
 * What the app's launches reached that was not the test's own stub: `refused`,
 * which ran nothing (a bare or relative binary, or the ambient CLI with no
 * stand-in), and `ambient`, launches of the stand-in for a harness that names
 * no binary. Main records both (`drivers/testLaunchGuard.ts`).
 */
export async function strayLaunches(
  app: ElectronApplication,
): Promise<{ refused: string[]; ambient: string[] }> {
  return app.evaluate(() => {
    const exposed = (
      globalThis as { __consolaTest?: { launches?: { refused: string[]; ambient: string[] } } }
    ).__consolaTest?.launches;
    return { refused: [...(exposed?.refused ?? [])], ambient: [...(exposed?.ambient ?? [])] };
  });
}

/**
 * Every spec fails on a refused launch, and a strict one on any launch of the
 * ambient stand-in, whether or not what it waited for noticed: closing the
 * app reads them first, and throws when there are any (review S4).
 */
function failOnStrayLaunches(app: ElectronApplication, strict: boolean): void {
  const close = app.close.bind(app);
  app.close = async () => {
    const stray = await strayLaunches(app).catch(() => ({ refused: [], ambient: [] }));
    await close();
    const failing = [...stray.refused, ...(strict ? stray.ambient : [])];
    if (failing.length > 0) {
      throw new Error(
        `The app launched a CLI that is not this test's own stub:\n${failing.join('\n')}`,
      );
    }
  };
}
