import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandPaletteChord, launchElectron } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * The in-app browser. A page is a `<webview>` guest, so Playwright's `page`
 * sees only the host document. Everything about a guest is asserted from main
 * (`electronApp.evaluate`), and everything about the tab list through
 * `window.browserAPI` in the host, which is main's answer.
 */

const toggleChord = process.platform === 'darwin' ? 'Meta+Shift+KeyL' : 'Control+Shift+KeyL';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

interface Seeded {
  alpha: { workspaceId: string; sessionId: string };
  beta: { workspaceId: string; sessionId: string };
}

/** Two workspaces with one session each, on a stub harness that never prompts. */
async function seed(page: Page, root: string): Promise<Seeded> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  return page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'browser-test',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const make = async (name: string) => {
        const workspace = await window.workspaceAPI.createWorkspace(
          name,
          root,
          false,
          'browser-test',
        );
        const session = await window.workspaceAPI.createSession(workspace.id, {
          name: `${name} session`,
          nameIsUserSet: true,
          workspaceId: workspace.id,
          instanceId: `browser-${name}`,
          harnessId: 'browser-test',
          scopeId: workspace.scopes[0].id,
        });
        return { workspaceId: workspace.id, sessionId: session!.id };
      };
      const alpha = await make('Alpha');
      const beta = await make('Beta');
      return { alpha, beta };
    },
    { root, stub },
  );
}

async function openSession(page: Page, workspace: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: new RegExp(workspace) })
    .click();
  await page
    .locator('.session-nav-item')
    .filter({ hasText: `${workspace} session` })
    .click();
}

const globe = (page: Page) => page.getByRole('button', { name: /^(Show|Hide) browser$/ });
const panel = (page: Page) => page.getByTestId('browser-panel');
const address = (page: Page) => page.getByRole('textbox', { name: 'Address' });

async function typeAddress(page: Page, text: string): Promise<void> {
  const field = address(page);
  await field.click();
  await field.fill(text);
  await field.press('Enter');
}

interface GuestInfo {
  id: number;
  url: string;
}

/** Every `<webview>` guest main knows about. */
async function guests(app: ElectronApplication): Promise<GuestInfo[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
      .map((contents) => ({
        id: contents.id,
        url: contents.getURL(),
      })),
  );
}

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return (await guests(app)).map((guest) => guest.url);
}

/** Run a script in the one guest showing `url` (by prefix), from main. */
async function inGuest<T>(
  app: ElectronApplication,
  urlPrefix: string,
  script: string,
  userGesture = false,
): Promise<T> {
  return app.evaluate(
    ({ webContents }, { urlPrefix, script, userGesture }) => {
      const guest = webContents
        .getAllWebContents()
        .find(
          (contents) => contents.getType() === 'webview' && contents.getURL().startsWith(urlPrefix),
        );
      if (!guest) throw new Error(`no guest at ${urlPrefix}`);
      return guest.executeJavaScript(script, userGesture) as Promise<T>;
    },
    { urlPrefix, script, userGesture },
  );
}

/** Main's tab list for a session, as the host window receives it. */
function tabsOf(page: Page, sessionId: string) {
  return page.evaluate((id) => window.browserAPI.get(id), sessionId);
}

test.describe('in-app browser', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let ids: Seeded;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-'));
    ({ app, page } = await launchElectron());
    ids = await seed(page, root);
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('the globe, the chord and the palette each toggle the panel', async () => {
    await openSession(page, 'Alpha');
    await expect(globe(page)).toBeVisible();
    const initiallyOpen = await panel(page).isVisible();
    if (initiallyOpen) await globe(page).click();
    await expect(panel(page)).toHaveCount(0);

    await globe(page).click();
    await expect(panel(page)).toBeVisible();
    await globe(page).click();
    await expect(panel(page)).toHaveCount(0);

    // The chord from the terminal, where a stray key is most likely swallowed.
    await page.locator('.terminal-surface textarea').focus();
    await page.keyboard.press(toggleChord);
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press(toggleChord);
    await expect(panel(page)).toHaveCount(0);

    const viaPalette = async () => {
      await page.keyboard.press(commandPaletteChord());
      const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
      await palette.getByRole('combobox').fill('Toggle browser');
      await palette.getByRole('option', { name: /Toggle browser/ }).click();
    };
    await viaPalette();
    await expect(panel(page)).toBeVisible();
    await viaPalette();
    await expect(panel(page)).toHaveCount(0);
  });

  test('an address loads, links, Back, Forward and Reload work', async () => {
    await openSession(page, 'Alpha');
    if (!(await panel(page).isVisible())) await globe(page).click();

    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await expect(address(page)).toHaveValue(fixtures.url('/a.html'));

    // A link click inside the page, from main. It carries a user gesture, as a
    // person's click does: without one Chromium marks the page it leaves as
    // skippable and Back has nowhere to go.
    await inGuest(app, fixtures.url('/a.html'), `document.getElementById('to-b').click()`, true);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/b.html')]);
    await expect(address(page)).toHaveValue(fixtures.url('/b.html'));

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await expect(address(page)).toHaveValue(fixtures.url('/a.html'));

    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/b.html')]);

    const before = fixtures.hits('/b.html');
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect.poll(() => fixtures.hits('/b.html')).toBe(before + 1);

    // Main's tab list agrees with what the window shows.
    const snapshot = await tabsOf(page, ids.alpha.sessionId);
    expect(snapshot.tabs).toHaveLength(1);
    expect(snapshot.tabs[0].url).toBe(fixtures.url('/b.html'));
    expect(snapshot.tabs[0].canGoBack).toBe(true);
  });

  test('a page finds no Consola API and no Node', async () => {
    await openSession(page, 'Alpha');
    if (!(await panel(page).isVisible())) await globe(page).click();
    await typeAddress(page, `${fixtures.host}/probe.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/probe.html')]);

    // The probe ran (so an empty result is not just a page that never loaded).
    await expect
      .poll(() =>
        inGuest<{ ran: boolean } | undefined>(app, fixtures.url('/probe.html'), 'window.__probe'),
      )
      .toMatchObject({ ran: true });
    const probe = await inGuest<{ ran: boolean; found: string[] }>(
      app,
      fixtures.url('/probe.html'),
      'window.__probe',
    );
    expect(probe.found).toEqual([]);

    // And the host does have them, so the probe's list is not vacuous.
    const hostHas = await page.evaluate(() => typeof window.browserAPI);
    expect(hostHas).toBe('object');
  });

  test('a cookie set in one workspace is absent from another', async () => {
    await openSession(page, 'Alpha');
    if (!(await panel(page).isVisible())) await globe(page).click();
    await typeAddress(page, `${fixtures.host}/set-cookie.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/set-cookie.html')]);

    const cookiesIn = (workspaceId: string) =>
      app.evaluate(({ session }, id) => {
        return session
          .fromPartition(`persist:consola-browser-${id}`)
          .cookies.get({})
          .then((cookies) => cookies.map((cookie) => `${cookie.name}=${cookie.value}`));
      }, workspaceId);

    await expect.poll(() => cookiesIn(ids.alpha.workspaceId)).toContain('fixture=signed-in');

    await openSession(page, 'Beta');
    await expect(panel(page)).toBeVisible();
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);

    expect(await cookiesIn(ids.beta.workspaceId)).toEqual([]);
    expect(await cookiesIn(ids.alpha.workspaceId)).toContain('fixture=signed-in');
  });

  test('the palette draws over a visible page, and a page click closes a menu', async () => {
    await openSession(page, 'Alpha');
    if (!(await panel(page).isVisible())) await globe(page).click();
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);

    const pageBox = page.locator('.browser-page[data-presence="shown"]');
    await expect(pageBox).toBeVisible();
    const zOf = (selector: string) =>
      page.evaluate(
        (sel) =>
          Number.parseInt(getComputedStyle(document.querySelector(sel) as Element).zIndex, 10),
        selector,
      );
    const pageZ = await zOf('.browser-page[data-presence="shown"]');

    await page.keyboard.press(commandPaletteChord());
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await expect(palette).toBeVisible();
    expect(await zOf('.command-palette-content')).toBeGreaterThan(pageZ);

    // What is on top at the middle of the page is the palette's overlay.
    const topmost = await page.evaluate(() => {
      const rect = (
        document.querySelector('.browser-page[data-presence="shown"]') as Element
      ).getBoundingClientRect();
      const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return element?.closest('.dialog-overlay, .command-palette-content') !== null;
    });
    expect(topmost).toBe(true);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    // An open dropdown closes when the page takes focus.
    await page.getByRole('button', { name: 'Filter sessions', exact: true }).first().click();
    await expect(page.locator('.dropdown-content')).toBeVisible();
    const box = await pageBox.boundingBox();
    if (!box) throw new Error('the page has no box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('.dropdown-content')).toHaveCount(0);
  });

  test('switching workspace and back returns the page at its latest address', async () => {
    await openSession(page, 'Alpha');
    if (!(await panel(page).isVisible())) await globe(page).click();
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await typeAddress(page, `${fixtures.host}/c.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/c.html')]);

    await openSession(page, 'Beta');
    // Alpha's page is let go with its workspace; Beta has none of its own yet.
    await expect.poll(() => guestUrls(app)).toEqual([]);

    await openSession(page, 'Alpha');
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/c.html')]);
    await expect(address(page)).toHaveValue(fixtures.url('/c.html'));
  });
});

test('tabs and the address come back after a relaunch', async () => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-'));
  const first = await launchElectron();
  const ids = await seed(first.page, root);
  await openSession(first.page, 'Alpha');
  if (!(await panel(first.page).isVisible())) await globe(first.page).click();
  await typeAddress(first.page, `${fixtures.host}/b.html`);
  await expect.poll(() => guestUrls(first.app)).toEqual([fixtures.url('/b.html')]);

  // State is written about a second after the last change; closing sooner
  // would lose it, so wait for it to be on disk.
  const userData = await first.app.evaluate(({ app }) => app.getPath('userData'));
  const stateFile = path.join(userData, 'browser-state.json');
  const stateFiles = () => (fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '');
  await expect.poll(stateFiles, { timeout: 10_000 }).toContain(fixtures.url('/b.html'));
  await first.app.close();

  const second = await launchElectron({ userDataDir: first.userDataDir });
  try {
    await openSession(second.page, 'Alpha');
    if (!(await panel(second.page).isVisible())) await globe(second.page).click();
    await expect(address(second.page)).toHaveValue(fixtures.url('/b.html'));
    await expect.poll(() => guestUrls(second.app)).toEqual([fixtures.url('/b.html')]);
    const snapshot = await tabsOf(second.page, ids.alpha.sessionId);
    expect(snapshot.tabs.map((tab) => tab.url)).toEqual([fixtures.url('/b.html')]);
  } finally {
    await second.app.close();
  }
});

test('a guest paints in the hidden test window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-'));
  const { app, page } = await launchElectron();
  try {
    await seed(page, root);
    await openSession(page, 'Alpha');
    if (!(await panel(page).isVisible())) await globe(page).click();
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);

    // The fixture's background is rgb(255,0,0); the bitmap is BGRA.
    await expect
      .poll(
        () =>
          app.evaluate(async ({ webContents }) => {
            const guest = webContents
              .getAllWebContents()
              .find((contents) => contents.getType() === 'webview');
            if (!guest) return null;
            const image = await guest.capturePage();
            const { width, height } = image.getSize();
            if (width === 0 || height === 0) return null;
            const bitmap = image.toBitmap();
            const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
            return [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
          }),
        { timeout: 10_000 },
      )
      .toEqual([255, 0, 0]);
  } finally {
    await app.close();
  }
});
