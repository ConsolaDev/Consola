import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from './helpers/electron';

test('session options create and reuse worktrees, with searchable refs and recoverable errors', async () => {
  test.setTimeout(90_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-composer-')));
  const repo = path.join(root, 'console-1');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  git('branch', 'feature/resizable-sidebar');
  const existing = path.join(root, 'existing checkout');
  git('worktree', 'add', '-b', 'feature/inbox', existing);
  const profile = path.join(root, 'codex');
  fs.mkdirSync(profile);
  const { app, page, userDataDir } = await launchElectron({ env: { CONSOLA_WORKTREES_DIR: path.join(root, 'worktrees') } });
  try {
    await page.evaluate(async ({ repo, profile, binary }) => {
      await window.harnessStateAPI.addHarness({ id: 'fixture', name: 'Development agent', driverId: 'codex', accentColor: '#da9775', binaryPath: binary, configDir: profile });
      await window.workspaceAPI.createWorkspace('console-1', repo, true, 'fixture');
    }, { repo, profile, binary: path.resolve('tests/fixtures/codex.cjs') });
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /console-1/ }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN');
    await expect(page.getByRole('dialog', { name: 'New session with options' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create session' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Choose branch or worktree' })).toContainText('main');
    await page.screenshot({ path: 'test-results/new-conversation.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Choose branch or worktree' }).click();
    await page.getByRole('textbox', { name: 'Search branches and worktrees' }).fill('no-such-branch');
    await expect(page.getByText('No matching branches or worktrees.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Search branches and worktrees' }).fill('');
    await page.screenshot({ path: 'test-results/new-conversation-branches.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Checkout mode' }).click();
    await page.getByRole('menuitem', { name: /New worktree/ }).click();
    await page.getByLabel('New branch', { exact: true }).fill('main');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByRole('alert')).toContainText('already exists');
    await expect(page.getByLabel('New branch', { exact: true })).toHaveValue('main');
    await page.getByLabel('New branch', { exact: true }).fill('feature/composer');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByRole('dialog', { name: 'New session with options' })).toHaveCount(0);
    const first = await page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces.find(ws => ws.name === 'console-1')!.sessions[0]);
    expect(first.cwd).toContain('/worktrees/');
    expect(execFileSync('git', ['-C', first.cwd!, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('feature/composer');
    expect(git('branch', '--show-current')).toBe('main');

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: /New session with options/ }).click();
    await page.getByRole('button', { name: 'Checkout mode' }).click();
    await page.getByRole('menuitem', { name: /Existing worktree/ }).click();
    await page.getByRole('textbox', { name: 'Search branches and worktrees' }).fill('feature/inbox');
    await page.getByRole('button', { name: /feature\/inbox.*worktree/ }).click();
    await expect(page.getByRole('button', { name: 'Checkout mode' })).toContainText('Existing worktree');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByRole('dialog', { name: 'New session with options' })).toHaveCount(0);
    const sessions = await page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces.find(ws => ws.name === 'console-1')!.sessions);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].cwd).toBe(existing);

    // Group creation must persist the scope selected in Home, including when
    // the last active conversation ran in a different scope and worktree.
    const destination = await page.evaluate(async ({ folder }) => {
      const ws = (await window.workspaceAPI.getSnapshot()).workspaces.find(ws => ws.name === 'console-1')!;
      const scope = await window.workspaceAPI.addScope(ws.id, { name: 'inbox-checkout', path: folder, isGitRepo: true });
      const group = await window.workspaceAPI.createGroup(ws.id, { name: 'Inbox work' });
      return { scopeId: scope.id, groupId: group.id };
    }, { folder: existing });
    await page.locator('.sidebar').getByRole('button', { name: 'Choose scope' }).click();
    await page.getByRole('menuitem', { name: /inbox-checkout/ }).click();
    await page.locator('.group-nav-header').hover();
    await page.getByRole('button', { name: 'Group actions for Inbox work' }).click();
    await page.getByRole('menuitem', { name: 'New session with options…' }).click();
    await expect(page.getByLabel('Scope', { exact: true })).toContainText('inbox-checkout');
    await expect(page.getByLabel('Group', { exact: true })).toContainText('Inbox work');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByRole('dialog', { name: 'New session with options' })).toHaveCount(0);
    const grouped = await page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces.find(ws => ws.name === 'console-1')!.sessions.at(-1)!);
    expect(grouped.scopeId).toBe(destination.scopeId);
    expect(grouped.groupId).toBe(destination.groupId);
    expect(grouped.cwd).toBe(existing);
    await expect(page.locator('.group-nav-item .session-nav-item.active')).toBeVisible();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+KeyN' : 'Control+Shift+KeyN');
    await expect(page.getByLabel('Scope', { exact: true })).toContainText('inbox-checkout');
    await expect(page.getByLabel('Group', { exact: true })).toContainText('Ungrouped');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.group-nav-item .session-nav-item.active')).toBeVisible();

  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  }
});

test('plus and new-session shortcuts launch defaults; options are cancellable and preserve destinations', async () => {
  test.setTimeout(60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-quick-session-'));
  const profile = path.join(root, 'codex');
  const secondary = path.join(root, 'api');
  fs.mkdirSync(profile);
  fs.mkdirSync(secondary);
  const { app, page, userDataDir } = await launchElectron();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  try {
    const setup = await page.evaluate(async ({ root, secondary, profile, binary }) => {
      await window.harnessStateAPI.addHarness({ id: 'fixture', name: 'Development agent', driverId: 'codex', accentColor: '#da9775', binaryPath: binary, configDir: profile });
      const workspace = await window.workspaceAPI.createWorkspace('Quick sessions', root, false, 'fixture');
      const scope = await window.workspaceAPI.addScope(workspace.id, { name: 'API', path: secondary, isGitRepo: false });
      const group = await window.workspaceAPI.createGroup(workspace.id, { name: 'Feature' });
      return { workspaceId: workspace.id, scopeId: scope.id, groupId: group.id };
    }, { root, secondary, profile, binary: path.resolve('tests/fixtures/codex.cjs') });
    const sessions = () => page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces[0].sessions);
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Quick sessions/ }).click();
    await page.locator('.sidebar').getByRole('button', { name: 'Choose scope' }).click();
    await page.getByRole('menuitem', { name: /API/ }).click();
    await page.locator('.sidebar-workspace').getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
    expect(await sessions()).toHaveLength(1);
    expect((await sessions())[0]).toMatchObject({ harnessId: 'fixture', scopeId: setup.scopeId });
    expect((await sessions())[0].model).toBeUndefined();
    await expect(page.locator('.new-session-view')).toHaveCount(0);

    await page.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.press(`${mod}+KeyN`);
    await expect.poll(async () => (await sessions()).length).toBe(2);
    await expect(page.locator('.new-session-dialog')).toHaveCount(0);
    const activeIndex = () => page.locator('.session-nav-item').evaluateAll(rows => rows.findIndex(row => row.classList.contains('active')));
    const active = await activeIndex();
    await page.keyboard.press(`${mod}+Shift+KeyN`);
    const modal = page.getByRole('dialog', { name: 'New session with options' });
    await expect(modal).toBeVisible();
    expect(app.windows()).toHaveLength(1);
    expect(await sessions()).toHaveLength(2);
    await expect(modal.getByLabel('Scope', { exact: true })).toContainText('API');
    await expect(modal.getByLabel('Group', { exact: true })).toContainText('Ungrouped');
    await expect(modal.getByLabel('Model', { exact: true })).toBeEnabled();
    await modal.getByLabel('Model', { exact: true }).click();
    await page.getByRole('option', { name: 'fixture-model-b', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.radix-themes').first()).toHaveClass(/dark/);
    await modal.getByLabel('Agent', { exact: true }).focus();
    await page.screenshot({ path: 'test-results/session-options-dark.png', animations: 'disabled' });
    await modal.getByLabel('Agent', { exact: true }).click();
    await expect(page.getByRole('option', { name: 'Development agent', exact: true }).locator('[data-harness-type="codex"]')).toBeVisible();
    await page.screenshot({ path: 'test-results/session-options-agents.png', animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('.radix-themes').first()).toHaveClass(/light/);
    await page.screenshot({ path: 'test-results/session-options-light.png', animations: 'disabled' });
    await page.setViewportSize({ width: 440, height: 740 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.screenshot({ path: 'test-results/session-options-compact.png', animations: 'disabled' });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    expect(await sessions()).toHaveLength(2);
    expect(await activeIndex()).toBe(active);

    await page.locator('.group-nav-header').hover();
    await page.getByRole('button', { name: 'New session in Feature', exact: true }).click();
    await expect.poll(async () => (await sessions()).length).toBe(3);
    expect((await sessions())[2]).toMatchObject({ scopeId: setup.scopeId, groupId: setup.groupId, harnessId: 'fixture' });
    await page.getByRole('button', { name: 'New ungrouped session' }).click();
    await expect.poll(async () => (await sessions()).length).toBe(4);
    expect((await sessions())[3].groupId).toBeUndefined();

    await page.locator('.group-nav-header').hover();
    await page.getByRole('button', { name: 'Group actions for Feature' }).click();
    await page.getByRole('menuitem', { name: 'New session with options…' }).click();
    await expect(modal.getByLabel('Group', { exact: true })).toContainText('Feature');
    await expect(modal.getByLabel('Model', { exact: true })).toContainText('Default model');
    await modal.getByLabel('Model', { exact: true }).click();
    await page.getByRole('option', { name: 'fixture-model-b', exact: true }).click();
    await modal.getByRole('button', { name: 'Create session' }).click();
    await expect(modal).toHaveCount(0);
    expect((await sessions())[4]).toMatchObject({ groupId: setup.groupId, scopeId: setup.scopeId, model: 'fixture-model-b' });
    await page.getByRole('button', { name: 'Ungrouped actions' }).click();
    await page.getByRole('menuitem', { name: 'New session with options…' }).click();
    await expect(modal.getByLabel('Group', { exact: true })).toContainText('Ungrouped');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await sessions()).toHaveLength(5);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  }
});
