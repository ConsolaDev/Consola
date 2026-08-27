import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;

async function sidebarWidth(target: Page): Promise<number> {
  const box = await target.locator('.sidebar').boundingBox();
  if (!box) throw new Error('the sidebar is not on screen');
  return box.width;
}

async function headerStripWidth(target: Page): Promise<number> {
  const box = await target.locator('.app-header-sidebar').boundingBox();
  if (!box) throw new Error('the header strip is not on screen');
  return box.width;
}

/**
 * The handle is zero wide -- its hit zone is a pseudo-element straddling the
 * sidebar's right edge -- so Playwright cannot hover it by locator. The
 * gesture is driven by coordinates: press on the seam, drag by `dx`.
 */
async function dragSidebarEdge(target: Page, dx: number): Promise<void> {
  const box = await target.locator('.sidebar').boundingBox();
  if (!box) throw new Error('the sidebar is not on screen');
  const x = box.x + box.width;
  const y = box.y + box.height / 2;
  await target.mouse.move(x, y);
  await target.mouse.down();
  await target.mouse.move(x + dx / 2, y);
  await target.mouse.move(x + dx, y);
  await target.mouse.up();
}

test.describe('resizing', () => {
  test.beforeEach(async () => {
    ({ app, page, userDataDir } = await launchElectron());
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('dragging the edge resizes the sidebar and the header strip above it', async () => {
    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH);

    await dragSidebarEdge(page, 80);

    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH + 80);
    expect(await headerStripWidth(page)).toBe(DEFAULT_WIDTH + 80);
  });

  test('the width stops at its bounds instead of hiding the sidebar', async () => {
    await dragSidebarEdge(page, -1000);
    expect(await sidebarWidth(page)).toBe(MIN_WIDTH);
    await expect(page.locator('.sidebar')).toBeVisible();

    await dragSidebarEdge(page, 1000);
    expect(await sidebarWidth(page)).toBe(MAX_WIDTH);
  });

  test('double-clicking the edge restores the default width', async () => {
    await dragSidebarEdge(page, 80);
    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH + 80);

    const box = await page.locator('.sidebar').boundingBox();
    if (!box) throw new Error('the sidebar is not on screen');
    await page.mouse.dblclick(box.x + box.width, box.y + box.height / 2);

    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH);
  });

  test('the width survives a relaunch', async () => {
    await dragSidebarEdge(page, 80);
    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH + 80);

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));

    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH + 80);
  });
});

const WORKSPACE_NAME = 'Consola';

/**
 * Seed a v7 workspace with two scopes and a live group directly into the
 * profile, so the sidebar has a tree to fold. main/index.ts appends ' Test'
 * to the profile dir under NODE_ENV=test, so the file must land there.
 *
 * No `provider`: a bound workspace would prime the Inbox on mount and reach
 * for a real gh. The grouped session is deliberately in `scope-app` too —
 * a live group owns its members' rows, so the scope's folded count must say
 * two, not three.
 */
function seedScopes(profileDir: string, scopeDir: string): void {
  const effective = `${profileDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const session = (id: string, name: string, scopeId: string, groupId?: string) => ({
    id,
    name,
    workspaceId: 'ws-folding-e2e',
    instanceId: `inst-${id}`,
    claudeSessionId: `claude-${id}`,
    hasStarted: false,
    harnessId: 'default',
    scopeId,
    kind: 'interactive',
    ...(groupId ? { groupId } : {}),
    createdAt: now,
    lastActiveAt: now,
  });
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify({
      version: 7,
      workspaces: [
        {
          id: 'ws-folding-e2e',
          name: WORKSPACE_NAME,
          defaultHarnessId: 'default',
          scopes: [
            { id: 'scope-app', name: 'controller-app', path: scopeDir, isGitRepo: false, createdAt: now },
            { id: 'scope-lib', name: 'shared-lib', path: scopeDir, isGitRepo: false, createdAt: now },
          ],
          groups: [{ id: 'group-fanout', name: 'Fan out', createdAt: now }],
          actions: [],
          sectionDefaults: {},
          sessions: [
            session('s1', 'Controller boot', 'scope-app'),
            session('s2', 'Fix flaky test', 'scope-app'),
            session('s3', 'Bump deps', 'scope-lib'),
            session('s4', 'Fan member', 'scope-app', 'group-fanout'),
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8'
  );
}

function switcherTrigger(target: Page) {
  return target.getByRole('button', { name: /^Switch workspace/ });
}

/** Hold the seeded workspace, unless a restored window already holds it. */
async function holdWorkspace(target: Page): Promise<void> {
  const trigger = switcherTrigger(target);
  if ((await trigger.textContent())?.trim() === WORKSPACE_NAME) return;
  await trigger.click();
  await target.getByRole('menuitem', { name: WORKSPACE_NAME }).click();
  await expect(trigger).toHaveText(WORKSPACE_NAME);
}

test.describe('folding scopes and groups', () => {
  let scopeDir: string;

  test.beforeEach(async () => {
    userDataDir = createProfileDir();
    scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-folding-'));
    seedScopes(userDataDir, scopeDir);
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
  });

  test.afterEach(async () => {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(scopeDir, { recursive: true, force: true });
  });

  const scopeGroup = (target: Page, scopeId: string) =>
    target.locator(`[data-testid="scope-group-${scopeId}"]`);

  test('a scope starts open and folds its sessions away behind a count', async () => {
    const appScope = scopeGroup(page, 'scope-app');
    const toggle = appScope.locator('.scope-row-toggle');

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(appScope.locator('.session-nav-item')).toHaveCount(2);
    await expect(appScope.locator('.scope-row-count')).toHaveCount(0);

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(appScope.locator('.session-nav-item')).toHaveCount(0);
    // The grouped session is not the scope's to count.
    await expect(appScope.locator('.scope-row-count')).toHaveText('2 sessions');

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(appScope.locator('.session-nav-item')).toHaveCount(2);
  });

  test('folding one scope leaves the others alone', async () => {
    await scopeGroup(page, 'scope-app').locator('.scope-row-toggle').click();

    await expect(scopeGroup(page, 'scope-app').locator('.session-nav-item')).toHaveCount(0);
    await expect(scopeGroup(page, 'scope-lib').locator('.session-nav-item')).toHaveCount(1);
    await expect(
      scopeGroup(page, 'scope-lib').locator('.scope-row-toggle')
    ).toHaveAttribute('aria-expanded', 'true');
  });

  test('a group folds the same way its scopes do', async () => {
    const toggle = page.locator('.group-nav-toggle');

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.group-nav-item .session-nav-item')).toHaveCount(1);

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.group-nav-item .session-nav-item')).toHaveCount(0);
    // The badge is the group's own and stays put whether folded or not.
    await expect(page.locator('.group-nav-count')).toHaveText('1');
  });

  /** A sidebar row, by the name it renders. */
  const rowFor = (target: Page, name: string) =>
    target.locator('.session-nav-item').filter({ hasText: name });

  test('the Groups heading makes a group, the way the Scopes heading adds a scope', async () => {
    await expect(page.locator('.group-nav-item')).toHaveCount(1);

    await page.getByRole('button', { name: 'Add group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New group' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill('PR reviews');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.locator('.group-nav-item')).toHaveCount(2);
    await expect(page.locator('.group-nav-name').filter({ hasText: 'PR reviews' })).toHaveCount(1);
  });

  test('the ⋯ menu moves a session into a group and back out again', async () => {
    const appScope = scopeGroup(page, 'scope-app');
    const groupRows = page.locator('.group-nav-item .session-nav-item');

    await expect(appScope.locator('.session-nav-item')).toHaveCount(2);
    await expect(groupRows).toHaveCount(1);

    // Folded first: a move into a group nobody can see must unfold it, or the
    // row would appear to have been deleted rather than moved.
    const groupToggle = page.locator('.group-nav-toggle');
    await groupToggle.click();
    await expect(groupToggle).toHaveAttribute('aria-expanded', 'false');

    const row = rowFor(page, 'Controller boot');
    await row.hover();
    await row.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to group' }).click();
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();

    await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');
    // The group owns the row now, so the scope it still runs in stops
    // drawing it — the partition keeps a session on exactly one row.
    await expect(groupRows).toHaveCount(2);
    await expect(appScope.locator('.session-nav-item')).toHaveCount(1);
    await expect(groupRows.filter({ hasText: 'Controller boot' })).toHaveCount(1);

    const moved = rowFor(page, 'Controller boot');
    await moved.hover();
    await moved.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to group' }).click();
    await page.getByRole('menuitem', { name: 'Remove from group' }).click();

    await expect(groupRows).toHaveCount(1);
    await expect(appScope.locator('.session-nav-item')).toHaveCount(2);
  });

  test('a move survives a relaunch — it is a record, not a view preference', async () => {
    test.setTimeout(60_000);
    const row = rowFor(page, 'Bump deps');
    await row.hover();
    await row.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to group' }).click();
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();
    await expect(page.locator('.group-nav-item .session-nav-item')).toHaveCount(2);

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);

    await expect(
      page.locator('.group-nav-item .session-nav-item').filter({ hasText: 'Bump deps' })
    ).toHaveCount(1);
    await expect(scopeGroup(page, 'scope-lib').locator('.session-nav-item')).toHaveCount(0);
  });

  test('a fold survives a relaunch', async () => {
    test.setTimeout(60_000);
    await scopeGroup(page, 'scope-app').locator('.scope-row-toggle').click();
    await page.locator('.group-nav-toggle').click();

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);

    await expect(
      scopeGroup(page, 'scope-app').locator('.scope-row-toggle')
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(scopeGroup(page, 'scope-app').locator('.session-nav-item')).toHaveCount(0);
    await expect(page.locator('.group-nav-toggle')).toHaveAttribute('aria-expanded', 'false');
    // The one nobody touched is still open.
    await expect(
      scopeGroup(page, 'scope-lib').locator('.scope-row-toggle')
    ).toHaveAttribute('aria-expanded', 'true');
  });
});
