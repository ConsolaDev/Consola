import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectron } from './helpers/electron';

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

test.beforeEach(async () => {
  ({ app, page, userDataDir } = await launchElectron());
});

test.afterEach(async () => {
  await app.close();
});

const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;

async function sidebarWidth(target: Page): Promise<number> {
  const box = await target.locator('.sidebar').boundingBox();
  if (!box) throw new Error('the sidebar is not on screen');
  return box.width;
}

async function headerStripWidth(target: Page): Promise<number> {
  const box = await target.locator('.app-header-sidebar').boundingBox();
  if (!box) throw new Error('the header strip is not on screen');
  return box.width;
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

test('dragging the edge resizes the sidebar and the header strip above it', async () => {
  expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH);

  await dragSidebarEdge(page, 80);

  expect(await sidebarWidth(page)).toBe(DEFAULT_WIDTH + 80);
  expect(await headerStripWidth(page)).toBe(DEFAULT_WIDTH + 80);
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
