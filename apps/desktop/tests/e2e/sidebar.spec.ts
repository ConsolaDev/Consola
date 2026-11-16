import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandPaletteChord, createProfileDir, launchElectron } from './helpers/electron';
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

/** Where the title bar's menus sit: the part a sidebar drag must not move. */
async function titleBarLayout(target: Page) {
  const header = await target.locator('.app-header').boundingBox();
  const menus = await target.locator('.app-header-context').boundingBox();
  if (!header || !menus) throw new Error('the title bar is not on screen');
  return { headerWidth: header.width, menusX: menus.x };
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

  test('dragging the edge resizes the sidebar and the strip above it, and leaves the workspace menu where it was', async () => {
    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH);
    const before = await titleBarLayout(page);
    expect(before.headerWidth).toBe(DEFAULT_WIDTH + 56);

    await dragSidebarEdge(page, 80);

    expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH + 80);
    const after = await titleBarLayout(page);
    expect(after.headerWidth).toBe(DEFAULT_WIDTH + 80 + 56);
    expect(after.menusX).toBe(before.menusX);
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
      // The offline fixture, not whatever codex is installed: a real one keeps
      // writing its profile after the app closes, racing the teardown.
      binaryPath: path.resolve('tests/fixtures/codex.cjs'),
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
            { id: 'scope-app', name: 'catalog-portal', path: scopeDir, isGitRepo: false, createdAt: now },
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

/** Hold the seeded workspace through its rail button. */
async function holdWorkspace(target: Page): Promise<void> {
  const button = target.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: WORKSPACE_NAME, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
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
    // A session the test opened launched a CLI that may still be writing its
    // profile here as the app closes; retry rather than race it.
    fs.rmSync(scopeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /**
   * Where the seeded sessions sit: all of them are ready and none has run, so
   * every row is under Recent. Attention, not group or scope, decides sections.
   */
  const recent = (target: Page) => target.locator('.sidebar-bucket--recent');
  /** The labels a ⋯ menu write left on a session, read back from main. */
  const labelsOf = (target: Page, sessionId: string) =>
    target.evaluate(
      async (id) => (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions.find((candidate) => candidate.id === id)!.labelIds,
      sessionId
    );
  /** Open a row's ⋯ menu and its Labels submenu, from the keyboard the way the trigger is meant to be used. */
  const openLabelsMenu = async (target: Page, name: string) => {
    const row = rowFor(target, name);
    await row.hover();
    await row.getByRole('button', { name: 'Session actions' }).click();
    await target.getByRole('menuitem', { name: 'Labels', exact: true }).focus();
    await target.keyboard.press('ArrowRight');
  };
  /** A sidebar row, by the name it renders. */
  const rowFor = (target: Page, name: string) =>
    target.locator('.session-nav-item').filter({ hasText: name });
  const chooseScope = async (target: Page, name: string) => {
    await target.getByRole('button', { name: 'Filter sessions', exact: true }).click();
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
    await chooseScope(page, 'catalog-portal');
    await expect(page.locator('.session-nav-item-model')).toHaveCount(2);
    await expect(page.locator('.session-nav-item-model').first()).toHaveText('claude-opus-4-6');
    await expect(page.locator('.sidebar [data-harness-type="claude"]')).toHaveCount(3);
    await chooseScope(page, 'shared-lib');
    await expect(page.locator('.sidebar [data-harness-type="codex"]')).toHaveCount(1);
    await expect(page.locator('.sidebar [data-harness-type="codex"]')).toHaveAttribute('title', 'Codex · Codex archived');
    await chooseScope(page, 'catalog-portal');
    await page.getByRole('button', { name: 'Navigation settings', exact: true }).click();
    const toggle = page.getByRole('menuitemcheckbox', { name: 'Model', exact: true });
    const harnessToggle = page.getByRole('menuitemcheckbox', { name: 'Harness icon', exact: true });
    await expect(harnessToggle).toBeChecked();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('.session-nav-item-model')).toHaveCount(0);
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(3);
    await harnessToggle.click();
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await chooseScope(page, 'catalog-portal');
    await expect(page.locator('.session-nav-item-model')).toHaveCount(0);
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.getByRole('button', { name: 'Navigation settings', exact: true }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Model', exact: true })).not.toBeChecked();
    await page.getByRole('menuitemcheckbox', { name: 'Model', exact: true }).click();
    await expect(page.locator('.session-nav-item-model')).toHaveCount(2);
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.getByRole('menuitemcheckbox', { name: 'Harness icon', exact: true }).click();
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(3);
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

  test('scope selection filters the list, and Clear filters brings every scope back', async () => {
    // All scopes by default: every session, each naming the scope it runs in.
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);
    await expect(rowFor(page, 'Bump deps').locator('.session-nav-item-scope')).toContainText('shared-lib');
    await chooseScope(page, 'shared-lib');
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(1);
    await expect(recent(page)).toContainText('Bump deps');
    // A filtered list says its scope once, in the filter bar, never per row.
    await expect(page.locator('.session-nav-item-scope')).toHaveCount(0);
    await chooseScope(page, 'catalog-portal');
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(3);
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Manage scopes…' }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace settings sections' }).getByRole('button', { name: 'Scopes', exact: true })).toHaveAttribute('aria-current', 'true');
  });

  test('a label filter and a scope narrow together, and one Clear filters resets both', async () => {
    // "Fan out" was a group before the v8 migration; its members now carry it as a label.
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await page.getByRole('menuitem', { name: /Fan out/ }).click();
    await page.keyboard.press('Escape');
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(1);
    await expect(recent(page)).toContainText('Fan member');
    await chooseScope(page, 'shared-lib');
    await expect(page.locator('.session-nav-item')).toHaveCount(0);
    await expect(page.getByText('No sessions match these filters.')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await expect(page.locator('.sidebar-filter-chips')).toHaveCount(0);
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);
  });

  const jumpWithPalette = async (target: Page, name: string) => {
    await target.keyboard.press(commandPaletteChord());
    const palette = target.getByRole('dialog', { name: 'Command palette', exact: true });
    await palette.getByRole('combobox').fill(name);
    await palette.getByRole('option', { name: new RegExp(name) }).click();
  };

  test('selecting a session in another scope from the palette reveals its scope', async () => {
    await chooseScope(page, 'catalog-portal');
    await expect(page.locator('.sidebar-scope-filter')).toContainText('catalog-portal');
    await jumpWithPalette(page, 'Bump deps');
    await expect(page.locator('.sidebar-scope-filter')).toContainText('shared-lib');
    await expect(page.locator('.session-nav-item.active')).toContainText('Bump deps');
  });

  test('a palette jump under All leaves the list showing every scope', async () => {
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await jumpWithPalette(page, 'Bump deps');
    await expect(page.locator('.session-nav-item.active')).toContainText('Bump deps');
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);
  });

  test('the scope row sits under the Assistant on Home only, never in the title bar', async () => {
    await expect(page.locator('.app-header').getByRole('button', { name: 'Filter sessions' })).toHaveCount(0);
    await expect(page.locator('.sidebar-scope-divider')).toHaveCount(1);
    await expect(page.locator('.sidebar-scope-filter')).toHaveCount(1);
    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await expect(page.locator('.sidebar-scope-filter')).toHaveCount(0);
    await expect(page.locator('.sidebar-scope-divider')).toHaveCount(0);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.locator('.sidebar-scope-divider')).toHaveCount(1);
    await expect(page.locator('.sidebar-scope-filter')).toHaveCount(1);
  });

  test('a workspace with one scope still shows the scope row', async () => {
    await app.close();
    const file = path.join(`${userDataDir} Test`, 'workspaces.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const workspace = data.workspaces[0];
    workspace.scopes = workspace.scopes.filter((candidate: { id: string }) => candidate.id === 'scope-app');
    for (const session of workspace.sessions) session.scopeId = 'scope-app';
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);

    await expect(page.locator('.sidebar-scope-divider')).toHaveCount(1);
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /catalog-portal/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Add scope', exact: true })).toBeVisible();
    // One scope has nothing to tell apart, so rows stay unlabelled.
    await page.keyboard.press('Escape');
    await expect(page.locator('.session-nav-item-scope')).toHaveCount(0);
  });

  test('session options share the selected scope without creating a session early', async () => {
    await chooseScope(page, 'shared-lib');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN');
    await expect(page.getByLabel('Scope', { exact: true }).locator('.session-option-name')).toHaveText('shared-lib');
    await expect(page.getByLabel('Group', { exact: true })).toContainText('Ungrouped');
    const count = () => page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions.length);
    expect(await count()).toBe(4);
    await page.getByLabel('Scope', { exact: true }).click();
    await page.getByRole('option', { name: 'catalog-portal', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.sidebar-scope-filter')).toContainText('shared-lib');
    await expect(page.locator('.dropdown-content')).toHaveCount(0);
    await page.mouse.move(500, 100);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('.radix-themes')).toHaveClass(/light/);
    await page.screenshot({ path: 'test-results/home-sidebar-light.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.radix-themes')).toHaveClass(/dark/);
    await page.screenshot({ path: 'test-results/home-sidebar-dark.png', animations: 'disabled' });

    // The same sidebar under All, with a session open so the pane names its scope.
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await rowFor(page, 'Bump deps').click();
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await page.mouse.move(500, 300);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('.radix-themes')).toHaveClass(/light/);
    await page.screenshot({ path: 'test-results/home-sidebar-all-light.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.radix-themes')).toHaveClass(/dark/);
    await page.screenshot({ path: 'test-results/home-sidebar-all-dark.png', animations: 'disabled' });
  });

  test('the pane names the scope the open session runs in', async () => {
    await rowFor(page, 'Bump deps').click();
    const title = page.locator('.workspace-view-header .workspace-view-title');
    await expect(title).toHaveText(/^shared-lib\s*\/\s*Bump deps$/);
    // Production's breadcrumb: the scope in primary text, never dimmed.
    const colors = await title.evaluate(element => ({
      title: getComputedStyle(element).color,
      scope: getComputedStyle(element.firstElementChild!).color,
    }));
    expect(colors.scope).toBe(colors.title);
  });

  test("the open session's row is the title bar beside the sidebar's strip, as in production", async () => {
    await rowFor(page, 'Bump deps').click();
    const header = page.locator('.workspace-view-header');
    await expect(header).toContainText('Bump deps');
    const row = (await header.boundingBox())!;
    const strip = (await page.locator('.app-header').boundingBox())!;
    const sidebar = (await page.locator('.sidebar').boundingBox())!;
    expect(row.y).toBe(0);
    expect(row.x).toBeCloseTo(sidebar.x + sidebar.width, 0);
    expect(strip.x + strip.width).toBeCloseTo(row.x, 0);
    // Its blank space drags the window, as the strip beside it does.
    expect(await header.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('drag');
  });

  test('a row that names its scope keeps its dot beside the rename field', async () => {
    const row = rowFor(page, 'Fix flaky test');
    await expect(row.locator('.session-nav-item-scope')).toContainText('catalog-portal');
    // Measured the moment the field mounts: the open session's terminal can
    // take focus right after, which commits the rename and closes the field.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const input = document.querySelector('.session-rename-input');
        const dot = input?.closest('.session-nav-item')?.querySelector('.session-status-indicator');
        if (!input || !dot) return;
        const centre = (element: Element) => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
        (window as any).__renameOffset = Math.abs(centre(dot) - centre(input));
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await row.hover();
    await row.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    // The scope line gives way to the field, so the dot must not stay below it.
    await expect.poll(() => page.evaluate(() => (window as any).__renameOffset)).toBeLessThanOrEqual(2);
  });

  const workingHeader = (target: Page) => target.getByRole('button', { name: /^Working/ });
  const workingChord = process.platform === 'darwin' ? 'Meta+Shift+KeyB' : 'Control+Shift+KeyB';

  test('the Working shelf starts collapsed with a live count, and one chord opens it', async () => {
    const header = workingHeader(page);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    // Nothing has run, so nothing is working; the count is live, not a label.
    await expect(header.locator('.shelf-header-count')).toHaveText('0');

    await page.keyboard.press(workingChord);
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press(workingChord);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  test('the palette shows or hides the Working shelf', async () => {
    await page.keyboard.press(commandPaletteChord());
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await palette.getByRole('combobox').fill('working sessions');
    await palette.getByRole('option', { name: /Show or hide working sessions/ }).click();
    await expect(workingHeader(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('the Settled shelf is there and empty: nothing settles until slice 7', async () => {
    const header = page.getByRole('button', { name: /^Settled/ });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(header.locator('.shelf-header-count')).toHaveText('0');
  });

  test('archiving a group never hides its sessions', async () => {
    await page.evaluate(() => window.workspaceAPI.archiveGroup('ws-folding-e2e', 'group-fanout'));
    // Groups are not a place any more: the member stays among the others.
    await expect(rowFor(page, 'Fan member')).toHaveCount(1);
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);
  });

  test('the ⋯ menu\'s New label… creates a label and gives it to the session in one step', async () => {
    expect(await labelsOf(page, 's1')).toBeUndefined();
    await openLabelsMenu(page, 'Controller boot');
    await page.getByRole('menuitem', { name: 'New label…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New label' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill('PR reviews');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog).toBeHidden();
    const snapshot = await page.evaluate(async () => {
      const workspace = (await window.workspaceAPI.getSnapshot()).workspaces[0];
      return { labels: workspace.labels.map((label) => ({ id: label.id, name: label.name })), groups: workspace.groups.length };
    });
    expect(snapshot.labels.map((label) => label.name)).toEqual(['Fan out', 'PR reviews']);
    await expect.poll(() => labelsOf(page, 's1')).toEqual([snapshot.labels[1].id]);
    // A label, not a group: nothing is written that no screen could show.
    expect(snapshot.groups).toBe(1);
  });

  test('the ⋯ menu ticks and unticks a label on a session', async () => {
    expect(await labelsOf(page, 's1')).toBeUndefined();

    await openLabelsMenu(page, 'Controller boot');
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();
    await expect.poll(() => labelsOf(page, 's1')).toEqual(['group-fanout']);
    // A label is a tag, not a place: the row has not moved anywhere.
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);

    // The same item unticks it. The menu stays open after a pick, but the
    // submenu does not survive the row re-rendering, so reopen from scratch.
    await page.keyboard.press('Escape');
    await openLabelsMenu(page, 'Controller boot');
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();
    await expect.poll(() => labelsOf(page, 's1')).toEqual([]);
  });

  test('a label assignment survives a relaunch — it is a record, not a view preference', async () => {
    test.setTimeout(60_000);
    await openLabelsMenu(page, 'Bump deps');
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();
    await expect.poll(() => labelsOf(page, 's3')).toEqual(['group-fanout']);

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);

    expect(await labelsOf(page, 's3')).toEqual(['group-fanout']);
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);
  });

  test('the row settles from hover and back; deleting stays in the menu and confirms', async () => {
    const settledHeader = page.getByRole('button', { name: /^Settled/ });
    const row = rowFor(page, 'Controller boot');
    const settle = row.getByRole('button', { name: 'Settle session Controller boot', exact: true });
    const confirmation = 'Delete session "Controller boot"? This will remove the session and its chat history.';
    // Stub the native dialog so both cancellation and acceptance are exercised
    // without relying on platform-specific Electron dialog automation.
    await page.evaluate(() => {
      window.confirm = (message) => {
        (window as any).__deleteConfirmation = message;
        return false;
      };
    });

    // The row's one-click slot is the reversible move; destroying a session and
    // its history is behind the ⋯ menu, where a mis-aimed click cannot reach it.
    await row.getByRole('button', { name: 'Session actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__deleteConfirmation)).toBe(confirmation);
    await expect(row).toHaveCount(1);

    // Settling acts in place and must not activate the row it acts on.
    const activeBefore = await page.locator('.session-nav-item.active').allTextContents();
    await expect(settledHeader).toHaveText(/0/);
    await row.hover();
    await expect(settle).toBeVisible();
    await settle.click();
    await expect(settledHeader).toHaveText(/1/);
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(3);
    expect(await page.locator('.session-nav-item.active').allTextContents()).toEqual(activeBefore);

    // The same slot offers the way back, so nothing is settled irreversibly by
    // a stray click — the shelf has to be open for its rows to be reachable.
    await settledHeader.click();
    const shelved = page.getByRole('navigation', { name: 'Settled sessions' }).locator('.session-nav-item').first();
    await shelved.hover();
    await shelved.getByRole('button', { name: 'Move Controller boot back to the list', exact: true }).click();
    await expect(settledHeader).toHaveText(/0/);
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);

    // Tab order: the row, its ⋯ trigger, then its one action.
    await row.focus();
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Session actions', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(settle).toBeFocused();

    await page.evaluate(() => { window.confirm = () => true; });
    await row.getByRole('button', { name: 'Session actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('.session-nav-item')).toHaveCount(3);
  });

  test('a shelf choice survives a relaunch', async () => {
    test.setTimeout(60_000);
    await workingHeader(page).click();
    await expect(workingHeader(page)).toHaveAttribute('aria-expanded', 'true');
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await expect(workingHeader(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(recent(page).locator('.session-nav-item')).toHaveCount(4);
  });
});
