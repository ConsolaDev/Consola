import { expect, test, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from './helpers/electron';

/** Answer the next native folder dialogs with these folders, as if picked by hand. */
async function stubFolderDialog(app: ElectronApplication, folders: string[]) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog;
  }, folders);
}

function makeFolders() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-onboarding-')));
  const web = path.join(root, 'web');
  const api = path.join(root, 'api');
  fs.mkdirSync(web);
  fs.mkdirSync(api);
  execFileSync('git', ['-C', web, 'init', '-b', 'main']);
  return { root, web, api };
}

test('first run explains the model and creates a multi-scope workspace', async () => {
  test.setTimeout(60_000);
  const { web, api } = makeFolders();
  const { app, page } = await launchElectron();
  try {
    await expect(page.getByRole('heading', { name: 'Welcome to Consola' })).toBeVisible();
    for (const term of ['Workspace', 'Scope', 'Session']) {
      await expect(page.locator('.home-concept dt', { hasText: term })).toBeVisible();
    }
    await page.screenshot({ path: 'test-results/onboarding-welcome.png' });

    await stubFolderDialog(app, [web, api]);
    await page.getByRole('button', { name: 'Choose project folders' }).click();
    const name = page.getByLabel('Workspace name');
    await expect(name).toHaveValue('web');
    const scopes = page.getByRole('list', { name: 'Scopes' });
    await expect(scopes.getByRole('listitem')).toHaveCount(2);
    await name.fill('Checkout');
    await page.screenshot({ path: 'test-results/onboarding-setup.png' });
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect(page.locator('.workspace-empty-heading')).toContainText('Checkout');
    const created = await page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces[0]);
    expect(created.name).toBe('Checkout');
    // The workspace's name is its own; each scope keeps its folder's.
    expect(created.scopes.map((scope) => scope.name)).toEqual(['web', 'api']);

    const tips = page.getByRole('region', { name: 'Before your first session' });
    await expect(tips).toContainText('Runs in the web scope');
    await expect(tips).toContainText('New worktree');
    await expect(tips.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await expect(page.locator('.sidebar-ungrouped')).toContainText('Sessions you start in web appear here.');
    await page.screenshot({ path: 'test-results/onboarding-first-session.png' });

    // A session in one scope must not look lost from another.
    await page.evaluate(async ({ id, scopeId }) => {
      await window.workspaceAPI.createSession(id, {
        name: 'Fix login', workspaceId: id, instanceId: `workspace-${id}-session-onboarding`,
        harnessId: 'default', scopeId,
      });
    }, { id: created.id, scopeId: created.scopes[0].id });
    await expect(tips).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose scope' }).first().click();
    await page.getByRole('menuitem', { name: /api/ }).click();
    const elsewhere = page.getByRole('button', { name: '1 session in other scopes' });
    await expect(elsewhere).toBeVisible();
    await page.screenshot({ path: 'test-results/onboarding-other-scopes.png' });
    await elsewhere.click();
    await expect(page.getByRole('tab', { name: 'All your sessions' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('navigation', { name: 'All sessions' })).toContainText('Fix login');
  } finally {
    await app.close();
  }
});

test('⌘N with no workspace open starts one from the folder picker', async () => {
  const { web } = makeFolders();
  const { app, page } = await launchElectron();
  try {
    await expect(page.getByRole('heading', { name: 'Welcome to Consola' })).toBeVisible();
    await stubFolderDialog(app, [web]);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyN' : 'Control+KeyN');
    await expect(page.locator('.workspace-empty-heading')).toContainText('web');
  } finally {
    await app.close();
  }
});
