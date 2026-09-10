import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';

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
    expect(await headerStripWidth(page)).toBe(DEFAULT_WIDTH + 80 + 56);
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
  const builtIn = { ...createBuiltInHarness(), configDir: path.join(scopeDir, 'claude-profile') };
  fs.writeFileSync(path.join(effective, 'harnesses.json'), JSON.stringify({
    version: 1,
    harnesses: [builtIn, {
      ...builtIn, id: 'codex-test', driverId: 'codex', name: 'Codex archived',
      isBuiltIn: false, archived: true, configDir: path.join(scopeDir, 'codex-profile'),
    }],
  }));
  const session = (id: string, name: string, scopeId: string, groupId?: string) => ({
    id,
    name,
    workspaceId: 'ws-folding-e2e',
    instanceId: `inst-${id}`,
    claudeSessionId: `claude-${id}`,
    hasStarted: false,
    harnessId: id === 's3' ? 'codex-test' : 'default',
    ...(id === 's1' || id === 's4' ? { model: 'claude-opus-4-6' } : {}),
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
  if ((await trigger.locator('.workspace-switcher-name').textContent())?.trim() === WORKSPACE_NAME) return;
  await trigger.click();
  await target.getByRole('menuitem', { name: WORKSPACE_NAME }).click();
  await expect(trigger.locator('.workspace-switcher-name')).toHaveText(WORKSPACE_NAME);
}

test.describe('Home scopes and groups', () => {
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

  const ungrouped = (target: Page) => target.locator('.sidebar-ungrouped');
  const chooseScope = async (target: Page, name: string) => {
    await target.locator('.sidebar').getByRole('button', { name: 'Choose scope', exact: true }).click();
    await target.getByRole('menuitem', { name: new RegExp(name) }).click();
  };

  test('explorer width survives hiding, switching sessions and relaunching', async () => {
    test.setTimeout(60_000);
    await page.locator('.session-nav-item').filter({ hasText: 'Controller boot' }).click();
    await page.getByRole('button', { name: 'Show file explorer', exact: true }).click();
    const explorer = () => page.getByTestId('explorer');
    const width = async () => (await explorer().boundingBox())!.width;
    await expect(explorer()).toBeVisible();
    await expect.poll(width).toBeCloseTo(240, 0);
    const handle = page.locator('.workspace-view-content .resize-handle').first();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(width).toBeCloseTo(180, 0);
    const preferred = await width();

    await page.getByRole('button', { name: 'Hide file explorer', exact: true }).click();
    await expect(explorer()).toHaveCount(0);
    await page.getByRole('button', { name: 'Show file explorer', exact: true }).click();
    await expect.poll(width).toBeCloseTo(preferred, 0);
    await page.locator('.session-nav-item').filter({ hasText: 'Fix flaky test' }).click();
    await expect.poll(width).toBeCloseTo(preferred, 0);

    // Relaunch while hidden: the agent-only layout must not erase the width.
    await page.getByRole('button', { name: 'Hide file explorer', exact: true }).click();
    await expect(explorer()).toHaveCount(0);
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await page.getByRole('button', { name: 'Show file explorer', exact: true }).click();
    await expect.poll(width).toBeCloseTo(preferred, 0);
  });

  test('model and harness metadata toggle independently and stay hidden after relaunch', async () => {
    test.setTimeout(60_000);
    await page.getByRole('tab', { name: 'All your sessions' }).click();
    await expect(page.locator('.session-nav-item-model')).toHaveCount(2);
    await expect(page.locator('.session-nav-item-model').first()).toHaveText('claude-opus-4-6');
    await expect(page.locator('.sidebar [data-harness-type="claude"]')).toHaveCount(3);
    await expect(page.locator('.sidebar [data-harness-type="codex"]')).toHaveCount(1);
    await expect(page.locator('.sidebar [data-harness-type="codex"]')).toHaveAttribute('title', 'Codex · Codex archived');
    await page.getByRole('button', { name: 'Navigation settings', exact: true }).click();
    const toggle = page.getByRole('menuitemcheckbox', { name: 'Model', exact: true });
    const harnessToggle = page.getByRole('menuitemcheckbox', { name: 'Harness icon', exact: true });
    await expect(harnessToggle).toBeChecked();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('.session-nav-item-model')).toHaveCount(0);
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(4);
    await harnessToggle.click();
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await page.getByRole('tab', { name: 'All your sessions' }).click();
    await expect(page.locator('.session-nav-item-model')).toHaveCount(0);
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.getByRole('button', { name: 'Navigation settings', exact: true }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Model', exact: true })).not.toBeChecked();
    await page.getByRole('menuitemcheckbox', { name: 'Model', exact: true }).click();
    await expect(page.locator('.session-nav-item-model')).toHaveCount(2);
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.getByRole('menuitemcheckbox', { name: 'Harness icon', exact: true }).click();
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(4);
  });

  test('the row follows runtime model changes without replacing the pinned launch model', async () => {
    const transcript = path.join(scopeDir, 'claude-profile', 'projects', 'repo', 'claude-s1.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n');
    const row = page.locator('.session-nav-item').filter({ hasText: 'Controller boot' });
    await expect(row.locator('.session-nav-item-model')).toHaveText('claude-sonnet-4-6', { timeout: 10_000 });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-6' } }) + '\n');
    await expect(row.locator('.session-nav-item-model')).toHaveText('claude-opus-4-6', { timeout: 10_000 });
    const stored = JSON.parse(fs.readFileSync(path.join(`${userDataDir} Test`, 'workspaces.json'), 'utf8'));
    expect(stored.workspaces[0].sessions.find((session: { id: string }) => session.id === 's1').model).toBe('claude-opus-4-6');
  });

  test('scope selection filters both groups and ungrouped sessions', async () => {
    await expect(ungrouped(page).locator('.session-nav-item')).toHaveCount(2);
    await expect(page.locator('.group-nav-count')).toHaveText('1');
    await chooseScope(page, 'shared-lib');
    await expect(ungrouped(page).locator('.session-nav-item')).toHaveCount(1);
    await expect(ungrouped(page)).toContainText('Bump deps');
    await expect(page.locator('.group-nav-count')).toHaveText('0');
    await expect(page.locator('.group-nav-item .session-nav-item')).toHaveCount(0);
    await chooseScope(page, 'controller-app');
    await expect(ungrouped(page).locator('.session-nav-item')).toHaveCount(2);
    await page.locator('.sidebar').getByRole('button', { name: 'Choose scope' }).click();
    await page.getByRole('menuitem', { name: 'Manage scopes…' }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace settings sections' }).getByRole('button', { name: 'Scopes', exact: true })).toHaveAttribute('aria-current', 'true');
  });

  test('All your sessions spans scopes and selecting a session reveals its Home scope', async () => {
    await page.getByRole('tab', { name: 'All your sessions' }).click();
    await expect(page.locator('.session-nav-item')).toHaveCount(4);
    await page.locator('.session-nav-item').filter({ hasText: 'Bump deps' }).click();
    await page.getByRole('tab', { name: 'Home', exact: true }).click();
    await expect(page.locator('.sidebar .scope-selector')).toContainText('shared-lib');
    await expect(page.locator('.session-nav-item.active')).toContainText('Bump deps');
  });

  test('group and ungrouped creation share the selected scope without creating a session early', async () => {
    await chooseScope(page, 'shared-lib');
    await page.locator('.group-nav-header').hover();
    await page.getByRole('button', { name: 'New session in Fan out', exact: true }).click();
    await expect(page.locator('.new-session-view .scope-selector')).toContainText('shared-lib');
    await expect(page.getByRole('button', { name: 'Choose group' })).toContainText('Fan out');
    const count = () => page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions.length);
    expect(await count()).toBe(4);
    await page.getByRole('button', { name: 'New ungrouped session' }).click();
    await expect(page.getByRole('button', { name: 'Choose group' })).toContainText('Ungrouped');
    await expect(page.locator('.new-session-view .scope-selector')).toContainText('shared-lib');
    expect(await count()).toBe(4);
    await page.getByRole('combobox', { name: 'Message' }).fill('Keep this draft when switching scopes');
    await chooseScope(page, 'controller-app');
    await expect(page.getByRole('combobox', { name: 'Message' })).toHaveValue('Keep this draft when switching scopes');
    await expect(page.locator('.dropdown-content')).toHaveCount(0);
    await page.mouse.move(500, 100);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('.radix-themes')).toHaveClass(/light/);
    await page.screenshot({ path: 'test-results/home-sidebar-light.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.radix-themes')).toHaveClass(/dark/);
    await page.screenshot({ path: 'test-results/home-sidebar-dark.png', animations: 'disabled' });
  });

  test('a group folds and retains its scope-filtered count', async () => {
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

  test('the session × and menu share confirmation without activating the row', async () => {
    const row = rowFor(page, 'Controller boot');
    const close = row.getByRole('button', { name: 'Delete session Controller boot', exact: true });
    const confirmation = 'Delete session "Controller boot"? This will remove the session and its chat history.';
    // Stub the native dialog so both cancellation and acceptance are exercised
    // without relying on platform-specific Electron dialog automation.
    await page.evaluate(() => {
      window.confirm = (message) => {
        (window as any).__deleteConfirmation = message;
        return false;
      };
    });
    const activeBefore = await page.locator('.session-nav-item.active').allTextContents();
    await row.hover();
    await expect(close).toBeVisible();
    await close.click();
    expect(await page.evaluate(() => (window as any).__deleteConfirmation)).toBe(confirmation);
    await expect(row).toHaveCount(1);
    expect(await page.locator('.session-nav-item.active').allTextContents()).toEqual(activeBefore);

    await page.evaluate(() => { (window as any).__deleteConfirmation = undefined; });
    await row.getByRole('button', { name: 'Session actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__deleteConfirmation)).toBe(confirmation);
    await expect(row).toHaveCount(1);

    await page.evaluate(() => { window.confirm = () => true; });
    await row.focus();
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Session actions', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row).toHaveCount(0);
    await expect(page.locator('.session-nav-item')).toHaveCount(2);
  });

  test('the group menu archives the group and returns its sessions to Ungrouped', async () => {
    const header = page.locator('.group-nav-header');
    await header.hover();
    await header.getByRole('button', { name: 'Group actions for Fan out', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Archive group', exact: true }).click();
    await expect(page.locator('.group-nav-item')).toHaveCount(0);
    await expect(ungrouped(page).locator('.session-nav-item')).toHaveCount(3);
    await expect(rowFor(page, 'Fan member')).toHaveCount(1);
  });

  test('the Your groups heading creates a group', async () => {
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
    const appScope = ungrouped(page);
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

    // Leaving sits beside the submenu, not inside it: the way out must not be
    // filed under the list of places to go.
    const moved = rowFor(page, 'Controller boot');
    await moved.hover();
    await moved.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Remove from group' }).click();

    await expect(groupRows).toHaveCount(1);
    await expect(appScope.locator('.session-nav-item')).toHaveCount(2);
  });

  test('a move survives a relaunch — it is a record, not a view preference', async () => {
    test.setTimeout(60_000);
    await chooseScope(page, 'shared-lib');
    const row = rowFor(page, 'Bump deps');
    await row.hover();
    await row.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to group' }).click();
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();
    await expect(page.locator('.group-nav-item .session-nav-item')).toHaveCount(1);

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await chooseScope(page, 'shared-lib');

    await expect(
      page.locator('.group-nav-item .session-nav-item').filter({ hasText: 'Bump deps' })
    ).toHaveCount(1);
    await expect(ungrouped(page).locator('.session-nav-item')).toHaveCount(0);
  });

  test('a group fold survives a relaunch', async () => {
    test.setTimeout(60_000);
    await page.locator('.group-nav-toggle').click();
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await expect(page.locator('.group-nav-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(ungrouped(page).locator('.session-nav-item')).toHaveCount(2);
  });
});
