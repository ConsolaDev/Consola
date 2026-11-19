import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';

const WORKSPACE_NAME = 'Snooze e2e';
const WORKSPACE_ID = 'ws-snooze-e2e';
const HOUR = 60 * 60_000;

interface Seed {
  /** Ledger rows to start with, by session id. */
  ledger?: Record<string, Record<string, unknown>>;
}

/**
 * Three sessions nobody has opened, so no terminal ever starts: everything
 * here is the sidebar, the menus and main's timer. Auto-settle is off and
 * already explained, so its dialog never covers the list.
 */
function seed(profileDir: string, scopeDir: string, { ledger = {} }: Seed = {}): void {
  const effective = `${profileDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const builtIn = { ...createBuiltInHarness(), configDir: path.join(scopeDir, 'claude-profile') };
  fs.writeFileSync(
    path.join(effective, 'harnesses.json'),
    JSON.stringify({ version: 1, harnesses: [builtIn] }),
  );
  fs.writeFileSync(
    path.join(effective, 'preferences.json'),
    JSON.stringify({ autoSettleDays: 0, hasExplainedAutoSettle: true, pendingAutoSettle: [] }),
  );
  const session = (id: string, name: string, lastActiveAt: number) => ({
    id,
    name,
    workspaceId: WORKSPACE_ID,
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
          id: WORKSPACE_ID,
          name: WORKSPACE_NAME,
          defaultHarnessId: 'default',
          scopes: [
            { id: 'scope-app', name: 'portal', path: scopeDir, isGitRepo: false, createdAt: now },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
          sessions: [
            session('ci', 'Waiting on CI', now - 3 * HOUR),
            session('review', 'Review feedback', now - 2 * HOUR),
            session('docs', 'Docs pass', now - HOUR),
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8',
  );
  const records = Object.fromEntries(
    Object.entries(ledger).map(([id, row]) => [
      id,
      { sessionId: id, workspaceId: WORKSPACE_ID, lastActiveAt: now - HOUR, ...row },
    ]),
  );
  fs.writeFileSync(path.join(effective, 'attention-ledger.json'), JSON.stringify({ records }));
}

let app: ElectronApplication;
let page: Page;
let profile: string;
let scopeDir: string;

async function start(options: Seed = {}): Promise<void> {
  profile = createProfileDir();
  scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-snooze-'));
  seed(profile, scopeDir, options);
  ({ app, page } = await launchElectron({ userDataDir: profile }));
  const button = page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
}

test.afterEach(async () => {
  await app?.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(`${profile} Test`, { recursive: true, force: true });
  fs.rmSync(scopeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const list = () => page.getByRole('navigation', { name: 'Sessions', exact: true });
const shelf = () => page.getByRole('navigation', { name: 'Snoozed sessions' });
const shelfHeader = () => page.locator('[data-shelf="snoozed"] .shelf-header');
const row = (scope: ReturnType<typeof list>, name: string) =>
  scope.locator('.session-nav-item').filter({ hasText: name });

test('snoozing from the row menu moves it to the shelf with a countdown, and Undo puts it back', async () => {
  await start();
  await row(list(), 'Waiting on CI').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Snooze', exact: true }).hover();
  await page.getByRole('menuitem', { name: /^In 3 hours/ }).click();

  await expect(page.getByText(/^Snoozed Waiting on CI until /)).toBeVisible();
  await expect(row(list(), 'Waiting on CI')).toHaveCount(0);
  // Folded by default, with its count.
  await expect(shelfHeader()).toHaveAttribute('aria-expanded', 'false');
  await expect(shelfHeader()).toContainText('1');
  await shelfHeader().click();
  const parked = row(shelf(), 'Waiting on CI');
  await expect(parked.locator('.snooze-countdown')).toHaveText(/^(3h|180m)$/);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row(list(), 'Waiting on CI')).toBeVisible();
  await expect(page.locator('[data-shelf="snoozed"]')).toHaveCount(0);
});

test('a snooze that ran out while Consola was closed comes back at launch, marked Woke', async () => {
  const past = Date.now() - HOUR;
  await start({ ledger: { review: { snoozedUntil: past, snoozedAt: past - HOUR } } });
  const back = row(list(), 'Review feedback');
  await expect(back).toBeVisible();
  await expect(back.locator('.session-row-status--woke')).toHaveText('Woke');
  await expect(back.locator('.session-row-status--woke')).toHaveAttribute(
    'title',
    'Its snooze ended.',
  );
});

test('a snooze comes back by itself at its time', async () => {
  const soon = Date.now() + 8_000;
  await start({ ledger: { docs: { snoozedUntil: soon, snoozedAt: Date.now() } } });
  await expect(row(list(), 'Docs pass')).toHaveCount(0);
  await expect(shelfHeader()).toContainText('1');
  await expect(row(list(), 'Docs pass')).toBeVisible({ timeout: 15_000 });
  await expect(row(list(), 'Docs pass').locator('.session-row-status--woke')).toBeVisible();
});

test('Wake on hover brings a snoozed row back with no mark', async () => {
  const later = Date.now() + 5 * HOUR;
  await start({ ledger: { ci: { snoozedUntil: later, snoozedAt: Date.now() } } });
  await shelfHeader().click();
  const parked = row(shelf(), 'Waiting on CI');
  await parked.hover();
  await parked.getByRole('button', { name: 'Wake Waiting on CI' }).click();
  await expect(page.getByText('Woke Waiting on CI. It is back in the list.')).toBeVisible();
  const back = row(list(), 'Waiting on CI');
  await expect(back).toBeVisible();
  await expect(back.locator('.session-row-status--woke')).toHaveCount(0);
});

test('the custom dialog says when it comes back, and refuses a time that has passed', async () => {
  await start();
  await row(list(), 'Docs pass').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Snooze', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Custom…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Snooze until…' });
  await expect(dialog).toContainText(/Comes back /);
  await dialog.getByRole('radio', { name: 'An amount of time' }).click();
  await dialog.getByLabel('In', { exact: true }).fill('2');
  await dialog.getByLabel('Unit', { exact: true }).selectOption('days');
  await expect(dialog).toContainText(/Comes back /);
  await dialog.getByRole('radio', { name: 'A date and time' }).click();
  await dialog.getByLabel('Date', { exact: true }).fill('2020-01-01');
  await expect(dialog.getByRole('alert')).toHaveText('That time has passed. Pick another.');
  await expect(dialog.getByRole('button', { name: 'Snooze' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'An amount of time' }).click();
  await dialog.getByRole('button', { name: 'Snooze' }).click();
  await expect(page.getByText(/^Snoozed Docs pass until /)).toBeVisible();
  await expect(row(list(), 'Docs pass')).toHaveCount(0);
});

test('⌘-click selects several, and one Settle with one Undo acts on all of them', async () => {
  await start();
  await row(list(), 'Waiting on CI').click({ modifiers: ['ControlOrMeta'] });
  await row(list(), 'Docs pass').click({ modifiers: ['ControlOrMeta'] });
  await expect(list().locator('.session-nav-item[aria-selected="true"]')).toHaveCount(2);
  // Nothing was opened: a selection gesture never activates a row.
  await expect(list().locator('.session-nav-item.active')).toHaveCount(0);

  await row(list(), 'Docs pass').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Settle', exact: true }).click();
  await expect(page.getByText('Settled 2 sessions.')).toBeVisible();
  await expect(row(list(), 'Waiting on CI')).toHaveCount(0);
  await expect(row(list(), 'Docs pass')).toHaveCount(0);
  await expect(row(list(), 'Review feedback')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row(list(), 'Waiting on CI')).toBeVisible();
  await expect(row(list(), 'Docs pass')).toBeVisible();
});

test('⇧-click selects a range, and Esc clears it', async () => {
  await start();
  await row(list(), 'Docs pass').click({ modifiers: ['ControlOrMeta'] });
  await row(list(), 'Waiting on CI').click({ modifiers: ['Shift'] });
  await expect(list().locator('.session-nav-item[aria-selected="true"]')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(list().locator('.session-nav-item[aria-selected="true"]')).toHaveCount(0);
});

test('editing Snooze options changes the menu, and it survives a restart', async () => {
  await start();
  await page.evaluate(() =>
    window.preferencesAPI.setSnoozePresets([{ kind: 'after', minutes: 45 }]),
  );
  await row(list(), 'Docs pass').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Snooze', exact: true }).hover();
  await expect(page.getByRole('menuitem', { name: /^In 45 minutes/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^In 1 hour/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await app.close();
  ({ app, page } = await launchElectron({ userDataDir: profile }));
  const stored = await page.evaluate(() => window.preferencesAPI.get());
  expect(stored.snoozePresets).toEqual([{ kind: 'after', minutes: 45 }]);
});
