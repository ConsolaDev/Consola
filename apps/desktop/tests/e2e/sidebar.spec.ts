import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  commandPaletteChord,
  createProfileDir,
  launchElectron,
  settingsChord,
} from './helpers/electron';
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
  fs.writeFileSync(
    path.join(effective, 'harnesses.json'),
    JSON.stringify({
      version: 1,
      harnesses: [
        builtIn,
        {
          ...builtIn,
          id: 'codex-test',
          driverId: 'codex',
          name: 'Codex archived',
          isBuiltIn: false,
          archived: true,
          configDir: path.join(scopeDir, 'codex-profile'),
          // The offline fixture, not whatever codex is installed: a real one keeps
          // writing its profile after the app closes, racing the teardown.
          binaryPath: path.resolve('tests/fixtures/codex.cjs'),
        },
      ],
    }),
  );
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
            {
              id: 'scope-app',
              name: 'catalog-portal',
              path: scopeDir,
              isGitRepo: false,
              createdAt: now,
            },
            {
              id: 'scope-lib',
              name: 'shared-lib',
              path: scopeDir,
              isGitRepo: false,
              createdAt: now,
            },
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
    'utf8',
  );
}

/** Hold the seeded workspace through its rail button. */
async function holdWorkspace(target: Page): Promise<void> {
  const button = target
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true });
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
   * Where the seeded sessions sit: all of them are ready and none has run or
   * been put away, so every row is at the top of the list, under no heading.
   * Attention, not group or scope, decides sections.
   */
  const topList = (target: Page) => target.locator('.sidebar-bucket--waiting');
  /** The labels an actions-menu write left on a session, read back from main. */
  const labelsOf = (target: Page, sessionId: string) =>
    target.evaluate(
      async (id) =>
        (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions.find(
          (candidate) => candidate.id === id,
        )!.labelIds,
      sessionId,
    );
  /** Open a row's actions menu and its Labels submenu. */
  const openLabelsMenu = async (target: Page, name: string) => {
    const row = rowFor(target, name);
    await row.click({ button: 'right' });
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

  test('side panel width survives hiding, switching sessions and relaunching', async () => {
    test.setTimeout(60_000);
    await page.locator('.session-nav-item').filter({ hasText: 'Controller boot' }).click();
    const files = () => page.getByRole('button', { name: 'Files', exact: true });
    const sidePanel = () => page.getByTestId('side-panel');
    const width = async () => (await sidePanel().boundingBox())!.width;
    await files().click();
    await expect(sidePanel()).toBeVisible();
    const before = await width();
    const handle = page.locator('.workspace-view-content .resize-handle').first();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await width()) - (before + 60))).toBeLessThanOrEqual(1);
    const preferred = await width();

    await files().click();
    await expect(sidePanel()).toHaveCount(0);
    await files().click();
    await expect.poll(width).toBeCloseTo(preferred, 0);
    await page.locator('.session-nav-item').filter({ hasText: 'Fix flaky test' }).click();
    await expect.poll(width).toBeCloseTo(preferred, 0);

    // Relaunch while hidden: the conversation-only layout must not erase the width.
    await files().click();
    await expect(sidePanel()).toHaveCount(0);
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await files().click();
    await expect.poll(width).toBeCloseTo(preferred, 0);
  });

  test('model and harness metadata toggle independently and stay hidden after relaunch', async () => {
    test.setTimeout(60_000);
    await chooseScope(page, 'catalog-portal');
    await expect(page.locator('.session-nav-item-model')).toHaveCount(2);
    // Said the way a person says it, on the line with the harness; the id is the tooltip.
    await expect(page.locator('.session-nav-item-model').first()).toHaveText('Opus 4.6');
    await expect(page.locator('.session-nav-item-model').first()).toHaveAttribute(
      'title',
      'claude-opus-4-6',
    );
    await expect(page.locator('.session-row-meta .session-nav-item-model')).toHaveCount(2);
    await expect(page.locator('.sidebar [data-harness-type="claude"]')).toHaveCount(3);
    await chooseScope(page, 'shared-lib');
    await expect(page.locator('.sidebar [data-harness-type="codex"]')).toHaveCount(1);
    await expect(page.locator('.sidebar [data-harness-type="codex"]')).toHaveAttribute(
      'title',
      'Codex · Codex archived',
    );
    // With more than one harness, each row wears its harness's initials in
    // the harness's accent colour, so two profiles of one CLI read apart.
    await expect(page.locator('.session-harness-initials')).toHaveText('CA');
    await expect(page.locator('.session-harness-mark').first()).toHaveAttribute(
      'style',
      /--harness-accent/,
    );
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
    await expect(
      page.getByRole('menuitemcheckbox', { name: 'Model', exact: true }),
    ).not.toBeChecked();
    await page.getByRole('menuitemcheckbox', { name: 'Model', exact: true }).click();
    await expect(page.locator('.session-nav-item-model')).toHaveCount(2);
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.getByRole('menuitemcheckbox', { name: 'Harness icon', exact: true }).click();
    await expect(page.locator('.session-nav-item-harness')).toHaveCount(3);
  });

  test('compact rows say each session in one line, chosen in the menu or Settings, and stay after relaunch', async () => {
    test.setTimeout(60_000);
    await chooseScope(page, 'catalog-portal');
    const controller = rowFor(page, 'Controller boot');
    const listed = page.locator('.sidebar-bucket--waiting .session-nav-item');
    // Detailed is the default: the model rides the line above the name.
    await expect(controller.locator('.session-row-meta .session-nav-item-model')).toHaveText(
      'Opus 4.6',
    );

    await page.getByRole('button', { name: 'Navigation settings', exact: true }).click();
    const detailed = page.getByRole('menuitemradio', { name: 'Detailed', exact: true });
    const compact = page.getByRole('menuitemradio', { name: 'Compact', exact: true });
    await expect(detailed).toBeChecked();
    await compact.click();
    // The menu stays open, so the list behind it is what answers the click.
    await expect(compact).toBeChecked();
    await expect(controller).toHaveClass(/session-nav-item--dense/);
    // One line: the harness leads the name, and the model moves to the
    // tooltip. The menu says where the model went.
    await expect(controller.locator('.session-row-meta')).toHaveCount(0);
    await expect(controller.locator('.session-row-lead .session-nav-item-harness')).toHaveCount(1);
    await expect(page.locator('.sidebar .session-nav-item-model')).toHaveCount(0);
    await expect(controller).toHaveAttribute('title', /claude-opus-4-6/);
    await expect(page.getByRole('menuitemcheckbox', { name: 'Model', exact: true })).toContainText(
      'Detailed rows only',
    );
    // Every row is the same height, whatever it carries.
    const heights = await listed.evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().height)),
    );
    expect(new Set(heights).size).toBe(1);
    // The harness toggle still applies to a compact row.
    await page.getByRole('menuitemcheckbox', { name: 'Harness icon', exact: true }).click();
    await expect(controller.locator('.session-nav-item-harness')).toHaveCount(0);
    await page.getByRole('menuitemcheckbox', { name: 'Harness icon', exact: true }).click();
    await page.keyboard.press('Escape');

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await expect(rowFor(page, 'Controller boot')).toHaveClass(/session-nav-item--dense/);

    // Settings → Sessions offers the same choice, and says which is in use.
    await page.keyboard.press(settingsChord());
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Sessions', exact: true }).first().click();
    const rows = settings.getByRole('radiogroup', { name: 'Session rows' });
    await expect(rows.getByRole('radio', { name: 'Compact', exact: true })).toBeChecked();
    await rows.locator('.session-rows-card').filter({ hasText: 'Detailed' }).click();
    await expect(rows.getByRole('radio', { name: 'Detailed', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(rowFor(page, 'Controller boot')).not.toHaveClass(/session-nav-item--dense/);
    await expect(
      rowFor(page, 'Controller boot').locator('.session-row-meta .session-nav-item-model'),
    ).toHaveText('Opus 4.6');
  });

  test('the row follows runtime model changes without replacing the pinned launch model', async () => {
    const transcript = path.join(scopeDir, 'claude-profile', 'projects', 'repo', 'claude-s1.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }) + '\n',
    );
    const row = page.locator('.session-nav-item').filter({ hasText: 'Controller boot' });
    await expect(row.locator('.session-nav-item-model')).toHaveText('Sonnet 4.6', {
      timeout: 10_000,
    });
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-6' } }) + '\n',
    );
    await expect(row.locator('.session-nav-item-model')).toHaveText('Opus 4.6', {
      timeout: 10_000,
    });
    const stored = JSON.parse(
      fs.readFileSync(path.join(`${userDataDir} Test`, 'workspaces.json'), 'utf8'),
    );
    expect(
      stored.workspaces[0].sessions.find((session: { id: string }) => session.id === 's1').model,
    ).toBe('claude-opus-4-6');
  });

  test('scope selection filters the list, and Clear filters brings every scope back', async () => {
    // All scopes by default: every session, each naming the scope it runs in.
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
    await expect(rowFor(page, 'Bump deps').locator('.session-nav-item-scope')).toContainText(
      'shared-lib',
    );
    await chooseScope(page, 'shared-lib');
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(1);
    await expect(topList(page)).toContainText('Bump deps');
    // A filtered list says its scope once, in the filter bar, never per row.
    await expect(page.locator('.session-nav-item-scope')).toHaveCount(0);
    await chooseScope(page, 'catalog-portal');
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(3);
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Manage scopes…' }).click();
    await expect(
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Scopes', exact: true }),
    ).toHaveAttribute('aria-current', 'true');
  });

  test('a label filter and a scope narrow together, and one Clear filters resets both', async () => {
    // "Fan out" was a group before the v8 migration; its members now carry it as a label.
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await page.getByRole('menuitem', { name: /Fan out/ }).click();
    await page.keyboard.press('Escape');
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(1);
    await expect(topList(page)).toContainText('Fan member');
    await chooseScope(page, 'shared-lib');
    await expect(page.locator('.session-nav-item')).toHaveCount(0);
    await expect(page.getByText('No sessions match these filters.')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
    await expect(page.locator('.sidebar-scope-filter')).toContainText('All scopes');
    await expect(page.locator('.sidebar-filter-chips')).toHaveCount(0);
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
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
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
  });

  test('the scope row sits under Automations on Home only, never in the title bar', async () => {
    await expect(
      page.locator('.app-header').getByRole('button', { name: 'Filter sessions' }),
    ).toHaveCount(0);
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
    workspace.scopes = workspace.scopes.filter(
      (candidate: { id: string }) => candidate.id === 'scope-app',
    );
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

  test("a conductor's children sit inside its tree, indented past it, never level with the list", async () => {
    await app.close();
    const file = path.join(`${userDataDir} Test`, 'workspaces.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sessions: Array<{ id: string; kind: string; parentSessionId?: string }> =
      data.workspaces[0].sessions;
    sessions.find((candidate) => candidate.id === 's1')!.kind = 'conductor';
    sessions.find((candidate) => candidate.id === 's2')!.parentSessionId = 's1';
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);

    const tree = topList(page).locator('.tree-row');
    await expect(tree).toHaveCount(1);
    await expect(tree.locator('.tree-row-children')).toContainText('Fix flaky test');
    const boxOf = async (name: string, selector: string) => {
      const box = await rowFor(page, name).first().locator(selector).first().boundingBox();
      if (!box) throw new Error(`${name} has no ${selector}`);
      return box;
    };
    const nameOf = (name: string) => boxOf(name, '.session-nav-item-name');
    const [root, conductor, child] = await Promise.all([
      nameOf('Bump deps'),
      nameOf('Controller boot'),
      nameOf('Fix flaky test'),
    ]);
    // Each level one step further in. A child level with the list, or left of
    // its own conductor, reads as a row of the list rather than of the tree.
    expect(conductor.x).toBeGreaterThan(root.x);
    expect(child.x).toBeGreaterThan(conductor.x);
    // The child's row, hover and active background included, starts where its
    // conductor's does rather than out at the list's edge.
    const conductorRow = await rowFor(page, 'Controller boot').first().boundingBox();
    const childRow = await rowFor(page, 'Fix flaky test').first().boundingBox();
    expect(childRow!.x).toBeGreaterThanOrEqual(conductorRow!.x);
  });

  test('session options share the selected scope without creating a session early', async () => {
    await chooseScope(page, 'shared-lib');
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN',
    );
    await expect(
      page.getByLabel('Scope', { exact: true }).locator('.session-option-name'),
    ).toHaveText('shared-lib');
    await expect(page.getByLabel('Group', { exact: true })).toContainText('Ungrouped');
    const count = () =>
      page.evaluate(
        async () => (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions.length,
      );
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
    await page.screenshot({
      path: 'test-results/home-sidebar-all-light.png',
      animations: 'disabled',
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.radix-themes')).toHaveClass(/dark/);
    await page.screenshot({
      path: 'test-results/home-sidebar-all-dark.png',
      animations: 'disabled',
    });
  });

  test('the pane names the scope the open session runs in', async () => {
    await rowFor(page, 'Bump deps').click();
    const title = page.locator('.workspace-view-header .workspace-view-title');
    await expect(title).toHaveText(/^shared-lib\s*\/\s*Bump deps$/);
    // Production's breadcrumb: the scope in primary text, never dimmed.
    const colors = await title.evaluate((element) => ({
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
    expect(
      await header.evaluate((element) =>
        getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      ),
    ).toBe('drag');
  });

  test('renaming a row that names its scope replaces the whole text column', async () => {
    const row = rowFor(page, 'Fix flaky test');
    await expect(row.locator('.session-nav-item-scope')).toContainText('catalog-portal');

    await row.hover();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();

    // Anchored on the field, not on the name: `rowFor` matches by text, and the
    // name becomes an input VALUE the moment renaming starts, so the row
    // locator stops matching its own row.
    const renaming = page
      .locator('.session-nav-item')
      .filter({ has: page.locator('.session-rename-input') });

    // The field takes the column whole: the meta line it replaces must not
    // survive beside it, or the row reads as two rows while it is being typed.
    // This replaces an older assertion that measured the status dot against the
    // field. That measurement guarded per-glyph margin arithmetic which no
    // longer exists — the dot now sits in a fixed gutter — and it could not run
    // at all on a calm row, which draws no dot by design.
    await expect(renaming.locator('.session-rename-input')).toBeVisible();
    await expect(renaming.locator('.session-nav-item-scope')).toHaveCount(0);
    await expect(renaming.locator('.session-nav-item-name')).toHaveCount(0);
  });

  test('with nothing running there is no Working section at all', async () => {
    // Every seeded session is ready: an empty Working shelf would be a header
    // with nothing behind it, so the sidebar leaves it out. (The section that
    // appears when something runs is covered under 'the Working section'.)
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
    await expect(page.getByRole('region', { name: 'Working', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Working/ })).toHaveCount(0);
  });

  test('the Settled section starts folded and empty, pinned below the list', async () => {
    const header = page.getByRole('button', { name: /^Settled/ });
    // It holds only what was put away, and nothing has been yet: stopping is
    // not settling, so every seeded row stays at the top.
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(header.locator('.shelf-header-count')).toHaveText('0');
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
    // Outside the scrolling list, so it stays at the bottom however long that runs.
    await expect(page.locator('.sidebar-sessions .sidebar-bucket--settled')).toHaveCount(0);

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  test('a Settled shelf too long for the dock scrolls one-line rows instead of squeezing them', async () => {
    // Settle everything, then make the window short enough that the dock's
    // cap is smaller than the shelf.
    await page.evaluate(async () => {
      for (const id of ['s1', 's2', 's3', 's4'])
        await window.attentionAPI.settle('ws-folding-e2e', id);
    });
    const header = page.getByRole('button', { name: /^Settled/ });
    await expect(header.locator('.shelf-header-count')).toHaveText('4');
    await header.click();
    await page.setViewportSize({ width: 900, height: 300 });
    // The top of the list says there is nothing waiting rather than going blank.
    await expect(page.locator('.sidebar-all-clear')).toHaveText('Nothing is waiting on you.');

    const rows = page
      .getByRole('navigation', { name: 'Settled sessions' })
      .locator('.session-nav-item');
    await expect(rows).toHaveCount(4);
    const boxes = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          content: element.scrollHeight,
        };
      }),
    );
    for (const [index, box] of boxes.entries()) {
      // Every row is as tall as what it says, and one line of it: a put-away
      // row is its name and its age. Half a pixel of slack, as below: a row at
      // a fractional offset can measure a float's rounding under its height.
      expect(box.height).toBeGreaterThanOrEqual(box.content - 0.5);
      expect(box.height).toBeLessThan(36);
      // No row is painted over the one before it.
      if (index > 0) expect(box.top).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 0.5);
    }
    // The shelf scrolls instead.
    const list = page.getByRole('navigation', { name: 'Settled sessions' });
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await expect(rows.locator('.session-nav-item-harness, .session-nav-item-model')).toHaveCount(0);
  });

  test('archiving a group never hides its sessions', async () => {
    await page.evaluate(() => window.workspaceAPI.archiveGroup('ws-folding-e2e', 'group-fanout'));
    // Groups are not a place any more: the member stays among the others.
    await expect(rowFor(page, 'Fan member')).toHaveCount(1);
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
  });

  test("the actions menu's New label… creates a label and gives it to the session in one step", async () => {
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
      return {
        labels: workspace.labels.map((label) => ({ id: label.id, name: label.name })),
        groups: workspace.groups.length,
      };
    });
    expect(snapshot.labels.map((label) => label.name)).toEqual(['Fan out', 'PR reviews']);
    await expect.poll(() => labelsOf(page, 's1')).toEqual([snapshot.labels[1].id]);
    // A label, not a group: nothing is written that no screen could show.
    expect(snapshot.groups).toBe(1);
  });

  test('deleting a label from the filter bar says so and can be undone, labels and all', async () => {
    // The seeded group arrived as a label; give it to a session so the delete
    // has something to take away besides the label itself.
    await openLabelsMenu(page, 'Controller boot');
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();
    await expect.poll(() => labelsOf(page, 's1')).toEqual(['group-fanout']);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await page.getByRole('button', { name: 'Delete label Fan out', exact: true }).click();

    // A × in a filtering menu that deletes user-authored organisation says
    // what it did and offers the way back, rather than asking first.
    const toast = page.getByRole('status').filter({ hasText: 'Deleted label Fan out' });
    await expect(toast).toBeVisible();
    // Gone from the session as well as from the list: deleting a label is one
    // commit over every session carrying it.
    await expect.poll(() => labelsOf(page, 's1')).toBeUndefined();

    await toast.getByRole('button', { name: 'Undo', exact: true }).click();

    await expect.poll(() => labelsOf(page, 's1')).toEqual(['group-fanout']);
    await expect(toast).toHaveCount(0);
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Delete label Fan out', exact: true }),
    ).toBeVisible();
  });

  test('the actions menu ticks and unticks a label on a session', async () => {
    expect(await labelsOf(page, 's1')).toBeUndefined();

    await openLabelsMenu(page, 'Controller boot');
    await page.getByRole('menuitem', { name: 'Fan out', exact: true }).click();
    await expect.poll(() => labelsOf(page, 's1')).toEqual(['group-fanout']);
    // A label is a tag, not a place: the row has not moved anywhere.
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);

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
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
  });

  test('the row settles from hover and back; deleting stays in the menu and confirms', async () => {
    test.setTimeout(60_000);
    const settledHeader = page.getByRole('button', { name: /^Settled/ });
    const row = rowFor(page, 'Controller boot');
    const settle = row.getByRole('button', { name: 'Settle session Controller boot', exact: true });
    const confirmation =
      'Delete session "Controller boot"? This will remove the session and its chat history.';

    // The row's one-click slot is the reversible move; destroying a session and
    // its history is behind the row's right-click menu, where a mis-aimed click
    // cannot reach it — and then behind a question, which Cancel answers.
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const asked = page.getByRole('dialog', { name: 'Delete session' });
    await expect(asked).toContainText(confirmation);
    await asked.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(asked).toBeHidden();
    await expect(row).toHaveCount(1);

    // Settling acts in place and must not activate the row it acts on. No row
    // is open here; settling the row the window is showing is covered at the
    // end of this test.
    const quiet = rowFor(page, 'Fix flaky test');
    const settleQuiet = quiet.getByRole('button', {
      name: 'Settle session Fix flaky test',
      exact: true,
    });
    const activeBefore = await page.locator('.session-nav-item.active').allTextContents();
    const shelf = page.getByRole('navigation', { name: 'Settled sessions' });
    // Nothing is put away yet, so the shelf is empty and every row is at the top.
    await expect(settledHeader).toHaveText(/0/);
    await quiet.hover();
    await expect(settleQuiet).toBeVisible();
    await settleQuiet.click();
    // Settling moves the row out of the list and onto the shelf, folded by default.
    await expect(settledHeader).toHaveText(/1/);
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(3);
    await expect(topList(page)).not.toContainText('Fix flaky test');
    expect(await page.locator('.session-nav-item.active').allTextContents()).toEqual(activeBefore);

    // The same slot offers the way back, so nothing is settled irreversibly by
    // a stray click.
    await settledHeader.click();
    const shelved = shelf.locator('.session-nav-item').filter({ hasText: 'Fix flaky test' });
    // A put-away row says what it was, not how it ran: no harness glyph on the
    // shelf, while the rows still in play keep theirs.
    await expect(shelved.locator('.session-nav-item-harness')).toHaveCount(0);
    await expect(topList(page).locator('.session-nav-item-harness')).toHaveCount(3);
    await shelved.hover();
    await shelved
      .getByRole('button', { name: 'Move Fix flaky test back to the list', exact: true })
      .click();
    await expect(settledHeader).toHaveText(/0/);
    await expect(shelf.locator('.session-nav-item')).toHaveCount(0);
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);

    // Tab order: the row, then its one action. The actions menu has no button
    // to tab to; the keyboard opens it from the row, the way it opens any
    // context menu, and closing it hands focus back to that row.
    await row.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(settle).toBeFocused();

    // A right-click does not take focus, and closing its menu hands focus
    // back to whatever had it, so the row is not left wearing the keyboard
    // ring with its Settle pill held open over its age.
    const elsewhere = page.getByRole('button', { name: 'Navigation settings', exact: true });
    await elsewhere.focus();
    await row.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(elsewhere).toBeFocused();
    expect(
      await row.evaluate((element) => element.matches(':focus-visible, :has(:focus-visible)')),
    ).toBe(false);

    // The row the window is showing is offered Settle like any other, and goes
    // under the fold like any other: a folded shelf does not show it as though
    // it had opened itself. It stays put away, since opening a session is not
    // a turn, so nothing brings it back until the person prompts it.
    await settledHeader.click();
    await expect(settledHeader).toHaveAttribute('aria-expanded', 'false');
    await quiet.click();
    await quiet.hover();
    await expect(settleQuiet).toBeVisible();
    await settleQuiet.click();
    await expect(settledHeader).toHaveText(/1/);
    await expect(topList(page)).not.toContainText('Fix flaky test');
    await expect(shelf.locator('.session-nav-item')).toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(settledHeader).toHaveText(/1/);
    await settledHeader.click();
    await expect(shelved).toHaveCount(1);
    await shelved.hover();
    await shelved
      .getByRole('button', { name: 'Move Fix flaky test back to the list', exact: true })
      .click();
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);

    await row.hover();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete session' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('.session-nav-item')).toHaveCount(3);
  });

  test('a settled row slides into the dock and leaves nothing behind; under reduced motion it simply moves', async () => {
    const settledHeader = page.getByRole('button', { name: /^Settled/ });
    /** Records whether a copy of a row was seen on its way into the folded shelf. */
    const watchForTravel = () =>
      page.evaluate(() => {
        (window as any).__travelled = false;
        new MutationObserver((_, observer) => {
          if (!document.querySelector('.sidebar-ghost')) return;
          (window as any).__travelled = true;
          observer.disconnect();
        }).observe(document.body, { subtree: true, childList: true });
      });
    const travelled = () => page.evaluate(() => (window as any).__travelled as boolean);
    const settle = (id: string) =>
      page.evaluate((sessionId) => window.attentionAPI.settle('ws-folding-e2e', sessionId), id);

    // Settled starts folded, so the row has no slot to land in: a copy of it
    // slides under the dock's edge, and is gone once it has.
    await watchForTravel();
    await settle('s2');
    await expect(settledHeader).toHaveText(/1/);
    await expect.poll(travelled).toBe(true);
    await expect(page.locator('.sidebar-ghost-clip')).toHaveCount(0);
    await expect(page.locator('[data-travelling], [data-landed], [data-travel-open]')).toHaveCount(
      0,
    );

    // Reduced motion keeps the move and drops the travel.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await watchForTravel();
    await settle('s3');
    await expect(settledHeader).toHaveText(/2/);
    await page.waitForTimeout(500);
    expect(await travelled()).toBe(false);
  });

  test('a shelf choice survives a relaunch', async () => {
    test.setTimeout(60_000);
    const settledHeader = (target: Page) => target.getByRole('button', { name: /^Settled/ });
    await settledHeader(page).click();
    await expect(settledHeader(page)).toHaveAttribute('aria-expanded', 'true');
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await expect(settledHeader(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(topList(page).locator('.session-nav-item')).toHaveCount(4);
  });
});

/**
 * A stand-in for the CLI that sits at its prompt until it gets Enter, then
 * prints a line every tenth of a second for a minute: a turn the test starts
 * when it chooses, long enough to read as working. Any launch that is not an
 * interactive session (a version or capabilities probe) exits at once rather
 * than streaming.
 */
const TURN_STUB = `#!/bin/sh
case " $* " in *" --session-id "*|*" --resume "*) ;; *) exit 0 ;; esac
printf 'Stub ready\\r\\n> '
IFS= read -r _ || exit 0
i=0
while [ "$i" -lt 600 ]; do printf 'step %s\\r\\n' "$i"; i=$((i + 1)); sleep 0.1; done
exec sleep 300
`;

/**
 * Like TURN_STUB, but each turn ends: two and a half seconds of output on
 * every Enter, then the prompt again.
 */
const FINISHING_STUB = `#!/bin/sh
case " $* " in *" --session-id "*|*" --resume "*) ;; *) exit 0 ;; esac
printf 'Stub ready\\r\\n> '
while IFS= read -r _; do
  i=0
  while [ "$i" -lt 25 ]; do printf 'step %s\\r\\n' "$i"; i=$((i + 1)); sleep 0.1; done
  printf '> '
done
exec sleep 300
`;

test.describe('the Working section', () => {
  let root: string;

  /**
   * A workspace whose sessions run `script`, made in the order given, so the
   * last is the newest. Returns once the workspace is on screen.
   */
  async function sessionsRunning(script: string, sessions: [name: string, instanceId: string][]) {
    const stub = path.join(root, 'agent.sh');
    fs.writeFileSync(stub, script, { mode: 0o755 });
    await page.evaluate(
      async ({ root, stub, sessions }) => {
        await window.harnessStateAPI.addHarness({
          id: 'turn-stub',
          driverId: 'claude',
          name: 'Stub',
          binaryPath: stub,
          accentColor: '#555555',
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Working test',
          root,
          false,
          'turn-stub',
        );
        for (const [name, instanceId] of sessions) {
          await window.workspaceAPI.createSession(workspace.id, {
            name,
            nameIsUserSet: true,
            workspaceId: workspace.id,
            instanceId,
            harnessId: 'turn-stub',
            scopeId: workspace.scopes[0].id,
          });
          // Distinct creation times, so the newest is unambiguous.
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
      { root, stub, sessions },
    );
    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Working test/ })
      .click();
  }

  /** The names at the top of the list, in order. */
  const topOfList = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.sidebar-bucket--waiting .session-list > [data-entry-key] .session-nav-item-name',
        ),
      ].map((name) => name.textContent),
    );

  const statusOf = (instanceId: string) =>
    page.evaluate(async (id) => {
      const status = (await window.terminalAPI.getStatusSnapshot())[id];
      if (!status) return 'none';
      if (status.hasExited) return 'exited';
      return status.isBusy ? 'working' : 'ready';
    }, instanceId);

  /** Open a row and wait for main to have its terminal, so input has somewhere to go. */
  async function open(name: string, instanceId: string) {
    await page
      .getByRole('complementary', { name: 'Home sidebar' })
      .locator('.session-nav-item')
      .filter({ hasText: name })
      .click();
    await expect.poll(() => statusOf(instanceId)).not.toBe('none');
  }

  const startTurn = (instanceId: string) =>
    page.evaluate((id) => window.terminalAPI.sendInput(id, '\r'), instanceId);

  test('a session that stops waits a moment in Working, then comes back to the top of the list', async () => {
    test.setTimeout(90_000);
    await sessionsRunning(FINISHING_STUB, [
      ['Session A', 'finish-a'],
      ['Session B', 'finish-b'],
      ['Session C', 'finish-c'],
    ]);
    const working = page.getByRole('region', { name: 'Working', exact: true });
    const inWorking = working.locator('.session-nav-item').filter({ hasText: 'Session A' });

    // Newest first: A, made first, is at the bottom.
    await expect.poll(topOfList).toEqual(['Session C', 'Session B', 'Session A']);
    await open('Session A', 'finish-a');
    await startTurn('finish-a');
    await expect(inWorking).toBeVisible({ timeout: 15_000 });
    await expect.poll(topOfList).toEqual(['Session C', 'Session B']);

    // The turn ends. The row stays in Working for a moment rather than
    // leaving the instant the output stops...
    await expect
      .poll(() => statusOf('finish-a'), { timeout: 15_000, intervals: [50] })
      .toBe('ready');
    const stoppedAt = Date.now();
    await page.waitForTimeout(500);
    await expect(inWorking).toBeVisible();
    // ...then comes back above everything that has been sitting there.
    await expect
      .poll(topOfList, { timeout: 10_000, intervals: [50] })
      .toEqual(['Session A', 'Session C', 'Session B']);
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(1_000);
    await expect(working).toHaveCount(0);
  });

  test('without a Working section, a running session keeps its place in the list', async () => {
    test.setTimeout(90_000);
    await sessionsRunning(FINISHING_STUB, [
      ['Session A', 'still-a'],
      ['Session B', 'still-b'],
      ['Session C', 'still-c'],
    ]);
    await page.getByRole('button', { name: 'Navigation settings' }).click();
    const toggle = page.getByRole('menuitemcheckbox', { name: 'Working section' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    const order = ['Session C', 'Session B', 'Session A'];
    await expect.poll(topOfList).toEqual(order);
    await open('Session B', 'still-b');
    await startTurn('still-b');
    await expect.poll(() => statusOf('still-b'), { timeout: 15_000 }).toBe('working');
    await expect(page.getByRole('region', { name: 'Working', exact: true })).toHaveCount(0);
    expect(await topOfList()).toEqual(order);

    await expect.poll(() => statusOf('still-b'), { timeout: 15_000 }).toBe('ready');
    await page.waitForTimeout(2_500);
    expect(await topOfList()).toEqual(order);
  });

  test('a click on a row the list just slid under the pointer is dropped, and one a moment later opens it', async () => {
    test.setTimeout(90_000);
    await sessionsRunning(TURN_STUB, [
      ['Session A', 'slide-a'],
      ['Session B', 'slide-b'],
    ]);
    await expect.poll(topOfList).toEqual(['Session B', 'Session A']);
    await open('Session B', 'slide-b');

    // B leaving for Working slides A up into B's place. A press landing on A
    // in that instant was aimed at B: it must not open A. Pressed from the
    // page, in the same task the list moved, so no clock can make it late.
    const opened = await page.evaluate(
      (id) =>
        new Promise<boolean>((resolve) => {
          const list = document.querySelector('.sidebar-sessions')!;
          const observer = new MutationObserver(() => {
            const first = list.querySelector<HTMLElement>(
              '.sidebar-bucket--waiting .session-list > [data-entry-key]',
            );
            if (!first?.textContent?.includes('Session A')) return;
            observer.disconnect();
            const at = first.getBoundingClientRect();
            const point = { bubbles: true, cancelable: true, clientX: at.x + 8, clientY: at.y + 8 };
            first.dispatchEvent(new PointerEvent('pointerdown', { ...point, pointerId: 1 }));
            first.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerId: 1 }));
            first.dispatchEvent(new PointerEvent('click', { ...point, pointerId: 1, detail: 1 }));
            setTimeout(() => resolve(first.classList.contains('active')), 200);
          });
          observer.observe(list, { childList: true, subtree: true });
          window.terminalAPI.sendInput(id, '\r');
        }),
      'slide-b',
    );
    expect(opened).toBe(false);

    await page.waitForTimeout(600);
    const rowA = page
      .locator('.sidebar-bucket--waiting .session-nav-item')
      .filter({ hasText: 'Session A' });
    await rowA.click();
    await expect(rowA).toHaveClass(/\bactive\b/);
  });

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-working-'));
    ({ app, page, userDataDir } = await launchElectron());
  });

  test.afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('appears right above Settled when a session starts working, and brings back a hidden sidebar with every running session in view', async () => {
    test.setTimeout(90_000);
    const stub = path.join(root, 'agent.sh');
    fs.writeFileSync(stub, TURN_STUB, { mode: 0o755 });
    await page.evaluate(
      async ({ root, stub }) => {
        await window.harnessStateAPI.addHarness({
          id: 'turn-stub',
          driverId: 'claude',
          name: 'Stub',
          binaryPath: stub,
          accentColor: '#555555',
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Working test',
          root,
          false,
          'turn-stub',
        );
        for (const [name, instanceId] of [
          ['Session A', 'turn-a'],
          ['Session B', 'turn-b'],
        ]) {
          await window.workspaceAPI.createSession(workspace.id, {
            name,
            nameIsUserSet: true,
            workspaceId: workspace.id,
            instanceId,
            harnessId: 'turn-stub',
            scopeId: workspace.scopes[0].id,
          });
        }
      },
      { root, stub },
    );
    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Working test/ })
      .click();

    const sidebar = page.getByRole('complementary', { name: 'Home sidebar' });
    const working = page.getByRole('region', { name: 'Working', exact: true });
    const workingHeader = working.getByRole('button', { name: /^Working/ });
    const rowIn = (where: Locator, name: string) =>
      where.locator('.session-nav-item').filter({ hasText: name });
    /** Open a row and wait for main to have its terminal, so input has somewhere to go. */
    const open = async (name: string, instanceId: string) => {
      await rowIn(sidebar, name).click();
      await expect
        .poll(() =>
          page.evaluate(
            async (id) => id in (await window.terminalAPI.getStatusSnapshot()),
            instanceId,
          ),
        )
        .toBe(true);
    };
    const startTurn = (instanceId: string) =>
      page.evaluate((id) => window.terminalAPI.sendInput(id, '\r'), instanceId);

    // Nothing is running yet, so there is no Working section to show.
    await expect(rowIn(page.locator('.sidebar-bucket--waiting'), 'Session A')).toBeVisible();
    await expect(working).toHaveCount(0);

    // A starts a turn. Working appears, already open though it starts folded,
    // pinned below the scrolling list and directly above Settled.
    await open('Session A', 'turn-a');
    await expect(working).toHaveCount(0);
    await startTurn('turn-a');
    await expect(rowIn(working, 'Session A')).toBeVisible({ timeout: 15_000 });
    await expect(workingHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.sidebar-sessions .sidebar-bucket--working')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('.sidebar-dock > section')].map((section) =>
            section.getAttribute('aria-label'),
          ),
        ),
      )
      .toEqual(['Working', 'Settled']);
    const panelBox = (await page.locator('.sidebar-sessions').boundingBox())!;
    const workingBox = (await working.boundingBox())!;
    const settledBox = (await page
      .getByRole('region', { name: 'Settled', exact: true })
      .boundingBox())!;
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(workingBox.y);
    expect(workingBox.y + workingBox.height).toBeLessThanOrEqual(settledBox.y);

    // The chord folds it. Folded, it keeps only the open session, so once B
    // is opened A runs on behind the fold and only the count says so.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+Shift+KeyB' : 'Control+Shift+KeyB',
    );
    await expect(workingHeader).toHaveAttribute('aria-expanded', 'false');
    await open('Session B', 'turn-b');
    await expect(rowIn(working, 'Session A')).toHaveCount(0);
    await expect(workingHeader.locator('.shelf-header-count')).toHaveText('1');

    // With the sidebar hidden, B starting a turn brings it back with Working
    // open, so A is in view again beside B.
    await page.locator('.sidebar-toggle').click();
    await expect(sidebar).toHaveCount(0);
    await startTurn('turn-b');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    await expect(workingHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(rowIn(working, 'Session A')).toBeVisible();
    await expect(rowIn(working, 'Session B')).toBeVisible();
    await expect(workingHeader.locator('.shelf-header-count')).toHaveText('2');
  });
});
