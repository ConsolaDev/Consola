import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
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
 * migration adds. `actions` seeds one real action (finding 2b's edit flow
 * needs a row to edit); `sectionDefaults` stays empty because nothing here
 * reads it.
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
            groups: [{ id: 'g-reviews', name: 'PR reviews', createdAt: now }],
            provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
            actions: [{ id: 'a-review', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' }],
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

interface SeededAction {
  id?: string;
  name?: string;
  prompt?: string;
  groupId?: string;
}

/** Read back the persisted actions list, for asserting a write actually landed. */
function actionsIn(stateFile: string): SeededAction[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return parsed.workspaces?.[0]?.actions ?? [];
  } catch {
    return []; // mid-write; the poll comes back
  }
}

/**
 * Launch against a seeded profile with the stub gh on the path: the sidebar
 * primes the Inbox for a bound workspace, and that must never reach a real
 * gh from a test.
 */
async function launchSeeded(): Promise<{
  page: Page;
  app: ElectronApplication;
  /** workspaces.json for this run — asserting a write actually persisted. */
  stateFile: string;
  cleanup: () => Promise<void>;
}> {
  const userDataDir = createProfileDir();
  const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-ws-settings-'));
  seedWorkspaceState(userDataDir, scopeDir);
  const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');
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
  return { page, app, stateFile, cleanup };
}

/** The seeded workspace stays available in the rail, including after a rename. */
function workspaceButton(page: Page) {
  return page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /^Sympower/ });
}

test('workspace icons can be searched, selected, reloaded and reset', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const { page, stateFile, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);
    await expect(workspaceButton(page).locator('[data-workspace-icon]')).toHaveAttribute('data-workspace-icon', 'initial');
    await expect(workspaceButton(page).locator('[data-workspace-icon]')).toHaveText('S');
    const openSettings = async () => {
      await page.getByRole('button', { name: / workspace menu$/ }).click();
      await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
      await page.getByRole('button', { name: 'Change workspace icon' }).click();
    };
    await openSettings();
    const picker = page.getByRole('dialog', { name: 'Workspace icon', exact: true });
    await picker.getByRole('tab', { name: 'Emojis', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('workspace-icon-picker.png') });
    await picker.getByRole('searchbox').fill('rocket');
    await expect(picker.getByRole('group', { name: 'Emojis' }).getByRole('button')).toHaveCount(1);
    await picker.getByRole('button', { name: 'Rocket', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect.poll(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].icon).toBe('emoji-rocket');
    await page.getByRole('dialog', { name: 'Sympower', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(workspaceButton(page).locator('[data-workspace-icon]')).toHaveAttribute('data-workspace-icon', 'emoji-rocket');

    await page.reload();
    await workspaceButton(page).click();
    await expect(workspaceButton(page).locator('[data-workspace-icon]')).toHaveAttribute('data-workspace-icon', 'emoji-rocket');
    await page.keyboard.press(commandPaletteChord());
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await palette.getByRole('combobox').fill('# Sympower');
    await expect(palette.getByRole('option', { name: /Sympower/ }).locator('[data-workspace-icon]')).toHaveAttribute('data-workspace-icon', 'emoji-rocket');
    // Escape first leaves the workspace search scope, then closes the palette.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await openSettings();
    await picker.getByRole('tab', { name: 'Icons', exact: true }).click();
    await picker.getByRole('searchbox').fill('no matching icon');
    await expect(picker.getByText('No icons found.')).toBeVisible();
    await picker.getByRole('searchbox').fill('briefcase');
    await picker.getByRole('button', { name: 'Briefcase', exact: true }).click();
    await page.getByRole('button', { name: 'Change workspace icon' }).click();
    await expect(picker.getByRole('button', { name: 'Briefcase', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: 'Reset to default' }).click();
    await expect.poll(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].icon).toBeUndefined();
    await page.getByRole('button', { name: 'Change workspace icon' }).click();
    await picker.getByRole('searchbox').press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Sympower', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change workspace icon' })).toBeFocused();
    await page.getByRole('dialog', { name: 'Sympower', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(workspaceButton(page).locator('[data-workspace-icon]')).toHaveAttribute('data-workspace-icon', 'initial');
    await expect(workspaceButton(page).locator('[data-workspace-icon]')).toHaveText('S');
  } finally {
    await cleanup();
  }
});

test('custom workspace images preview, persist without the source file, and can be replaced or removed', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const { page, stateFile, cleanup } = await launchSeeded();
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-icon-upload-'));
  try {
    await holdWorkspace(page);
    // A wide image exercises fitting and transparency, not just a square copy.
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 300; canvas.height = 150;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#159957'; context.fillRect(0, 0, 300, 150);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const sourceFile = path.join(imageDir, 'my-logo.png');
    fs.writeFileSync(sourceFile, Buffer.from(source, 'base64'));
    await page.getByRole('button', { name: / workspace menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    await page.getByRole('button', { name: 'Change workspace icon' }).click();
    const picker = page.getByRole('dialog', { name: 'Workspace icon', exact: true });
    await picker.getByRole('tab', { name: 'Upload', exact: true }).click();
    const input = picker.getByLabel('Upload workspace image');
    await input.setInputFiles(sourceFile);
    await expect(picker.getByRole('button', { name: 'Use image', exact: true })).toBeEnabled();
    const preview = picker.locator('.ws-icon-upload-preview img');
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128);
    const pixels = await preview.evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d')!;
      context.drawImage(img, 0, 0);
      return {
        cornerAlpha: context.getImageData(0, 0, 1, 1).data[3],
        center: Array.from(context.getImageData(64, 64, 1, 1).data),
      };
    });
    expect(pixels).toEqual({ cornerAlpha: 0, center: [21, 153, 87, 255] });
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].icon).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath('custom-workspace-icon.png') });
    await picker.getByRole('button', { name: 'Use image', exact: true }).click();
    await expect(picker).toBeHidden();
    const storedIcon = JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].icon;
    expect(storedIcon).toMatchObject({ type: 'image', dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
    fs.unlinkSync(sourceFile);
    await page.reload();
    await workspaceButton(page).click();
    await expect.poll(() => workspaceButton(page).locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128);
    await page.getByRole('button', { name: / workspace menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    await page.getByRole('button', { name: 'Change workspace icon' }).click();
    await expect(picker.getByRole('tab', { name: 'Upload', exact: true })).toHaveAttribute('aria-selected', 'true');

    // Bad uploads leave the saved image intact and allow another attempt.
    await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken') });
    await expect(picker.getByRole('alert')).toHaveText('This image could not be opened. Try another file.');
    await input.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await expect(picker.getByRole('alert')).toHaveText('Choose an image smaller than 5 MB.');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].icon).toEqual(storedIcon);

    const replacement = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#cc2244'; context.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    await input.setInputFiles({ name: 'replacement.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(replacement, 'base64') });
    await expect(picker.getByRole('button', { name: 'Use image', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: 'Use image', exact: true }).click();
    await expect(picker).toBeHidden();
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].icon.dataUrl).not.toBe(storedIcon.dataUrl);
    await page.getByRole('button', { name: 'Change workspace icon' }).click();
    await picker.getByRole('button', { name: 'Reset to default' }).click();
    await expect(picker).toBeHidden();
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].icon).toBeUndefined();
  } finally {
    await cleanup();
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
});

/** Hold the seeded workspace through the real switcher UI (windows.spec.ts precedent). */
async function holdWorkspace(page: Page): Promise<void> {
  await workspaceButton(page).click();
  await expect(workspaceButton(page)).toHaveAttribute('aria-current', 'true');
}

test('the workspace rail sits beside Home, adds workspaces, and stays available with the sidebar hidden', async ({}, testInfo) => {
  const { app, page, cleanup } = await launchSeeded();
  const addedFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-added-workspace-'));
  const addedName = path.basename(addedFolder);
  try {
    await holdWorkspace(page);
    const rail = page.getByRole('navigation', { name: 'Workspaces', exact: true });
    const home = page.getByRole('navigation', { name: 'Main navigation', exact: true });
    const railBox = (await rail.boundingBox())!;
    const homeBox = (await home.boundingBox())!;
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(homeBox.x);
    expect(railBox.y).toBe(homeBox.y);
    await expect(home.locator('[data-workspace-icon]')).toHaveCount(0);
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const modifierLabel = process.platform === 'darwin' ? '⌘' : 'Ctrl';
    await page.mouse.move(500, 400);
    await workspaceButton(page).hover();
    await expect(page.getByRole('tooltip')).toContainText('Sympower');
    await expect(page.locator('.workspace-tooltip-shortcut').first().locator('kbd')).toHaveText([modifierLabel, '1']);
    await expect(workspaceButton(page)).toHaveAttribute('aria-keyshortcuts', `${modifier}+1`);
    await page.screenshot({ path: testInfo.outputPath('workspace-tooltip.png'), animations: 'disabled' });
    await page.mouse.move(500, 400);

    // Drive the + button through the real folder-selection and creation flow.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, addedFolder);
    await rail.getByRole('button', { name: 'Add workspace', exact: true }).click();
    const added = rail.getByRole('button', { name: addedName, exact: true });
    await expect(added).toHaveAttribute('aria-current', 'true');
    await expect(rail.getByRole('button')).toHaveCount(3);
    await expect(added).toHaveAttribute('aria-keyshortcuts', `${modifier}+2`);
    await added.hover();
    await expect(page.getByRole('tooltip')).toContainText(addedName);
    await expect(page.locator('.workspace-tooltip-shortcut').first().locator('kbd')).toHaveText([modifierLabel, '2']);
    await page.mouse.move(500, 400);
    const addedBox = (await added.boundingBox())!;
    const plusBox = (await rail.getByRole('button', { name: 'Add workspace' }).boundingBox())!;
    expect(plusBox.y).toBeGreaterThan(addedBox.y + addedBox.height);
    await page.getByRole('button', { name: `${addedName} workspace menu`, exact: true }).click();
    await expect(page.locator('.workspace-menu-title')).toHaveText(addedName);
    await page.keyboard.press('Escape');

    // Switch while the composer has focus, without inserting shortcut text.
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.fill('Keep this draft');
    await page.keyboard.press(`${modifier}+Digit2`);
    await expect(composer).toHaveValue('Keep this draft');
    await page.keyboard.press(`${modifier}+Digit1`);
    await expect(workspaceButton(page)).toHaveAttribute('aria-current', 'true');
    await expect(added).not.toHaveAttribute('aria-current', 'true');
    await page.keyboard.press(`${modifier}+Shift+Digit2`);
    await expect(workspaceButton(page)).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press(`${modifier}+Digit9`);
    await expect(workspaceButton(page)).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press(`${modifier}+Digit2`);
    await expect(added).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press(`${modifier}+Digit1`);
    const menuButton = page.getByRole('button', { name: 'Sympower workspace menu', exact: true });
    await menuButton.click();
    await expect(page.locator('.workspace-menu-title')).toHaveText('Sympower');
    await expect(page.locator('.workspace-menu-summary')).toHaveText('1 scope · 0 sessions');
    await page.screenshot({ path: testInfo.outputPath('workspace-menu.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(menuButton).toBeFocused();

    await menuButton.press('Enter');
    await page.getByRole('menuitem', { name: 'Tools', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Actions…', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Sympower', exact: true });
    await expect(modal.locator('.settings-modal-nav-item.active')).toHaveText('Actions');
    await expect.poll(() => modal.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();

    await page.locator('.sidebar-toggle').click();
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(rail).toBeVisible();
    await menuButton.click();
    await page.getByRole('menuitem', { name: 'Manage scopes…', exact: true }).click();
    await expect(modal.locator('.settings-modal-nav-item.active')).toHaveText('Scopes');
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await page.keyboard.press(`${modifier}+Digit2`);
    await expect(added).toHaveAttribute('aria-current', 'true');
    await page.locator('.sidebar-toggle').click();
    await page.screenshot({ path: testInfo.outputPath('workspace-rail.png'), animations: 'disabled' });
  } finally {
    await cleanup();
    fs.rmSync(addedFolder, { recursive: true, force: true });
  }
});

test('the workspace menu opens a modal titled by the workspace; the global modal only points at it', async () => {
  test.setTimeout(60_000);
  const { page, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);

    // The front door: the workspace menu.
    await page.getByRole('button', { name: / workspace menu$/ }).click();
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
      'Updates',
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

test('the sidebar gear opens the global modal; the workspace modal commits a rename, shows the Actions panel, and Cancel on delete leaves Danger zone active', async () => {
  test.setTimeout(60_000);
  const { page, stateFile, cleanup } = await launchSeeded();
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
    await page.getByRole('button', { name: / workspace menu$/ }).click();
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
    await expect(workspaceButton(page)).toHaveAccessibleName('Sympower Renamed');
    await expect(page.getByRole('button', { name: 'Sympower Renamed workspace menu', exact: true })).toBeVisible();
    await page.getByRole('button', { name: / workspace menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    await expect(modal).toBeVisible();

    // Actions now renders the real panel; the fixture seeds one action.
    await modal.getByRole('button', { name: 'Actions', exact: true }).click();
    const actionsPanel = modal.getByTestId('actions-panel');
    await expect(actionsPanel).toBeVisible();
    await expect(actionsPanel.locator('.ws-action-name')).toHaveText('Review');

    // Finding 2b: Edit opens the row's editor; renaming and Save commit the
    // whole write, and both the row and the persisted state show it.
    await actionsPanel.getByRole('button', { name: 'Edit Review', exact: true }).click();
    const nameInput = actionsPanel.getByLabel('Action name');
    await expect(nameInput).toHaveValue('Review');
    await nameInput.fill('Review carefully');
    await actionsPanel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(actionsPanel.locator('.ws-action-name')).toHaveText('Review carefully');
    await expect
      .poll(() => actionsIn(stateFile).find((action) => action.id === 'a-review')?.name, {
        timeout: 10_000,
      })
      .toBe('Review carefully');

    // Editing again and clearing the prompt is refused client-side: the
    // inline error appears and the editor (the name input) stays mounted
    // rather than closing over the rejection.
    await actionsPanel.getByRole('button', { name: 'Edit Review carefully', exact: true }).click();
    await actionsPanel.getByLabel('Action prompt').fill('');
    await actionsPanel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(actionsPanel.getByText('An action needs a prompt.')).toBeVisible();
    await expect(actionsPanel.getByLabel('Action name')).toBeVisible();

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

test('the Groups panel makes a group without leaving Settings', async () => {
  test.setTimeout(60_000);
  const { page, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);
    await page.getByRole('button', { name: / workspace menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();

    const modal = page.getByRole('dialog');
    await modal.getByRole('button', { name: 'Groups', exact: true }).click();
    await expect(modal.locator('.ws-row-name')).toHaveCount(1);

    await modal.getByRole('button', { name: 'Add group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New group' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill('CI fixes');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog).toBeHidden();
    await expect(modal.locator('.ws-row-name')).toHaveCount(2);
    await expect(modal.locator('.ws-row-name').filter({ hasText: 'CI fixes' })).toHaveCount(1);
  } finally {
    await cleanup();
  }
});

test('an action can be pointed at a group, and says so on its row', async () => {
  test.setTimeout(60_000);
  const { page, stateFile, cleanup } = await launchSeeded();
  try {
    await holdWorkspace(page);
    await page.getByRole('button', { name: / workspace menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();

    const modal = page.getByRole('dialog');
    await modal.getByRole('button', { name: 'Actions', exact: true }).click();
    const actionsPanel = modal.getByTestId('actions-panel');
    // Nothing is routed to start with, so no row says where it lands.
    await expect(actionsPanel.locator('.ws-action-group')).toHaveCount(0);

    await actionsPanel.getByRole('button', { name: 'Edit Review', exact: true }).click();
    await actionsPanel
      .getByLabel('Group this action lands sessions in')
      .selectOption({ label: 'PR reviews' });
    await actionsPanel.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(actionsPanel.locator('.ws-action-group')).toHaveText('→ PR reviews');
    await expect
      .poll(() => actionsIn(stateFile).find((action) => action.id === 'a-review')?.groupId, {
        timeout: 10_000,
      })
      .toBe('g-reviews');

    // The group side says the same thing from the other direction.
    await modal.getByRole('button', { name: 'Groups', exact: true }).click();
    await expect(modal.locator('.ws-action-group')).toHaveText('← Review');
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
