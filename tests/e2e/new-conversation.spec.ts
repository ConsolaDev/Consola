import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from './helpers/electron';

test('new conversation creates and reuses worktrees, with searchable refs and recoverable errors', async () => {
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
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: /console-1/ }).click();
    await expect(page.getByRole('heading', { name: /What should we build in/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Choose branch or worktree' })).toContainText('main');
    await page.screenshot({ path: 'test-results/new-conversation.png' });
    await page.getByRole('button', { name: 'Choose branch or worktree' }).click();
    await page.getByRole('textbox', { name: 'Search branches and worktrees' }).fill('no-such-branch');
    await expect(page.getByText('No matching branches or worktrees.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Search branches and worktrees' }).fill('');
    await page.screenshot({ path: 'test-results/new-conversation-branches.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Checkout mode' }).click();
    await page.getByRole('menuitem', { name: /New worktree/ }).click();
    await page.getByLabel('New branch', { exact: true }).fill('main');
    await page.getByRole('combobox', { name: 'Message' }).fill('Build a beautiful composer');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('alert')).toContainText('already exists');
    await expect(page.getByRole('combobox', { name: 'Message' })).toHaveValue('Build a beautiful composer');
    await page.getByLabel('New branch', { exact: true }).fill('feature/composer');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.new-session-view')).toHaveCount(0);
    const first = await page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces.find(ws => ws.name === 'console-1')!.sessions[0]);
    expect(first.cwd).toContain('/worktrees/');
    expect(execFileSync('git', ['-C', first.cwd!, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('feature/composer');
    expect(git('branch', '--show-current')).toBe('main');

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: /New session…/ }).click();
    await page.getByRole('button', { name: 'Checkout mode' }).click();
    await page.getByRole('menuitem', { name: /Existing worktree/ }).click();
    await page.getByRole('textbox', { name: 'Search branches and worktrees' }).fill('feature/inbox');
    await page.getByRole('button', { name: /feature\/inbox.*worktree/ }).click();
    await expect(page.getByRole('button', { name: 'Checkout mode' })).toContainText('Existing worktree');
    await page.getByRole('combobox', { name: 'Message' }).fill('Continue the inbox');
    await page.getByRole('combobox', { name: 'Message' }).press('Enter');
    await expect(page.locator('.new-session-view')).toHaveCount(0);
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
    await page.getByRole('button', { name: 'New session in Inbox work' }).click();
    await expect(page.locator('.new-session-view .scope-selector')).toContainText('inbox-checkout');
    await expect(page.getByRole('button', { name: 'Choose group' })).toContainText('Inbox work');
    await page.getByRole('combobox', { name: 'Message' }).fill('Finish the inbox work');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.new-session-view')).toHaveCount(0);
    const grouped = await page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces.find(ws => ws.name === 'console-1')!.sessions.at(-1)!);
    expect(grouped.scopeId).toBe(destination.scopeId);
    expect(grouped.groupId).toBe(destination.groupId);
    expect(grouped.cwd).toBe(existing);
    await expect(page.locator('.group-nav-item .session-nav-item.active')).toBeVisible();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyN' : 'Control+KeyN');
    await expect(page.locator('.new-session-view .scope-selector')).toContainText('inbox-checkout');
    await expect(page.getByRole('button', { name: 'Choose group' })).toContainText('Ungrouped');

  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  }
});
