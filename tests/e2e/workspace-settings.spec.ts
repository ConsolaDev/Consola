import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  commandPaletteChord,
  createProfileDir,
  launchElectron,
  settingsChord,
} from './helpers/electron';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');

/**
 * Seed a provider-bound v7 workspace directly into the profile. main/index.ts
 * appends ' Test' to the profile dir under NODE_ENV=test, so the file must
 * land there. Shape per the v7 record in src/shared/workspace.ts: `provider`
 * replaces `github`; `actions` and `sectionDefaults` are the two fields the
 * migration adds, empty here because nothing in this spec reads them.
 */
function seedWorkspaceState(userDataDir: string, scopeDir: string): string {
  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const workspaceId = 'ws-settings-e2e';
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify(
      {
        version: 7,
        workspaces: [
          {
            id: workspaceId,
            name: 'Sympower',
            defaultHarnessId: 'default',
            scopes: [
              {
                id: 'scope-app',
                name: 'controller-app',
                path: scopeDir,
                isGitRepo: false,
                createdAt: now,
              },
            ],
            groups: [],
            provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
            actions: [],
            sectionDefaults: {},
            sessions: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2
    )
  );
  return workspaceId;
}

/**
 * Launch against a seeded profile with the stub gh on the path: the sidebar
 * primes the Inbox for a bound workspace, and that must never reach a real
 * gh from a test.
 */
async function launchSeeded(): Promise<{
  page: Page;
  cleanup: () => Promise<void>;
}> {
  const userDataDir = createProfileDir();
  const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-ws-settings-'));
  seedWorkspaceState(userDataDir, scopeDir);
  const { app, page } = await launchElectron({
    userDataDir,
    env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  // Guaranteed by the caller's finally: a mid-test failure must not leave a
  // real Electron process running for the rest of the worker, nor its
  // profile behind in the OS temp dir.
  const cleanup = async () => {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(scopeDir, { recursive: true, force: true });
  };
  return { page, cleanup };
}

/** The switcher trigger; its accessible name never includes the workspace. */
function switcherTrigger(page: Page) {
  return page.getByRole('button', { name: /^Switch workspace/ });
}

/** Hold the seeded workspace through the real switcher UI (windows.spec.ts precedent). */
async function holdWorkspace(page: Page): Promise<void> {
  await switcherTrigger(page).click();
  await page.getByRole('menuitem', { name: /Sympower/ }).click();
  await expect(switcherTrigger(page)).toHaveText('Sympower');
}

test('the workspace menu opens a modal titled by the workspace; the global modal only points at it', async () => {
  test.setTimeout(60_000);
  const { page, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);

    // The front door: the workspace menu.
    await switcherTrigger(page).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();

    const modal = page.getByRole('dialog', { name: 'Sympower', exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.locator('.settings-modal-nav-item')).toHaveText([
      'General',
      'Scopes',
      'GitHub', // providerNavLabel: the bound provider's display name
      'Actions',
      'Groups',
      'Danger zone',
    ]);

    // General lands first: the manifest with the name editable in place.
    await expect(modal.getByLabel('Workspace name')).toHaveValue('Sympower');

    await modal.getByRole('button', { name: 'Scopes', exact: true }).click();
    await expect(modal.locator('.ws-row-name', { hasText: 'controller-app' })).toBeVisible();

    await modal.getByRole('button', { name: 'Danger zone', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Delete workspace…' })).toBeVisible();

    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();

    // The chord still opens the global modal, which no longer lists Workspace.
    await page.keyboard.press(settingsChord());
    const global = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(global).toBeVisible();
    await expect(global.locator('.settings-modal-nav-item')).toHaveText([
      'Appearance',
      'Harnesses',
      'Keyboard Shortcuts',
    ]);

    // The pointer row is a door: it closes this modal and opens the other.
    await global
      .getByRole('button', { name: 'Workspace settings are in the workspace menu' })
      .click();
    await expect(global).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.settings-modal-nav-item.active')).toHaveText('General');

    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
  } finally {
    await cleanup();
  }
});

test('the sidebar gear opens the global modal; the workspace modal commits a rename, shows the Actions placeholder, and Cancel on delete leaves Danger zone active', async () => {
  test.setTimeout(60_000);
  const { page, cleanup } = await launchSeeded();
  try {
    // The sidebar footer gear is the other door into Settings, and it opens
    // the global modal (not a workspace one), landing on Appearance.
    await page.getByRole('button', { name: /^Settings/ }).click();
    const global = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(global).toBeVisible();
    await expect(global.locator('.settings-modal-nav-item.active')).toHaveText('Appearance');
    await global.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(global).toBeHidden();

    await holdWorkspace(page);
    await switcherTrigger(page).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();

    // Named generically from here: General's rename changes the dialog's own
    // accessible name, so a locator pinned to the old name would stop
    // matching once the rename commits.
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAccessibleName('Sympower');

    // General: Enter commits the draft, same as ManifestHeader's own
    // keydown handler, and the dialog title follows immediately.
    await modal.getByLabel('Workspace name').fill('Sympower Renamed');
    await modal.getByLabel('Workspace name').press('Enter');
    await expect(modal).toHaveAccessibleName('Sympower Renamed');

    // The switcher trigger picks up the new name too — checked with the
    // modal closed, since Radix hides the rest of the page from the
    // accessibility tree while a dialog is open.
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(switcherTrigger(page)).toHaveText('Sympower Renamed');
    await switcherTrigger(page).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    await expect(modal).toBeVisible();

    // Actions is still Phase C's placeholder.
    await modal.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(modal.getByText('Actions are configured in the next release.')).toBeVisible();

    // Danger zone: Cancel on the confirmation leaves the workspace modal
    // open with Danger zone still the active section.
    await modal.getByRole('button', { name: 'Danger zone', exact: true }).click();
    await modal.getByRole('button', { name: 'Delete workspace…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete “Sympower Renamed”?', exact: true });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.settings-modal-nav-item.active')).toHaveText('Danger zone');
  } finally {
    await cleanup();
  }
});

test('the command palette offers Workspace settings… for the held workspace', async () => {
  test.setTimeout(60_000);
  const { page, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);

    await page.keyboard.press(commandPaletteChord());
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').fill('workspace settings');
    // The row's accessible name is its label plus its context ("… Sympower"),
    // so this match is deliberately not exact.
    await palette.getByRole('option', { name: 'Workspace settings…' }).click();

    await expect(palette).toBeHidden();
    const modal = page.getByRole('dialog', { name: 'Sympower', exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
  } finally {
    await cleanup();
  }
});
