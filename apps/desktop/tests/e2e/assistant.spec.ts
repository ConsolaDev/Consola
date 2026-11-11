import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';

/**
 * The workspace Assistant's pane: its own header, the shortcut that opens it
 * from anywhere, and the fresh-conversation menu.
 *
 * Opening it mounts a terminal that tries to launch the real `claude`, so
 * everything here asserts on the header and the app's own state, never on what
 * the CLI prints.
 */

let app: ElectronApplication;
let page: Page;
let base: string;
let factoryDir: string;

test.beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-assistant-'));
  factoryDir = path.join(base, 'factories');
  ({ app, page } = await launchElectron({ env: { CONSOLA_FACTORY_DIR: factoryDir } }));
});

test.afterEach(async () => {
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The Assistant chord, matching isAssistantShortcut on this platform. */
function assistantChord(): string {
  return process.platform === 'darwin' ? 'Meta+KeyJ' : 'Control+Shift+KeyJ';
}

/** A workspace with the given scopes, made through the real API. */
async function seedWorkspace(name: string, scopes: string[]): Promise<string> {
  const [first, ...rest] = scopes;
  const id = await page.evaluate(
    ([workspaceName, firstPath]) =>
      window.workspaceAPI.createWorkspace(workspaceName!, firstPath!, false).then((workspace) => workspace.id),
    [name, folder(first!)] as const
  );
  for (const scope of rest) {
    await page.evaluate(
      ([workspaceId, scopePath, scopeName]) =>
        window.workspaceAPI.addScope(workspaceId!, { name: scopeName!, path: scopePath!, isGitRepo: false }),
      [id, folder(scope), scope] as const
    );
  }
  return id;
}

async function seedSession(workspaceId: string, name: string): Promise<string> {
  return page.evaluate(
    async ([id, sessionName]) => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      const workspace = workspaces.find((candidate) => candidate.id === id)!;
      const session = await window.workspaceAPI.createSession(id!, {
        name: sessionName!,
        workspaceId: id!,
        instanceId: `workspace-${id}-session-${sessionName!.replace(/\s/g, '-')}`,
        harnessId: workspace.defaultHarnessId,
        scopeId: workspace.scopes[0]!.id,
      });
      return session!.id;
    },
    [workspaceId, name] as const
  );
}

async function assistantSessionId(workspaceId: string): Promise<string | undefined> {
  return page.evaluate(async (id) => {
    const { workspaces } = await window.workspaceAPI.getSnapshot();
    return workspaces.find((workspace) => workspace.id === id)?.sessions.find((s) => s.kind === 'assistant')?.id;
  }, workspaceId);
}

function railButton(name: string) {
  return page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name, exact: true });
}

async function openWorkspace(name: string) {
  await railButton(name).click();
  await expect(railButton(name)).toHaveAttribute('aria-current', 'true');
}

test('the Assistant row opens a full-width Assistant pane', async () => {
  const workspaceId = await seedWorkspace('catalog-portal', ['catalog-portal', 'shared-lib']);
  await seedSession(workspaceId, 'Fix flaky test');
  await openWorkspace('catalog-portal');

  await page.getByRole('button', { name: /Assistant/ }).click();

  const header = page.locator('.workspace-view-header');
  await expect(header).toContainText('✦ Assistant');
  await expect(header).toContainText('catalog-portal · sees 1 session in 2 scopes');
  // Not a repo, so none of the checkout controls are offered.
  await expect(header.locator('.checkout-chip')).toHaveCount(0);
  await expect(header.getByRole('button', { name: /explorer|terminal/i })).toHaveCount(0);
  await expect(page.locator('#explorer, [data-panel-id="explorer"]')).toHaveCount(0);

  expect(fs.existsSync(path.join(factoryDir, workspaceId, 'assistant', 'CLAUDE.md'))).toBe(true);
});

test('the chord opens it from a session, and the workspace remembers it', async () => {
  const workspaceId = await seedWorkspace('catalog-portal', ['catalog-portal']);
  await seedWorkspace('other-place', ['other-place']);
  await seedSession(workspaceId, 'Fix flaky test');
  await openWorkspace('catalog-portal');

  await page.getByText('Fix flaky test', { exact: true }).first().click();
  await expect(page.locator('.workspace-view-header')).toContainText('Fix flaky test');
  await expect(page.locator('.workspace-view-header')).not.toContainText('✦ Assistant');

  await page.keyboard.press(assistantChord());
  await expect(page.locator('.workspace-view-header')).toContainText('✦ Assistant');

  // The other workspace has no remembered view, so it shows the composer.
  await openWorkspace('other-place');
  await expect(page.locator('.workspace-view-header')).toHaveCount(0);
  await openWorkspace('catalog-portal');
  await expect(page.locator('.workspace-view-header')).toContainText('✦ Assistant');
});

test('the row is disabled without a scope', async () => {
  const workspaceId = await seedWorkspace('catalog-portal', ['catalog-portal']);
  await openWorkspace('catalog-portal');
  const scopeId = await page.evaluate(async (id) => {
    const { workspaces } = await window.workspaceAPI.getSnapshot();
    return workspaces.find((workspace) => workspace.id === id)!.scopes[0]!.id;
  }, workspaceId);
  await page.evaluate(([id, scope]) => window.workspaceAPI.removeScope(id!, scope!), [workspaceId, scopeId] as const);

  const row = page.getByRole('button', { name: /Assistant/ });
  await expect(row).toHaveAttribute('title', 'Add a scope to use the Assistant.');
  await row.click({ force: true });
  await expect(page.locator('.workspace-view-header')).toHaveCount(0);
});

test('its ⋯ menu starts a fresh conversation', async () => {
  const workspaceId = await seedWorkspace('catalog-portal', ['catalog-portal']);
  await openWorkspace('catalog-portal');
  await page.getByRole('button', { name: /Assistant/ }).click();
  await expect(page.locator('.workspace-view-header')).toContainText('✦ Assistant');
  const before = await assistantSessionId(workspaceId);
  expect(before).toBeTruthy();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Assistant actions' }).click();
  await page.getByRole('menuitem', { name: 'Start a fresh conversation' }).click();

  await expect.poll(() => assistantSessionId(workspaceId)).not.toBe(before);
  await expect(page.locator('.workspace-view-header')).toContainText('✦ Assistant');
});
