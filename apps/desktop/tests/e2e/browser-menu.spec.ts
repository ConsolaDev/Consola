import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron, removeProfile } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * The browser's More menu, find bar and address suggestions. A page is a
 * `<webview>` guest Playwright cannot see, so what a page did is read from
 * main, and the host's own controls are driven as a person would.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

/** One workspace with one session, on a stub harness that never prompts. */
async function seed(page: Page, root: string): Promise<void> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  await page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'browser-test',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const workspace = await window.workspaceAPI.createWorkspace(
        'Menu',
        root,
        false,
        'browser-test',
      );
      await window.workspaceAPI.createSession(workspace.id, {
        name: 'Menu session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'browser-menu',
        harnessId: 'browser-test',
        scopeId: workspace.scopes[0].id,
      });
    },
    { root, stub },
  );
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /Menu/ })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: 'Menu session' }).click();
}

const panel = (page: Page) => page.getByTestId('browser-panel');
const address = (page: Page) => page.getByRole('textbox', { name: 'Address' });

async function showBrowser(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) {
    await page.getByRole('button', { name: /^(Show|Hide) browser$/ }).click();
  }
  await expect(panel(page)).toBeVisible();
}

async function typeAddress(page: Page, text: string): Promise<void> {
  await address(page).click();
  await address(page).fill(text);
  await address(page).press('Enter');
}

function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
      .map((contents) => contents.getURL()),
  );
}

/** The zoom level of the guest at `urlPrefix`, from main. */
function zoomLevelAt(app: ElectronApplication, urlPrefix: string): Promise<number | null> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix))
        ?.getZoomLevel() ?? null,
    urlPrefix,
  );
}

test.describe('in-app browser menu', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let userDataDir: string;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-menu-'));
    ({ app, page, userDataDir } = await launchElectron());
    await seed(page, root);
    await showBrowser(page);
  });

  test.afterEach(async () => {
    await app.close();
    removeProfile(userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('find on page reports how many matches there are', async () => {
    await typeAddress(page, `${fixtures.host}/find.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/find.html')]);

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: /Find on page/ }).click();
    const input = page.getByRole('textbox', { name: 'Find on page' });
    await expect(input).toBeFocused();
    await input.fill('needle');
    await expect(page.getByTestId('browser-find-count')).toHaveText('1 of 3');

    await input.press('Enter');
    await expect(page.getByTestId('browser-find-count')).toHaveText('2 of 3');
    await input.press('Shift+Enter');
    await expect(page.getByTestId('browser-find-count')).toHaveText('1 of 3');

    // A navigation ends the search: the count goes and the next one starts fresh.
    await input.fill('needle');
    await expect(page.getByTestId('browser-find-count')).toHaveText('1 of 3');
    await typeAddress(page, `${fixtures.host}/find2.html`);
    await expect(page.getByTestId('browser-find-count')).toHaveText('');
    await page.getByRole('textbox', { name: 'Find on page' }).click();
    await page.getByRole('textbox', { name: 'Find on page' }).press('Enter');
    await expect(page.getByTestId('browser-find-count')).toHaveText('1 of 2');
    await input.fill('absent');
    await expect(page.getByTestId('browser-find-count')).toHaveText('No matches');

    await input.press('Escape');
    await expect(page.getByTestId('browser-find')).toHaveCount(0);
  });

  test('the find chord works from the address bar', async () => {
    await typeAddress(page, `${fixtures.host}/find.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/find.html')]);
    await address(page).click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.getByRole('textbox', { name: 'Find on page' })).toBeFocused();
  });

  test('zoom changes the page and shows its level', async () => {
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await expect.poll(() => zoomLevelAt(app, fixtures.url('/a.html'))).toBe(0);

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Zoom in' }).click();
    await expect.poll(() => zoomLevelAt(app, fixtures.url('/a.html'))).toBe(0.5);
    await expect(page.getByTestId('browser-zoom-level')).toHaveText('110%');

    await page.getByRole('menuitem', { name: 'Zoom out' }).click();
    await page.getByRole('menuitem', { name: 'Zoom out' }).click();
    await expect.poll(() => zoomLevelAt(app, fixtures.url('/a.html'))).toBe(-0.5);

    await page.getByRole('menuitem', { name: 'Actual size' }).click();
    await expect.poll(() => zoomLevelAt(app, fixtures.url('/a.html'))).toBe(0);
  });

  test("zoom follows the page's host, as in Chrome, not the tab", async () => {
    const a = fixtures.url('/a.html');
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([a]);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Zoom in' }).click();
    await expect.poll(() => zoomLevelAt(app, a)).toBe(0.5);
    await page.keyboard.press('Escape');

    // A second tab on the same host starts at the level the host has.
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await typeAddress(page, `${fixtures.host}/b.html`);
    const b = fixtures.url('/b.html');
    await expect.poll(() => guestUrls(app)).toContain(b);
    // Read until Chromium has applied the host's level to the new page.
    await expect.poll(() => zoomLevelAt(app, b)).toBe(0.5);

    // Another host has its own level.
    await typeAddress(page, `localhost:${fixtures.port}/a.html`);
    await expect.poll(() => guestUrls(app)).toContain(`http://localhost:${fixtures.port}/a.html`);
    await expect.poll(() => zoomLevelAt(app, `http://localhost:${fixtures.port}/`)).toBe(0);
    await typeAddress(page, `${fixtures.host}/c.html`);
    await expect.poll(() => guestUrls(app)).toContain(fixtures.url('/c.html'));
    // And going back to the first host finds its level again.
    await expect.poll(() => zoomLevelAt(app, fixtures.url('/c.html'))).toBe(0.5);
  });

  test('the zoom chord works from the address bar', async () => {
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await address(page).click();
    await page.keyboard.press('ControlOrMeta+=');
    await expect.poll(() => zoomLevelAt(app, fixtures.url('/a.html'))).toBe(0.5);
    await page.keyboard.press('ControlOrMeta+0');
    await expect.poll(() => zoomLevelAt(app, fixtures.url('/a.html'))).toBe(0);
  });

  test('hard reload fetches the page again', async () => {
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await expect.poll(() => fixtures.hits('/a.html')).toBeGreaterThan(0);
    const before = fixtures.hits('/a.html');

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Hard reload' }).click();
    await expect.poll(() => fixtures.hits('/a.html')).toBeGreaterThan(before);
  });

  test('the address bar suggests pages visited before', async () => {
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await typeAddress(page, `${fixtures.host}/b.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/b.html')]);

    await address(page).click();
    await address(page).fill('Page A');
    const option = page.getByRole('option', { name: /Page A/ });
    await expect(option).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(1);

    await address(page).press('ArrowDown');
    await address(page).press('Enter');
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
  });
});

test("a host's zoom level is kept across a relaunch", async () => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-menu-'));
  const first = await launchElectron();
  try {
    try {
      await seed(first.page, root);
      await showBrowser(first.page);
      await typeAddress(first.page, `${fixtures.host}/a.html`);
      await expect.poll(() => guestUrls(first.app)).toEqual([fixtures.url('/a.html')]);
      await first.page.getByRole('button', { name: 'More', exact: true }).click();
      await first.page.getByRole('menuitem', { name: 'Zoom in' }).click();
      await expect.poll(() => zoomLevelAt(first.app, fixtures.url('/a.html'))).toBe(0.5);
      await first.page.keyboard.press('Escape');
      const userData = await first.app.evaluate(({ app }) => app.getPath('userData'));
      const stateFile = path.join(userData, 'browser-state.json');
      await expect
        .poll(() => (fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : ''), {
          timeout: 10_000,
        })
        .toContain(fixtures.url('/a.html'));
    } finally {
      await first.app.close();
    }

    const second = await launchElectron({ userDataDir: first.userDataDir });
    try {
      await second.page
        .getByRole('navigation', { name: 'Workspaces', exact: true })
        .getByRole('button', { name: /Menu/ })
        .click();
      await second.page.locator('.session-nav-item').filter({ hasText: 'Menu session' }).click();
      await showBrowser(second.page);
      await expect.poll(() => guestUrls(second.app)).toEqual([fixtures.url('/a.html')]);
      // Chromium keeps a host's zoom in the workspace's persistent partition.
      await expect.poll(() => zoomLevelAt(second.app, fixtures.url('/a.html'))).toBe(0.5);
    } finally {
      await second.app.close();
    }
  } finally {
    removeProfile(first.userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
