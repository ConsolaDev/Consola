import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';

/**
 * Which checkout a session runs in: the header names it beside the session,
 * the sidebar marks worktree rows, and git status reads the worktree itself.
 */

const WORKSPACE_NAME = 'Sprocket';
const WORKTREE_BRANCH = 'feature/login-redirect';

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let base: string;
let repo: string;
let tree: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function seed(): void {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-checkout-e2e-')));
  repo = path.join(base, 'catalog-portal');
  tree = path.join(base, 'worktrees', 'catalog-portal-session-1a2b3c4d');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# catalog-portal\n');
  git(repo, 'add', 'README.md');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial');
  git(repo, 'worktree', 'add', '-q', '-b', WORKTREE_BRANCH, tree);
  // Uncommitted work exists only in the worktree, so a header reading the
  // main checkout instead would show none.
  fs.writeFileSync(path.join(tree, 'README.md'), '# catalog-portal\n\nLogin now redirects.\n');

  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const profile = path.join(base, 'claude-profile');
  const builtIn = { ...createBuiltInHarness(), configDir: profile };
  // Stands in for Claude entering a worktree on its own (EnterWorktree): it
  // starts in the repo, then moves, and records each place where Claude
  // records it — `<config>/sessions/<pid>.json`, kept by the process itself.
  // \342\235\257 is UTF-8 for ❯, an empty composer.
  const stubPath = path.join(base, 'enters-worktree.sh');
  fs.writeFileSync(stubPath, [
    '#!/bin/sh',
    'mkdir -p "$CLAUDE_CONFIG_DIR/sessions"',
    'record="$CLAUDE_CONFIG_DIR/sessions/$$.json"',
    `printf '{"pid":%s,"cwd":"%s"}' "$$" '${repo}' > "$record"`,
    "printf '\\342\\235\\257 '",
    'sleep 4',
    `printf '{"pid":%s,"cwd":"%s"}' "$$" '${tree}' > "$record"`,
    "printf 'Entered the worktree\\r\\n\\342\\235\\257 '",
    'sleep 300',
    '',
  ].join('\n'), { mode: 0o755 });
  const stub = { ...createBuiltInHarness(), id: 'stub', name: 'Stub', isBuiltIn: false, binaryPath: stubPath, configDir: profile };
  fs.writeFileSync(path.join(effective, 'harnesses.json'), JSON.stringify({ version: 1, harnesses: [builtIn, stub] }));
  const session = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    workspaceId: 'ws-worktree-e2e',
    instanceId: `inst-${id}`,
    claudeSessionId: `claude-${id}`,
    hasStarted: false,
    harnessId: 'default',
    scopeId: 'scope-app',
    kind: 'interactive',
    createdAt: now,
    lastActiveAt: now,
    ...extra,
  });
  fs.writeFileSync(path.join(effective, 'workspaces.json'), JSON.stringify({
    version: 7,
    workspaces: [{
      id: 'ws-worktree-e2e',
      name: WORKSPACE_NAME,
      defaultHarnessId: 'default',
      scopes: [{ id: 'scope-app', name: 'catalog-portal', path: repo, isGitRepo: true, createdAt: now }],
      groups: [],
      actions: [],
      sectionDefaults: {},
      sessions: [
        session('s-main', 'Tidy the README'),
        session('s-tree', 'Fix the login redirect', { cwd: tree, model: 'claude-opus-4-6' }),
        session('s-enters', 'Plan the redirect fix', { harnessId: 'stub' }),
      ],
      createdAt: now,
      updatedAt: now,
    }],
  }), 'utf8');
}

async function holdWorkspace(target: Page): Promise<void> {
  const button = target.getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
}

const row = (target: Page, name: string) => target.locator('.session-nav-item').filter({ hasText: name });
const chip = (target: Page) => target.locator('.workspace-view-header .checkout-chip');
const screenshot = (name: string) => page.screenshot({ path: `tests/e2e/screenshots/${name}` });

test.describe('worktree visibility', () => {
  test.beforeEach(async () => {
    userDataDir = createProfileDir();
    seed();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
  });

  test.afterEach(async () => {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('the header says which checkout a session runs in, and git status reads that checkout', async () => {
    test.setTimeout(60_000);
    await row(page, 'Fix the login redirect').click();
    await expect(chip(page)).toHaveAttribute('data-kind', 'worktree');
    await expect(chip(page)).toContainText('Worktree');
    await expect(chip(page)).toContainText(WORKTREE_BRANCH);
    await expect(page.locator('.git-stats-count')).toHaveText('1 file');
    await screenshot('worktree-header.png');

    await chip(page).hover();
    const tooltip = page.locator('.checkout-tooltip');
    // The three things people mix up, each labelled: the branch, the
    // worktree's own (generated) folder, and the main checkout it belongs to.
    // Child combinators: Radix also renders a visually hidden copy of the
    // content for screen readers, which a descendant query would count twice.
    const facts = page.locator('.checkout-tooltip > .checkout-tooltip-facts');
    await expect(tooltip.first()).toContainText('Worktree');
    await expect(facts.locator('> dt')).toHaveText(['Branch', 'Folder', 'Main checkout']);
    await expect(facts.locator('> dd').nth(0)).toContainText(WORKTREE_BRANCH);
    await expect(facts.locator('> dd').nth(1)).toContainText(tree);
    await expect(facts.locator('> dd').nth(2)).toContainText(repo);
    await screenshot('worktree-tooltip.png');
    await page.mouse.move(0, 0);

    await row(page, 'Tidy the README').click();
    await expect(chip(page)).toHaveAttribute('data-kind', 'main');
    await expect(chip(page)).toHaveText('main');
    await expect(page.locator('.git-stats-count')).toHaveCount(0);
    await screenshot('worktree-main-checkout.png');
  });

  test('everything git-shaped follows an agent that moves itself into a worktree', async () => {
    test.setTimeout(60_000);
    await row(page, 'Plan the redirect fix').click();
    // Launched in the repo, and still there until the CLI says otherwise.
    await expect(chip(page)).toHaveAttribute('data-kind', 'main');
    await expect(page.locator('.git-stats-count')).toHaveCount(0);

    await expect(chip(page)).toHaveAttribute('data-kind', 'worktree', { timeout: 15_000 });
    await expect(chip(page)).toContainText(WORKTREE_BRANCH);
    await expect(page.locator('.git-stats-count')).toHaveText('1 file');
    await expect(row(page, 'Plan the redirect fix').locator('.session-nav-item-worktree')).toHaveText(WORKTREE_BRANCH);
    await screenshot('worktree-entered-by-agent.png');

    // Main recorded it, so it outlives this window's view of the session.
    const recorded = JSON.parse(fs.readFileSync(path.join(`${userDataDir} Test`, 'workspaces.json'), 'utf8'));
    const enters = recorded.workspaces[0].sessions.find((s: { id: string }) => s.id === 's-enters');
    expect(enters.agentCwd).toBe(tree);
    expect(enters).not.toHaveProperty('cwd');
  });

  test('the sidebar marks worktree rows, and the mark can be switched off for good', async () => {
    test.setTimeout(60_000);
    const worktreeLine = (name: string) => row(page, name).locator('.session-nav-item-worktree');
    await expect(worktreeLine('Fix the login redirect')).toHaveText(WORKTREE_BRANCH);
    await expect(worktreeLine('Tidy the README')).toHaveCount(0);
    // The model stays whole beside or under the branch, never cut to a stub.
    await expect(row(page, 'Fix the login redirect').locator('.session-nav-item-meta .session-nav-item-model'))
      .toHaveText('claude-opus-4-6');
    await screenshot('worktree-sidebar-rows.png');

    await page.getByRole('button', { name: 'Navigation settings', exact: true }).click();
    const toggle = page.getByRole('menuitemcheckbox', { name: 'Worktree', exact: true });
    await expect(toggle).toBeChecked();
    await page.waitForTimeout(300); // let the menu finish fading in
    await screenshot('worktree-navigation-settings.png');
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('.session-nav-item-worktree')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await holdWorkspace(page);
    await expect(row(page, 'Fix the login redirect')).toBeVisible();
    await expect(page.locator('.session-nav-item-worktree')).toHaveCount(0);
    await page.getByRole('button', { name: 'Navigation settings', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Worktree', exact: true }).click();
    await expect(worktreeLine('Fix the login redirect')).toHaveText(WORKTREE_BRANCH);
  });
});
