import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';

const WORKSPACE_NAME = 'Settle e2e';
const DAY = 24 * 60 * 60_000;

/** A workspace with one long-idle session and one fresh one, in a profile that has never auto-settled. */
function seed(profileDir: string, scopeDir: string): void {
  const effective = `${profileDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const builtIn = { ...createBuiltInHarness(), configDir: path.join(scopeDir, 'claude-profile') };
  fs.writeFileSync(
    path.join(effective, 'harnesses.json'),
    JSON.stringify({ version: 1, harnesses: [builtIn] }),
  );
  const session = (id: string, name: string, lastActiveAt: number) => ({
    id,
    name,
    workspaceId: 'ws-settle-e2e',
    instanceId: `inst-${id}`,
    claudeSessionId: `claude-${id}`,
    hasStarted: false,
    harnessId: 'default',
    scopeId: 'scope-app',
    kind: 'interactive',
    createdAt: lastActiveAt,
    lastActiveAt,
  });
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify({
      version: 7,
      workspaces: [
        {
          id: 'ws-settle-e2e',
          name: WORKSPACE_NAME,
          defaultHarnessId: 'default',
          scopes: [
            { id: 'scope-app', name: 'portal', path: scopeDir, isGitRepo: false, createdAt: now },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
          sessions: [
            session('old', 'Old spike', now - 30 * DAY),
            session('fresh', 'Fresh work', now),
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8',
  );
}

let app: ElectronApplication;
let page: Page;
let profile: string;
let scopeDir: string;

async function hold(target: Page): Promise<void> {
  const button = target
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
}

test.beforeEach(async () => {
  profile = createProfileDir();
  scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-settle-'));
  seed(profile, scopeDir);
  ({ app, page } = await launchElectron({ userDataDir: profile }));
});

test.afterEach(async () => {
  await app.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(`${profile} Test`, { recursive: true, force: true });
  fs.rmSync(scopeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the first auto-settle is explained, once, and nothing is deleted', async () => {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('A session was settled');
  await expect(dialog).toContainText('Nothing was deleted');
  await expect(dialog).toContainText('Old spike');
  await expect(dialog).not.toContainText('Fresh work');

  await dialog.getByRole('button', { name: 'Show Settled' }).click();
  await expect(dialog).toHaveCount(0);

  await hold(page);
  // The shelf holds only what was put away: the long-idle session is on it,
  // and the fresh one stays at the top of the list.
  const shelf = page.getByRole('navigation', { name: 'Settled sessions' });
  const list = page.getByRole('navigation', { name: 'Sessions', exact: true });
  await expect(shelf.getByText('Old spike')).toBeVisible();
  await expect(shelf.getByText('Fresh work')).toHaveCount(0);
  await expect(list.getByText('Fresh work')).toBeVisible();
  // A row's actions appear on hover, so every reach for one hovers first.
  const shelved = shelf.locator('.session-nav-item').filter({ hasText: 'Old spike' });
  await shelved.hover();
  await expect(
    shelved.getByRole('button', { name: 'Move Old spike back to the list' }),
  ).toBeVisible();
  const fresh = list.locator('.session-nav-item').filter({ hasText: 'Fresh work' });
  await fresh.hover();
  await expect(fresh.getByRole('button', { name: 'Settle session Fresh work' })).toBeVisible();
});

test('once explained it is not explained again, and Off keeps everything where it is', async () => {
  await page.getByRole('dialog').getByRole('button', { name: 'Got it' }).click();
  const ack = JSON.parse(fs.readFileSync(path.join(`${profile} Test`, 'preferences.json'), 'utf8'));
  expect(ack.hasExplainedAutoSettle).toBe(true);
  await app.close();

  ({ app, page } = await launchElectron({ userDataDir: profile }));
  await hold(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
