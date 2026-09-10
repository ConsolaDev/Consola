import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron, newWindowChord } from './helpers/electron';

let app: ElectronApplication;
let page: Page;
let profile: string;
let folder: string;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const rail = (target: Page) => target.getByRole('navigation', { name: 'Workspaces', exact: true });
const button = (target: Page, name: string) => rail(target).getByRole('button', { name, exact: true });
const order = (target: Page) => rail(target).locator('.workspace-rail-item').evaluateAll(items => items.map(item => item.getAttribute('aria-label')));

async function startDrag(target: Page, from: string, to: string) {
  const source = (await button(target, from).boundingBox())!;
  const destination = (await button(target, to).boundingBox())!;
  const x = source.x + source.width / 2;
  const y = source.y + source.height / 2;
  await target.mouse.move(x, y);
  await target.mouse.down();
  await target.mouse.move(x, y + (destination.y > source.y ? 8 : -8));
  await expect(target.locator('.workspace-drag-overlay')).toBeVisible();
  await target.mouse.move(x, destination.y + destination.height / 2, { steps: 8 });
}

test.beforeEach(async () => {
  profile = createProfileDir();
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-order-'));
  ({ app, page } = await launchElectron({ userDataDir: profile }));
  await page.evaluate(async directory => {
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await window.workspaceAPI.createWorkspace(name, directory, false);
    }
  }, folder);
  await button(page, 'Alpha').click();
  await expect(button(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
});

test.afterEach(async () => {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(`${profile} Test`, { recursive: true, force: true });
  fs.rmSync(folder, { recursive: true, force: true });
});

test('dragging saves the order, renumbers shortcuts, syncs windows and survives relaunch', async ({}, testInfo) => {
  const opened = app.waitForEvent('window');
  await page.keyboard.press(newWindowChord());
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');
  await expect.poll(() => order(second)).toEqual(['Alpha', 'Beta', 'Gamma']);
  await page.bringToFront();

  await startDrag(page, 'Gamma', 'Alpha');
  await expect(page.locator('.workspace-tooltip')).toHaveCount(0);
  // Capture the settled preview after the neighboring icon has made room.
  await expect.poll(async () => (await button(page, 'Alpha').boundingBox())!.y).toBeGreaterThan(95);
  await page.screenshot({ path: testInfo.outputPath('workspace-drag.png') });
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['Gamma', 'Alpha', 'Beta']);
  await expect.poll(() => order(second)).toEqual(['Gamma', 'Alpha', 'Beta']);
  await expect(button(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  await expect(button(page, 'Gamma')).toHaveAttribute('aria-keyshortcuts', `${modifier}+1`);
  await expect(button(page, 'Alpha')).toHaveAttribute('aria-keyshortcuts', `${modifier}+2`);
  await expect(button(second, 'Beta')).toHaveAttribute('aria-keyshortcuts', `${modifier}+3`);
  await expect(page.locator('.workspace-drag-overlay')).toHaveCount(0);
  await page.mouse.move(500, 400);
  await button(page, 'Gamma').hover();
  await expect(page.locator('.workspace-tooltip-shortcut').first().locator('kbd').last()).toHaveText('1');
  await page.keyboard.press(`${modifier}+Digit1`);
  await expect(button(page, 'Gamma')).toHaveAttribute('aria-current', 'true');
  const stored = JSON.parse(fs.readFileSync(path.join(`${profile} Test`, 'workspaces.json'), 'utf8'));
  expect(stored.workspaces.map((workspace: { name: string }) => workspace.name)).toEqual(['Gamma', 'Alpha', 'Beta']);

  await second.close();
  await app.close();
  ({ app, page } = await launchElectron({ userDataDir: profile }));
  await expect.poll(() => order(page)).toEqual(['Gamma', 'Alpha', 'Beta']);
  await page.keyboard.press(`${modifier}+Digit2`);
  await expect(button(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  await startDrag(page, 'Gamma', 'Beta');
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
  await page.keyboard.press(`${modifier}+Digit3`);
  await expect(button(page, 'Gamma')).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: testInfo.outputPath('workspace-reordered.png'), animations: 'disabled' });
});

test('keyboard reordering preserves selection, can be canceled and respects reduced motion', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await button(page, 'Gamma').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.workspace-drag-overlay')).toBeVisible();
  await expect(page.locator('.workspace-drag-overlay')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.workspace-drag-overlay')).toHaveCSS('transform', 'none');
  // The keyboard sensor attaches its document listener in the next task.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status')).toHaveText('Gamma, position 2 of 3.');
  await page.keyboard.press('Space');
  await expect.poll(() => order(page)).toEqual(['Alpha', 'Gamma', 'Beta']);
  await expect(button(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  await expect(button(page, 'Gamma')).toBeFocused();
  await expect(button(page, 'Gamma')).toHaveAttribute('aria-keyshortcuts', `${modifier}+2`);
  await expect(page.locator('.workspace-drag-overlay')).toHaveCount(0);

  const before = fs.readFileSync(path.join(`${profile} Test`, 'workspaces.json'), 'utf8');
  await page.keyboard.press('Space');
  await expect(page.locator('.workspace-drag-overlay')).toBeVisible();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status')).toHaveText('Gamma, position 1 of 3.');
  await page.keyboard.press('Escape');
  await expect(page.locator('.workspace-drag-overlay')).toHaveCount(0);
  expect(await order(page)).toEqual(['Alpha', 'Gamma', 'Beta']);
  expect(fs.readFileSync(path.join(`${profile} Test`, 'workspaces.json'), 'utf8')).toBe(before);
  await button(page, 'Gamma').press('Enter');
  await expect(button(page, 'Gamma')).toHaveAttribute('aria-current', 'true');
});

test('a failed save keeps the old order and offers clear feedback', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('workspace:move');
    ipcMain.handle('workspace:move', () => { throw new Error('Disk full'); });
  });
  await startDrag(page, 'Gamma', 'Alpha');
  await page.mouse.up();
  await expect(page.getByRole('alert')).toHaveText('Could not save workspace order. Try dragging again.');
  await expect(page.locator('.workspace-drag-overlay')).toHaveCount(0);
  expect(await order(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
  await expect(button(page, 'Gamma')).toHaveAttribute('aria-keyshortcuts', `${modifier}+3`);
  await expect(button(page, 'Alpha')).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'Dismiss workspace order error' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await button(page, 'Beta').click();
  await expect(button(page, 'Beta')).toHaveAttribute('aria-current', 'true');
});
