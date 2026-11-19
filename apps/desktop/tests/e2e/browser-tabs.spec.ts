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
  /** A second session in Alpha's workspace. */
  alphaSecond: { workspaceId: string; sessionId: string };
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
      const addSession = async (
        workspace: { id: string; scopes: { id: string }[] },
        name: string,
        instanceId: string,
      ) => {
        const session = await window.workspaceAPI.createSession(workspace.id, {
          name,
          nameIsUserSet: true,
          workspaceId: workspace.id,
          instanceId,
          harnessId: 'browser-test',
          scopeId: workspace.scopes[0].id,
        });
        return session!.id;
      };
      const make = async (name: string) => {
        const workspace = await window.workspaceAPI.createWorkspace(
          name,
          root,
          false,
          'browser-test',
        );
        const sessionId = await addSession(workspace, `${name} session`, `browser-tabs-${name}`);
        return { workspace, sessionId };
      };
      const alphaMade = await make('Alpha');
      // A second session in the same workspace, to tell sessions from workspaces.
      const second = await addSession(alphaMade.workspace, 'Alpha second', 'browser-tabs-Alpha-2');
      const betaMade = await make('Beta');
      return {
        alpha: { workspaceId: alphaMade.workspace.id, sessionId: alphaMade.sessionId },
        alphaSecond: { workspaceId: alphaMade.workspace.id, sessionId: second },
        beta: { workspaceId: betaMade.workspace.id, sessionId: betaMade.sessionId },
      };
    },
    { root, stub },
  );
}

async function openSession(
  page: Page,
  workspace: string,
  sessionName = `${workspace} session`,
): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: new RegExp(workspace) })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: sessionName }).click();
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

/** The id of the guest at `urlPrefix`, from main: the same id means the same page. */
function guestIdAt(app: ElectronApplication, urlPrefix: string): Promise<number | null> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix))?.id ?? null,
    urlPrefix,
  );
}

/** A script's result in the guest at `urlPrefix`, from main. */
function readInGuest(
  app: ElectronApplication,
  urlPrefix: string,
  script: string,
): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, args) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(args.prefix));
      if (!guest) throw new Error(`no guest at ${args.prefix}`);
      return guest.executeJavaScript(args.script, true);
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
  preferences: {
    sandbox?: boolean;
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    webSecurity?: boolean;
  };
  hasPreload: boolean;
  /** What the window itself is, which a page's `window.open` features must not change. */
  chrome: {
    title: string;
    hasFrame: boolean;
    closable: boolean;
    movable: boolean;
    alwaysOnTop: boolean;
    modal: boolean;
    hasParent: boolean;
    withinDisplay: boolean;
  };
}

/** Every window that is not the app's own, from main. */
function popups(app: ElectronApplication, openerUrlPrefix: string): Promise<PopupInfo[]> {
  return app.evaluate(({ BrowserWindow, screen, webContents }, prefix) => {
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
            webSecurity: preferences.webSecurity,
          },
          hasPreload: !!preferences.preload,
          chrome: {
            title: window.getTitle(),
            // A frameless window's content fills its bounds.
            hasFrame: window.getBounds().height > window.getContentBounds().height,
            closable: window.isClosable(),
            movable: window.isMovable(),
            alwaysOnTop: window.isAlwaysOnTop(),
            modal: window.isModal(),
            hasParent: window.getParentWindow() !== null,
            withinDisplay: (() => {
              const bounds = window.getBounds();
              const area = screen.getDisplayMatching(bounds).workArea;
              return bounds.width <= area.width && bounds.height <= area.height;
            })(),
          },
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

    // Another session of the SAME workspace starts with none of Alpha's tabs.
    await openSession(page, 'Alpha', 'Alpha second');
    await showBrowser(page);
    await expect(tabs(page)).toHaveCount(0);
    expect((await tabsOf(page, ids.alphaSecond.sessionId)).tabs).toHaveLength(0);
    await typeAddress(page, `${fixtures.host}/c.html`);
    await expect(tabs(page)).toHaveCount(1);
    await expect
      .poll(async () => (await tabsOf(page, ids.alphaSecond.sessionId)).tabs.map((t) => t.url))
      .toEqual([fixtures.url('/c.html')]);

    // Back in the first session: its two tabs, and the second session's page
    // did not join them. The lists differ in main too.
    await openSession(page, 'Alpha');
    await expect(tabs(page)).toHaveCount(2);
    expect((await tabsOf(page, ids.alpha.sessionId)).tabs.map((t) => t.url)).toEqual([
      fixtures.url('/a.html'),
      fixtures.url('/b.html'),
    ]);
    expect((await tabsOf(page, ids.alphaSecond.sessionId)).tabs.map((t) => t.url)).toEqual([
      fixtures.url('/c.html'),
    ]);
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
    // The page of the tab left behind stays alive: main unloads by time and
    // count, not by which tab is active.
    await expect
      .poll(async () => (await guestUrls(app)).sort())
      .toEqual([fixtures.url('/a.html'), fixtures.url('/b.html')]);

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

  test('switching between two tabs keeps both pages alive, not reloaded', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    const firstId = await guestIdAt(app, fixtures.url('/a.html'));
    // State only this load of the page has.
    await readInGuest(app, fixtures.url('/a.html'), `window.__kept = 'still here'`);
    const loads = fixtures.hits('/a.html');

    await newTab(page).click();
    await typeAddress(page, `${fixtures.host}/b.html`);
    await expect(tabs(page).nth(1)).toContainText('Page B');
    await expect
      .poll(async () => (await guestUrls(app)).sort())
      .toEqual([fixtures.url('/a.html'), fixtures.url('/b.html')]);
    const secondId = await guestIdAt(app, fixtures.url('/b.html'));

    // Back and forth, each time landing on the page that was left running.
    for (const index of [0, 1, 0]) {
      await tabs(page).nth(index).click();
      await expect(tabs(page).nth(index)).toHaveAttribute('aria-selected', 'true');
    }
    await page.waitForTimeout(500);

    expect(await guestIdAt(app, fixtures.url('/a.html'))).toBe(firstId);
    expect(await guestIdAt(app, fixtures.url('/b.html'))).toBe(secondId);
    expect(await readInGuest(app, fixtures.url('/a.html'), `window.__kept`)).toBe('still here');
    expect(fixtures.hits('/a.html')).toBe(loads);
    const snapshot = await tabsOf(page, ids.alpha.sessionId);
    expect(snapshot.tabs.map((t) => t.live)).toEqual([true, true]);
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
    await expect
      .poll(async () => (await guestUrls(app)).sort())
      .toEqual([fixtures.url('/b.html'), fixtures.url('/opener.html')]);
    // No window of any kind opened for it.
    expect(await popups(app, fixtures.url('/b.html'))).toEqual([]);

    // Another session of the same workspace gained nothing.
    expect((await tabsOf(page, ids.alphaSecond.sessionId)).tabs).toHaveLength(0);
  });

  test('a page cannot style its popup: frame, size, stacking and modality stay the app’s', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/opener.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/opener.html')]);

    await inGuest(app, fixtures.url('/opener.html'), `document.getElementById('evil').click()`);
    await expect.poll(async () => (await popups(app, fixtures.url('/opener.html'))).length).toBe(1);
    await expect
      .poll(async () => (await popups(app, fixtures.url('/opener.html')))[0]?.title)
      .toBe('popup:nested-denied');

    const [popup] = await popups(app, fixtures.url('/opener.html'));
    expect(popup.chrome).toMatchObject({
      hasFrame: true,
      closable: true,
      movable: true,
      alwaysOnTop: false,
      modal: false,
      hasParent: true,
      withinDisplay: true,
    });
    // It names the site, not what the page called itself.
    expect(popup.chrome.title).toBe(`${new URL(fixtures.url('/')).origin} — popup:nested-denied`);
    // Asking for node access, no sandbox or no web security changes nothing.
    expect(popup.preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
    expect(popup.hasPreload).toBe(false);

    // One popup at a time: a second click while it is open opens nothing.
    await readInGuest(app, fixtures.url('/opener.html'), `document.title = 'reset'`);
    // (A different window name: the same one would just reuse the open popup.)
    await inGuest(app, fixtures.url('/opener.html'), `document.getElementById('pop2').click()`);
    await expect.poll(() => titleOf(app, fixtures.url('/opener.html'))).toBe('opened:false');
    expect(await popups(app, fixtures.url('/opener.html'))).toHaveLength(1);
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

  test('at most eight pages stay live: the least recently shown is unloaded, and reloads when shown', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    // Pages, not blank tabs: a blank tab hosts no page until it has an address.
    await page.evaluate(
      async ({ sessionId, url }) => {
        for (let i = 0; i < 11; i += 1) await window.browserAPI.open(sessionId, url);
      },
      { sessionId: ids.alpha.sessionId, url: fixtures.url('/b.html') },
    );
    await expect(tabs(page)).toHaveCount(12);

    // Twelve tabs, eight pages: the first tab was shown longest ago, so its
    // page is gone while its tab (and address) remain.
    await expect.poll(async () => (await guestUrls(app)).length).toBe(8);
    expect(await guestUrls(app)).not.toContain(fixtures.url('/a.html'));
    const first = (await tabsOf(page, ids.alpha.sessionId)).tabs[0];
    expect(first.url).toBe(fixtures.url('/a.html'));
    expect(first.live).toBe(false);

    await tabs(page).nth(0).click();
    await expect.poll(() => guestUrls(app)).toContain(fixtures.url('/a.html'));
    await expect.poll(async () => (await guestUrls(app)).length).toBe(8);
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
    // Twelve pages would be over the live cap, so the opener's was unloaded
    // for the newer ones; showing it again reloads it.
    await tabs(page).nth(0).click();
    await expect
      .poll(() => guestUrls(app))
      .toEqual(expect.arrayContaining([fixtures.url('/opener.html')]));

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
