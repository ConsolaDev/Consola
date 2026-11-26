import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';
import { NEW_SESSION_NAME } from '../../src/shared/workspace';

/**
 * A settled session that never had a message is removed (`EmptySessionReaper`),
 * and the browser meets that rule twice: a session removed so loses its tabs
 * and what they left on disk, through the same `SessionRemover` as any delete;
 * and a session the person browsed in, though nobody typed to its agent, was
 * used, so it is kept. Everything is seeded on disk, so no page ever loads.
 */

const WORKSPACE_NAME = 'Browse e2e';
const DAY = 24 * 60 * 60_000;

/** A tab on an address nothing serves: it is never shown, so never loaded. */
const tab = (id: string, url: string, openedBy: 'person' | 'agent') => ({
  tabs: [{ id, url, title: '', openedBy }],
  activeTabId: id,
});

/**
 * Four sessions, none of which ever had a message but `old`: a long-idle one
 * with a page open, a fresh one with a page an agent opened, a long-idle one
 * with only a blank tab and a screenshot it once took, and a named one so the
 * first sweep has something to explain. The browsed one comes first, so it has
 * been judged by the time the blank one is gone.
 */
function seed(effective: string, scopeDir: string): void {
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
    workspaceId: 'ws-browse-e2e',
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
          id: 'ws-browse-e2e',
          name: WORKSPACE_NAME,
          defaultHarnessId: 'default',
          scopes: [
            { id: 'scope-app', name: 'portal', path: scopeDir, isGitRepo: false, createdAt: now },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
          sessions: [
            session('browsed-old', NEW_SESSION_NAME, now - 30 * DAY),
            session('browsed-fresh', NEW_SESSION_NAME, now),
            session('old', 'Old spike', now - 30 * DAY),
            session('blank-tab-old', NEW_SESSION_NAME, now - 30 * DAY),
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(effective, 'browser-state.json'),
    JSON.stringify({
      sessions: {
        'browsed-old': tab('tab-browsed-old', 'http://127.0.0.1:9/read-later', 'person'),
        'browsed-fresh': tab('tab-browsed-fresh', 'http://127.0.0.1:9/agent-found', 'agent'),
        'blank-tab-old': tab('tab-blank', '', 'person'),
      },
      history: {},
    }),
  );
  const captures = path.join(effective, 'browser-captures', 'blank-tab-old');
  fs.mkdirSync(captures, { recursive: true });
  fs.writeFileSync(path.join(captures, '2026-11-01T00-00-00-000Z.png'), 'not really a png');
}

let app: ElectronApplication;
let page: Page;
let profile: string;
let effective: string;
let scopeDir: string;

const storedSessionIds = (): string[] =>
  JSON.parse(
    fs.readFileSync(path.join(effective, 'workspaces.json'), 'utf8'),
  ).workspaces[0].sessions.map((session: { id: string }) => session.id);

/** Which sessions the browser's state file still holds tabs for, and on what. */
const storedTabs = (): Record<string, string[]> => {
  const state = JSON.parse(fs.readFileSync(path.join(effective, 'browser-state.json'), 'utf8'));
  return Object.fromEntries(
    Object.entries(state.sessions as Record<string, { tabs: Array<{ url: string }> }>).map(
      ([id, entry]) => [id, entry.tabs.map((stored) => stored.url)],
    ),
  );
};

async function hold(target: Page): Promise<void> {
  const button = target
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
}

test.beforeEach(async () => {
  profile = createProfileDir();
  effective = `${profile} Test`;
  scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browse-settle-'));
  seed(effective, scopeDir);
  ({ app, page } = await launchElectron({ userDataDir: profile }));
});

test.afterEach(async () => {
  await app.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(effective, { recursive: true, force: true });
  fs.rmSync(scopeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the sweep removes an empty session with its tabs and captures, and keeps one browsed in', async () => {
  // The blank-tab session goes, as one with no tabs at all would.
  await expect.poll(storedSessionIds).toEqual(['browsed-old', 'browsed-fresh', 'old']);
  // Its tab leaves main's state file, and the screenshot it took leaves the
  // disk: only the remover every delete goes through does the second.
  await expect.poll(storedTabs).toEqual({
    'browsed-old': ['http://127.0.0.1:9/read-later'],
    'browsed-fresh': ['http://127.0.0.1:9/agent-found'],
  });
  await expect
    .poll(() => fs.existsSync(path.join(effective, 'browser-captures', 'blank-tab-old')))
    .toBe(false);

  // The one browsed in is kept, on the Settled shelf, with its page.
  await page.getByRole('dialog').getByRole('button', { name: 'Show Settled' }).click();
  await hold(page);
  const shelf = page.getByRole('navigation', { name: 'Settled sessions' });
  await expect(shelf.getByText('Old spike')).toBeVisible();
  await expect(shelf.getByText(NEW_SESSION_NAME)).toHaveCount(1);
});

test('settling by hand keeps an empty session with a page an agent opened', async () => {
  await expect.poll(storedSessionIds).toEqual(['browsed-old', 'browsed-fresh', 'old']);
  await page.getByRole('dialog').getByRole('button', { name: 'Show Settled' }).click();
  await hold(page);

  const list = page.getByRole('navigation', { name: 'Sessions', exact: true });
  const browsed = list.locator('.session-nav-item').filter({ hasText: NEW_SESSION_NAME });
  await browsed.hover();
  await browsed.getByRole('button', { name: `Settle session ${NEW_SESSION_NAME}` }).click();

  await expect(
    page.getByText(`Settled ${NEW_SESSION_NAME}. It is on the Settled shelf.`),
  ).toBeVisible();
  const shelf = page.getByRole('navigation', { name: 'Settled sessions' });
  await expect(shelf.getByText(NEW_SESSION_NAME)).toHaveCount(2);
  expect(storedSessionIds()).toEqual(['browsed-old', 'browsed-fresh', 'old']);
  expect(storedTabs()['browsed-fresh']).toEqual(['http://127.0.0.1:9/agent-found']);
});
