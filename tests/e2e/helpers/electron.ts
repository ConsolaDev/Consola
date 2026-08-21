import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface LaunchOptions {
  /** Profile directory. Defaults to a fresh temp dir, so runs cannot collide. */
  userDataDir?: string;
  /** Extra environment for the app process (stub gh, worktree root, ...). */
  env?: Record<string, string>;
}

/** The chord for a new window, matching useKeyboardShortcuts on this platform. */
export function newWindowChord(): string {
  return process.platform === 'darwin' ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN';
}

export function createProfileDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'consola-e2e-'));
}

export async function launchElectron(
  options: LaunchOptions = {}
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
      ...(options.env ?? {}),
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return { app, page, userDataDir };
}
