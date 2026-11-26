import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchElectron } from './helpers/electron';

/** Answer the next native folder dialogs with these folders, as if picked by hand. */
async function stubFolderDialog(app: ElectronApplication, folders: string[]) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths,
    });
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

    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New workspace' });
    const next = dialog.getByRole('button', { name: 'Next' });

    // Where it runs: local is chosen, and cloud is shown but cannot be picked yet.
    await expect(
      dialog.getByRole('heading', { name: 'Where will this workspace run?' }),
    ).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /^Local/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /^Cloud/ })).toBeDisabled();
    await expect(dialog.getByText('Coming soon')).toBeVisible();
    await page.screenshot({ path: 'test-results/onboarding-location.png' });
    await next.click();

    // Its name: typed straight away, and Enter moves on once there is one.
    const name = dialog.getByLabel('Workspace name');
    await expect(name).toBeFocused();
    await expect(next).toBeDisabled();
    await name.fill('Checkout');
    await page.keyboard.press('Enter');

    // Its folders: each one picked becomes a scope.
    await expect(dialog.getByRole('button', { name: 'Create workspace' })).toBeDisabled();
    await stubFolderDialog(app, [web, api]);
    await dialog.getByRole('button', { name: /Choose folders/ }).click();
    const scopes = dialog.getByRole('list', { name: 'Scopes' });
    await expect(scopes.getByRole('listitem')).toHaveCount(2);

    // Going back keeps every answer.
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(name).toHaveValue('Checkout');
    await next.click();
    await expect(scopes.getByRole('listitem')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/onboarding-setup.png' });
    await dialog.getByRole('button', { name: 'Create workspace' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.workspace-empty-heading')).toContainText('Checkout');
    const created = await page.evaluate(
      async () => (await window.workspaceAPI.getSnapshot()).workspaces[0],
    );
    expect(created.name).toBe('Checkout');
    // The workspace's name is its own; each scope keeps its folder's.
    expect(created.scopes.map((scope) => scope.name)).toEqual(['web', 'api']);

    const tips = page.getByRole('region', { name: 'Before your first session' });
    await expect(tips).toContainText('Runs in the web scope');
    await expect(tips).toContainText('New worktree');
    await expect(tips.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await expect(page.locator('.sidebar-sessions')).toContainText(
      'Sessions you start appear here.',
    );
    await page.screenshot({ path: 'test-results/onboarding-first-session.png' });

    // A session in one scope must not look lost from another.
    await page.evaluate(
      async ({ id, scopeId }) => {
        await window.workspaceAPI.createSession(id, {
          name: 'Fix login',
          workspaceId: id,
          instanceId: `workspace-${id}-session-onboarding`,
          harnessId: 'default',
          scopeId,
        });
      },
      { id: created.id, scopeId: created.scopes[0].id },
    );
    await expect(tips).toHaveCount(0);
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).click();
    await page.getByRole('menuitem', { name: /api/ }).click();
    // Scoped to the empty state: the filter bar's × has a similar name.
    const showAll = page
      .locator('.sidebar-sessions')
      .getByRole('button', { name: 'Show all scopes', exact: true });
    await expect(showAll).toBeVisible();
    await page.screenshot({ path: 'test-results/onboarding-other-scopes.png' });
    await showAll.click();
    const row = page.locator('.session-nav-item').filter({ hasText: 'Fix login' });
    await expect(row).toBeVisible();
    await expect(row.locator('.session-nav-item-scope')).toContainText('web');
  } finally {
    await app.close();
  }
});

test('⌘N with no workspace open opens the New workspace dialog, fresh each time', async () => {
  const { web } = makeFolders();
  const { app, page } = await launchElectron();
  const newChord = process.platform === 'darwin' ? 'Meta+KeyN' : 'Control+KeyN';
  try {
    await expect(page.getByRole('heading', { name: 'Welcome to Consola' })).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'New workspace' });
    const name = dialog.getByLabel('Workspace name');

    // Escape leaves nothing behind: no workspace, and no half-typed name.
    await page.keyboard.press(newChord);
    await dialog.getByRole('button', { name: 'Next' }).click();
    await name.fill('Abandoned');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(async () => (await window.workspaceAPI.getSnapshot()).workspaces),
    ).toHaveLength(0);

    await page.keyboard.press(newChord);
    await expect(dialog.getByRole('radio', { name: /^Local/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(name).toHaveValue('');
    await name.fill('web');
    await page.keyboard.press('Enter');
    await stubFolderDialog(app, [web]);
    await dialog.getByRole('button', { name: /Choose folders/ }).click();
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.locator('.workspace-empty-heading')).toContainText('web');
  } finally {
    await app.close();
  }
});
