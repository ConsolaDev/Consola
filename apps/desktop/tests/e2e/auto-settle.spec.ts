import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';
import { NEW_SESSION_NAME } from '../../src/shared/workspace';

const WORKSPACE_NAME = 'Settle e2e';
const DAY = 24 * 60 * 60_000;

/**
 * A workspace with one long-idle session and one fresh one, in a profile that
 * has never auto-settled, plus one of each that never had a message (no
 * transcript under the harness's config folder, and still "New Session").
 */
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
            session('blank-old', NEW_SESSION_NAME, now - 30 * DAY),
            session('blank-fresh', NEW_SESSION_NAME, now),
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

/** The session ids main has on disk. */
const storedSessionIds = (): string[] =>
  JSON.parse(
    fs.readFileSync(path.join(`${profile} Test`, 'workspaces.json'), 'utf8'),
  ).workspaces[0].sessions.map((session: { id: string }) => session.id);

test('the first auto-settle is explained, once, and nothing worked in is deleted', async () => {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('A session was settled');
  await expect(dialog).toContainText('Nothing you worked in was deleted');
  await expect(dialog).toContainText('Old spike');
  await expect(dialog).not.toContainText('Fresh work');
  // The idle session that never had a message is removed, not shelved, so the
  // explanation does not name it.
  await expect(dialog).not.toContainText(NEW_SESSION_NAME);
  await expect.poll(storedSessionIds).toEqual(['old', 'fresh', 'blank-fresh']);

  await dialog.getByRole('button', { name: 'Show Settled' }).click();
  await expect(dialog).toHaveCount(0);

  await hold(page);
  // The shelf holds only what was put away: the long-idle session is on it,
  // and the fresh one stays at the top of the list.
  const shelf = page.getByRole('navigation', { name: 'Settled sessions' });
  const list = page.getByRole('navigation', { name: 'Sessions', exact: true });
  await expect(shelf.getByText('Old spike')).toBeVisible();
  await expect(shelf.getByText('Fresh work')).toHaveCount(0);
  await expect(shelf.getByText(NEW_SESSION_NAME)).toHaveCount(0);
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

test('settling a session that never had a message by hand removes it', async () => {
  await page.getByRole('dialog').getByRole('button', { name: 'Got it' }).click();
  await hold(page);
  await expect.poll(storedSessionIds).toEqual(['old', 'fresh', 'blank-fresh']);

  const list = page.getByRole('navigation', { name: 'Sessions', exact: true });
  const blank = list.locator('.session-nav-item').filter({ hasText: NEW_SESSION_NAME });
  await blank.hover();
  await blank.getByRole('button', { name: `Settle session ${NEW_SESSION_NAME}` }).click();

  await expect(
    page.getByText(`Removed ${NEW_SESSION_NAME}: it never had a message.`),
  ).toBeVisible();
  await expect(page.getByText(NEW_SESSION_NAME, { exact: true })).toHaveCount(0);
  await expect.poll(storedSessionIds).toEqual(['old', 'fresh']);
});
