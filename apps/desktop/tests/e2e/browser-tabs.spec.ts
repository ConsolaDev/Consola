import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * The in-app browser's tabs: the strip, links that want a new tab, and the
 * popups a page may open. As in `browser.spec.ts`, a page is a `<webview>`
 * guest that Playwright cannot see, so guests and windows are asserted from
 * main and the tab list through `window.browserAPI` in the host.
 */

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
          instanceId: `browser-tabs-${name}`,
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
const tabs = (page: Page) => page.getByRole('tab');
const newTab = (page: Page) => page.getByRole('button', { name: 'New tab', exact: true });

async function showBrowser(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) await globe(page).click();
  await expect(panel(page)).toBeVisible();
}

async function typeAddress(page: Page, text: string): Promise<void> {
  const field = address(page);
  await field.click();
  await field.fill(text);
  await field.press('Enter');
}

/** Main's tab list for a session, as the host window receives it. */
function tabsOf(page: Page, sessionId: string) {
  return page.evaluate((id) => window.browserAPI.get(id), sessionId);
}

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
      .map((contents) => contents.getURL()),
  );
}

/**
 * Press in the guest at `urlPrefix`, then run a script in it, the way a click
 * on the page does: main hears the input, and the script runs with a gesture.
 * `press: false` runs the script alone, as a page that nobody touched would.
 */
async function inGuest(
  app: ElectronApplication,
  urlPrefix: string,
  script: string,
  press = true,
): Promise<void> {
  if (press) {
    await app.evaluate(({ webContents }, prefix) => {
      const guest = webContents
        .getAllWebContents()
        .find(
          (contents) => contents.getType() === 'webview' && contents.getURL().startsWith(prefix),
        );
      if (!guest) throw new Error(`no guest at ${prefix}`);
      // On empty page, away from the fixture pages' link and button.
      guest.sendInputEvent({ type: 'mouseDown', x: 200, y: 250, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x: 200, y: 250, button: 'left', clickCount: 1 });
    }, urlPrefix);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Not awaited inside main: a link that opens a tab replaces this page with
  // the new tab's (only the active tab has a page), and a script still
  // waiting on a page that goes away is not worth holding the call open for.
  // Read the outcome with a second call.
  await app.evaluate(
    ({ webContents }, args) => {
      const guest = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.getType() === 'webview' && contents.getURL().startsWith(args.prefix),
        );
      if (!guest) throw new Error(`no guest at ${args.prefix}`);
      guest.executeJavaScript(args.script, true).catch(() => undefined);
    },
    { prefix: urlPrefix, script },
  );
}

/** The title of the guest at `urlPrefix`, from main. */
function titleOf(app: ElectronApplication, urlPrefix: string): Promise<string> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix))
        ?.getTitle() ?? '',
    urlPrefix,
  );
}

interface PopupInfo {
  url: string;
  title: string;
  /** The popup is on the same partition as the guest that opened it. */
  samePartition: boolean;
  preferences: { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean };
  hasPreload: boolean;
}

/** Every window that is not the app's own, from main. */
function popups(app: ElectronApplication, openerUrlPrefix: string): Promise<PopupInfo[]> {
  return app.evaluate(({ BrowserWindow, webContents }, prefix) => {
    const opener = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview' && contents.getURL().startsWith(prefix));
    return BrowserWindow.getAllWindows()
      .filter((window) => /^https?:/.test(window.webContents.getURL()))
      .map((window) => {
        const preferences = window.webContents.getLastWebPreferences() ?? {};
        return {
          url: window.webContents.getURL(),
          title: window.webContents.getTitle(),
          samePartition: !!opener && window.webContents.session === opener.session,
          preferences: {
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
          },
          hasPreload: !!preferences.preload,
        };
      });
  }, openerUrlPrefix);
}

test.describe('in-app browser tabs', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let ids: Seeded;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-tabs-'));
    ({ app, page } = await launchElectron());
    ids = await seed(page, root);
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('two sessions keep separate tabs', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await newTab(page).click();
    await expect(tabs(page)).toHaveCount(2);
    await typeAddress(page, `${fixtures.host}/b.html`);
    await expect
      .poll(async () => (await tabsOf(page, ids.alpha.sessionId)).tabs.map((t) => t.url))
      .toEqual([fixtures.url('/a.html'), fixtures.url('/b.html')]);

    await openSession(page, 'Beta');
    await showBrowser(page);
    await expect(tabs(page)).toHaveCount(0);
    await typeAddress(page, `${fixtures.host}/c.html`);
    await expect(tabs(page)).toHaveCount(1);
    await expect
      .poll(async () => (await tabsOf(page, ids.beta.sessionId)).tabs.map((t) => t.url))
      .toEqual([fixtures.url('/c.html')]);

    // Alpha still has both, and Beta's page did not join them. (Main answers
    // only for the workspace the window holds, so go back first.)
    await openSession(page, 'Alpha');
    expect((await tabsOf(page, ids.alpha.sessionId)).tabs).toHaveLength(2);
    await expect(tabs(page)).toHaveCount(2);
  });

  test('the strip opens, switches and closes tabs, and stops at twelve', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);

    await newTab(page).click();
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(page).nth(1)).toContainText('New tab');
    await typeAddress(page, `${fixtures.host}/b.html`);
    await expect(tabs(page).nth(1)).toContainText('Page B');

    await tabs(page).nth(0).click();
    await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);

    // Middle-click closes, and the neighbour shows.
    await tabs(page).nth(0).click({ button: 'middle' });
    await expect(tabs(page)).toHaveCount(1);
    await expect(tabs(page).nth(0)).toContainText('Page B');
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/b.html')]);

    // Fill the session to the cap through main, as 11 more tabs.
    await page.evaluate(async (sessionId) => {
      for (let i = 0; i < 11; i += 1) await window.browserAPI.open(sessionId, '');
    }, ids.alpha.sessionId);
    await expect(tabs(page)).toHaveCount(12);
    await expect(newTab(page)).toBeDisabled();
    expect(
      await page.evaluate((id) => window.browserAPI.open(id, ''), ids.alpha.sessionId),
    ).toBeNull();

    // The close button on the active tab.
    await page.getByRole('button', { name: 'Close New tab' }).last().click();
    await expect(tabs(page)).toHaveCount(11);
    await expect(newTab(page)).toBeEnabled();
  });

  test('a target=_blank link opens a second tab in the same session', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/opener.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/opener.html')]);

    await inGuest(
      app,
      fixtures.url('/opener.html'),
      `document.getElementById('blank-link').click()`,
    );

    await expect
      .poll(async () => (await tabsOf(page, ids.alpha.sessionId)).tabs.map((t) => t.url))
      .toEqual([fixtures.url('/opener.html'), fixtures.url('/b.html')]);
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/b.html')]);
    // No window of any kind opened for it.
    expect(await popups(app, fixtures.url('/b.html'))).toEqual([]);

    // Beta, another workspace, is untouched.
    expect((await tabsOf(page, ids.beta.sessionId)).tabs).toHaveLength(0);
  });

  test('a sized popup follows a click, is hardened, and cannot open another', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/opener.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/opener.html')]);

    // A script that nobody clicked for: the page learns it was refused.
    await inGuest(
      app,
      fixtures.url('/opener.html'),
      `document.getElementById('pop').click()`,
      false,
    );
    await expect.poll(() => titleOf(app, fixtures.url('/opener.html'))).toBe('opened:false');
    expect(await popups(app, fixtures.url('/opener.html'))).toEqual([]);

    // With a click behind it, one popup opens.
    await inGuest(app, fixtures.url('/opener.html'), `document.getElementById('pop').click()`);
    await expect.poll(() => titleOf(app, fixtures.url('/opener.html'))).toBe('opened:true');
    await expect.poll(async () => (await popups(app, fixtures.url('/opener.html'))).length).toBe(1);
    // The popup tried to open a window of its own on load, and was refused.
    await expect
      .poll(async () => (await popups(app, fixtures.url('/opener.html')))[0]?.title)
      .toBe('popup:nested-denied');

    const [popup] = await popups(app, fixtures.url('/opener.html'));
    expect(popup.url).toBe(fixtures.url('/popup.html'));
    expect(popup.samePartition).toBe(true);
    expect(popup.preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(popup.hasPreload).toBe(false);
    // Still one popup, and the tab list gained nothing.
    expect(await popups(app, fixtures.url('/opener.html'))).toHaveLength(1);
    expect((await tabsOf(page, ids.alpha.sessionId)).tabs).toHaveLength(1);

    // Deleting the session takes its popup with it.
    await page.evaluate(
      ({ workspaceId, sessionId }) => window.workspaceAPI.deleteSession(workspaceId, sessionId),
      ids.alpha,
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((w) => /^https?:/.test(w.webContents.getURL()))
              .length,
        ),
      )
      .toBe(0);
  });

  test('the cap refuses a link that wants a thirteenth tab', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/opener.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/opener.html')]);
    await page.evaluate(async (sessionId) => {
      for (let i = 0; i < 11; i += 1) await window.browserAPI.open(sessionId, '');
    }, ids.alpha.sessionId);
    await expect(tabs(page)).toHaveCount(12);
    // The opener's page was replaced by the newest blank tab; show it again.
    await tabs(page).nth(0).click();
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/opener.html')]);

    await inGuest(
      app,
      fixtures.url('/opener.html'),
      `document.getElementById('blank-link').click()`,
    );
    // Give a wrongly accepted tab time to show up.
    await page.waitForTimeout(500);
    expect((await tabsOf(page, ids.alpha.sessionId)).tabs).toHaveLength(12);
  });
});
