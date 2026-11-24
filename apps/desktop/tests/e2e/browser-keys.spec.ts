import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { showBrowser, sidePanelChord } from './helpers/browserTab';
import { launchElectron, removeProfile } from './helpers/electron';
import { startFixtureServer } from './helpers/fixtureServer';
import type { FixtureServer } from './helpers/fixtureServer';

/**
 * ⌘Q and ⌘W with the keyboard in the browser. A page, or a popup it opened,
 * gets its keys on its own web contents, never the window's, so main stands
 * in for the person with `sendInputEvent` on that page: a key going down and
 * coming back up. Never a held ⌘Q, and never two: the test app would quit.
 *
 * A synthetic key is not offered to the app menu the way a real one is, so
 * these show what main's guards and forwarding make of a page's key (the
 * window's hint, the tab closed), not that the menu's Quit stays put: that
 * follows from the guard taking the key, as it does in the window on main.
 */

test.skip(process.platform !== 'darwin', '⌘Q and ⌘W are macOS chords; Ctrl+Q and Ctrl+W are bytes');

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

/** One workspace with one session, on a stub harness that never prompts. Returns the session's id. */
async function seed(page: Page, root: string): Promise<string> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  const sessionId = await page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'browser-test',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const workspace = await window.workspaceAPI.createWorkspace(
        'Keys',
        root,
        false,
        'browser-test',
      );
      const session = await window.workspaceAPI.createSession(workspace.id, {
        name: 'Keys session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'browser-keys',
        harnessId: 'browser-test',
        scopeId: workspace.scopes[0].id,
      });
      return session!.id;
    },
    { root, stub },
  );
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /Keys/ })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: 'Keys session' }).click();
  return sessionId;
}

const panel = (page: Page) => page.getByTestId('browser-panel');
const address = (page: Page) => page.getByRole('textbox', { name: 'Address' });
const quitHint = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Hold ⌘Q or press twice to quit' });

async function typeAddress(page: Page, text: string): Promise<void> {
  await address(page).click();
  await address(page).fill(text);
  await address(page).press('Enter');
}

/** Main's tab list for the session, as the host window receives it. */
async function tabsOf(page: Page, sessionId: string): Promise<{ id: string; url: string }[]> {
  const snapshot = await page.evaluate((id) => window.browserAPI.get(id), sessionId);
  return snapshot.tabs.map(({ id, url }) => ({ id, url }));
}

/** Opens a tab on each address, in order; the last one is left showing. */
async function openTabs(page: Page, sessionId: string, files: string[]): Promise<void> {
  for (const [index, file] of files.entries()) {
    if (index > 0) await panel(page).getByRole('button', { name: 'New tab', exact: true }).click();
    await typeAddress(page, `${fixtures.host}${file}`);
  }
  await expect
    .poll(async () => (await tabsOf(page, sessionId)).map((tab) => tab.url))
    .toEqual(files.map((file) => fixtures.url(file)));
}

/**
 * Where the page at `url` lives, from main: a tab's guest, or a popup's own
 * window. Each helper finds it inside `app.evaluate`, which runs its function
 * in main and so cannot reach anything defined here.
 */
type Where = 'guest' | 'popup';

/** Waits until the page at `url` has finished loading. */
async function loaded(app: ElectronApplication, where: Where, url: string): Promise<void> {
  await expect
    .poll(() =>
      app.evaluate(
        ({ BrowserWindow, webContents }, args) => {
          const contents =
            args.where === 'guest'
              ? webContents
                  .getAllWebContents()
                  .find((c) => c.getType() === 'webview' && c.getURL() === args.url)
              : BrowserWindow.getAllWindows()
                  .map((window) => window.webContents)
                  .find((c) => c.getURL() === args.url);
          return !!contents && !contents.isLoading();
        },
        { where, url },
      ),
    )
    .toBe(true);
}

/** Runs `script` in the page at `url` and returns what it gives back. */
function inPage<T>(
  app: ElectronApplication,
  where: Where,
  url: string,
  script: string,
): Promise<T> {
  return app.evaluate(
    ({ BrowserWindow, webContents }, args) => {
      const contents =
        args.where === 'guest'
          ? webContents
              .getAllWebContents()
              .find((c) => c.getType() === 'webview' && c.getURL() === args.url)
          : BrowserWindow.getAllWindows()
              .map((window) => window.webContents)
              .find((c) => c.getURL() === args.url);
      if (!contents) throw new Error(`no page at ${args.url}`);
      return contents.executeJavaScript(args.script, true);
    },
    { where, url, script },
  ) as Promise<T>;
}

/**
 * Notes every key the page at `url` itself hears, starting with a plain key
 * the person types there: a page that heard nothing at all would make "it
 * never saw ⌘Q" say nothing.
 */
async function recordPageKeys(app: ElectronApplication, where: Where, url: string): Promise<void> {
  await inPage(
    app,
    where,
    url,
    `window.__keys = []; addEventListener('keydown', (e) => window.__keys.push(e.key.toLowerCase()), true); true`,
  );
  await pressInPage(app, where, url, 'A', []);
  await expect.poll(() => pageKeys(app, where, url)).toEqual(['a']);
}

function pageKeys(app: ElectronApplication, where: Where, url: string): Promise<string[]> {
  return inPage<string[]>(app, where, url, 'window.__keys');
}

/** The person presses `key` (with ⌘, unless told otherwise) in the page at `url`, once, and lets go. */
async function pressInPage(
  app: ElectronApplication,
  where: Where,
  url: string,
  key: string,
  modifiers: Array<'meta' | 'alt' | 'shift'> = ['meta'],
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow, webContents }, args) => {
      const contents =
        args.where === 'guest'
          ? webContents
              .getAllWebContents()
              .find((c) => c.getType() === 'webview' && c.getURL() === args.url)
          : BrowserWindow.getAllWindows()
              .map((window) => window.webContents)
              .find((c) => c.getURL() === args.url);
      if (!contents) throw new Error(`no page at ${args.url}`);
      contents.sendInputEvent({ type: 'keyDown', keyCode: args.key, modifiers: args.modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode: args.key, modifiers: args.modifiers });
    },
    { where, url, key, modifiers },
  );
}

/** When the person last pressed in the tab, from main (`PersonInput`). */
function lastPersonInput(app: ElectronApplication, tabId: string): Promise<number | null> {
  return app.evaluate((_electron, id) => {
    const main = globalThis as unknown as {
      __consolaTest: {
        browserAgent: { personInput: { lastInput(tabId: string): number | undefined } };
      };
    };
    return main.__consolaTest.browserAgent.personInput.lastInput(id) ?? null;
  }, tabId);
}

function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

test.describe('⌘Q and ⌘W with the keyboard in the browser', () => {
  let app: ElectronApplication;
  let page: Page;
  let sessionId: string;
  let root: string;
  let userDataDir: string;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-keys-'));
    ({ app, page, userDataDir } = await launchElectron());
    sessionId = await seed(page, root);
    await showBrowser(page);
  });

  test.afterEach(async () => {
    await app.close();
    removeProfile(userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('one ⌘Q in a page is held back: the window shows the hint and nothing quits', async () => {
    const url = fixtures.url('/a.html');
    await openTabs(page, sessionId, ['/a.html']);
    await loaded(app, 'guest', url);
    await recordPageKeys(app, 'guest', url);
    const [tab] = await tabsOf(page, sessionId);
    const before = (await lastPersonInput(app, tab.id)) ?? 0;

    await pressInPage(app, 'guest', url, 'Q');
    // The window's own guard heard it, though the key went to the page.
    await expect(quitHint(page)).toBeVisible();
    // Taken for the app, so the page never saw it, and still the person's
    // own key on the tab.
    expect(await pageKeys(app, 'guest', url)).toEqual(['a']);
    expect(await lastPersonInput(app, tab.id)).toBeGreaterThan(before);

    // Let go, it lets go; the app runs on with its window and its page.
    await expect(quitHint(page)).toBeHidden({ timeout: 5000 });
    expect(await windowCount(app)).toBe(1);
    expect(await tabsOf(page, sessionId)).toEqual([tab]);
  });

  test('⌥⌘B and ⇧⌘L in a page hide the side panel and the browser with it, and the page never hears them', async () => {
    const url = fixtures.url('/a.html');
    await openTabs(page, sessionId, ['/a.html']);
    await loaded(app, 'guest', url);
    await recordPageKeys(app, 'guest', url);
    const [tab] = await tabsOf(page, sessionId);
    const shown = page.locator(`.browser-page[data-tab-id="${tab.id}"]`);
    await expect(shown).toHaveAttribute('data-presence', 'shown');
    const before = (await lastPersonInput(app, tab.id)) ?? 0;
    const conversation = page.locator('[data-conversation-terminal] .terminal-surface textarea');
    /** The keyboard in the page, as a click in it leaves it. */
    const keyboardInPage = async () => {
      await shown.locator('webview').evaluate((webview) => (webview as HTMLElement).focus());
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('WEBVIEW');
    };

    // The side panel's chord, with the keyboard in the page. The page goes
    // with the side panel, so the keyboard goes back to the conversation,
    // never to the window's body.
    await keyboardInPage();
    await pressInPage(app, 'guest', url, 'B', ['meta', 'alt']);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(shown).toHaveAttribute('data-presence', 'hidden');
    await expect(conversation).toBeFocused();
    // Taken for the app, so the page never saw it, and still the person's
    // own key on the tab.
    expect(await pageKeys(app, 'guest', url)).toEqual(['a']);
    expect(await lastPersonInput(app, tab.id)).toBeGreaterThan(before);

    // The same chord from the window shows them again, on the same page.
    await page.keyboard.press(sidePanelChord());
    await expect(panel(page)).toBeVisible();
    await expect(shown).toHaveAttribute('data-presence', 'shown');

    // The Browser tab's own chord, in the page with its tab in front, hides it too.
    await keyboardInPage();
    await pressInPage(app, 'guest', url, 'L', ['meta', 'shift']);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(shown).toHaveAttribute('data-presence', 'hidden');
    await expect(conversation).toBeFocused();
    expect(await pageKeys(app, 'guest', url)).toEqual(['a']);
    expect(await tabsOf(page, sessionId)).toEqual([tab]);
  });

  test('⌘W in a page closes its tab and only that one, and the keyboard stays in the browser', async () => {
    await openTabs(page, sessionId, ['/a.html', '/b.html', '/c.html']);
    const [a, b, c] = await tabsOf(page, sessionId);
    await loaded(app, 'guest', c.url);
    const before = (await lastPersonInput(app, c.id)) ?? 0;

    await pressInPage(app, 'guest', c.url, 'W');
    await expect.poll(() => tabsOf(page, sessionId)).toEqual([a, b]);
    // Taken for the app, and still the person's own key on the tab.
    expect(await lastPersonInput(app, c.id)).toBeGreaterThan(before);

    // The keyboard is still in the browser: the next ⌘W closes the tab now
    // showing, and nothing else.
    const shown = await page.evaluate(
      (id) => window.browserAPI.get(id).then((snapshot) => snapshot.activeTabId),
      sessionId,
    );
    await expect(panel(page)).toBeFocused();
    await page.keyboard.press('Meta+w');
    await expect
      .poll(() => tabsOf(page, sessionId))
      .toEqual([a, b].filter((tab) => tab.id !== shown));

    // From the address bar, too.
    await address(page).click();
    await page.keyboard.press('Meta+w');
    await expect.poll(() => tabsOf(page, sessionId)).toEqual([]);

    // With no tab left, ⌘W closes nothing: never the panel, never the window.
    await page.keyboard.press('Meta+w');
    // Give a close every chance to land before saying none did.
    await page.waitForTimeout(500);
    expect(await tabsOf(page, sessionId)).toEqual([]);
    await expect(panel(page)).toBeVisible();
    expect(await windowCount(app)).toBe(1);
  });

  test('after the last browser tab, ⌘W in the browser leaves the preview panel’s file open', async () => {
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByTestId('files-tree').getByText('agent.sh', { exact: true }).click();
    const previewTabs = page.locator('.preview-tab');
    await expect(previewTabs).toHaveCount(1);
    // Files took the Browser tab's place in front of its group: bring it back,
    // then split it away, so the file is on screen beside the browser. What
    // keeps it open below is then the keyboard being in the browser, and not
    // the Files tab being out of sight.
    await showBrowser(page);
    // The side panel's tab, not one of the browser's own tabs.
    await page
      .getByRole('tablist', { name: 'Side panel tabs' })
      .getByRole('tab', { name: 'Browser', exact: true })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Split down', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await expect(previewTabs).toBeVisible();

    const url = fixtures.url('/a.html');
    await openTabs(page, sessionId, ['/a.html']);
    await loaded(app, 'guest', url);
    await pressInPage(app, 'guest', url, 'W');
    await expect.poll(() => tabsOf(page, sessionId)).toEqual([]);
    await expect(panel(page)).toBeFocused();

    // The keyboard is still in the browser, which has nothing left to close.
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(500);
    // Still open, and still on screen beside the browser.
    await expect(previewTabs).toBeVisible();
    await expect(panel(page)).toBeVisible();
  });

  test('⌘W with the browser’s More menu open closes the tab showing', async () => {
    await openTabs(page, sessionId, ['/a.html', '/b.html']);
    const [a, b] = await tabsOf(page, sessionId);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    // The menu has the keyboard, drawn outside the panel.
    await expect(page.getByRole('menu')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const focused = document.activeElement;
          return !!focused?.closest('[role="menu"]') && !focused.closest('.browser-panel');
        }),
      )
      .toBe(true);

    await page.keyboard.press('Meta+w');
    // It is still the browser's own toolbar: the tab showing closes, and only it.
    await expect.poll(() => tabsOf(page, sessionId)).toEqual([a]);
    expect(b.url).toBe(fixtures.url('/b.html'));
  });

  test('⌘W in the terminal closes no browser tab', async () => {
    await openTabs(page, sessionId, ['/a.html']);
    const tabs = await tabsOf(page, sessionId);

    await page.locator('.terminal-panel .terminal-surface').click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
      .toContain('xterm-helper-textarea');
    await page.keyboard.press('Meta+w');

    // Give a close every chance to land before saying none did.
    await page.waitForTimeout(500);
    expect(await tabsOf(page, sessionId)).toEqual(tabs);
    await expect(panel(page)).toBeVisible();
    expect(await windowCount(app)).toBe(1);
  });

  test('in a popup, ⌘Q shows the hint in its window and ⌘W closes the popup', async () => {
    const opener = fixtures.url('/opener.html');
    const popup = fixtures.url('/popup.html');
    await openTabs(page, sessionId, ['/opener.html']);
    await loaded(app, 'guest', opener);
    // A popup needs the person's press in the page: on empty page, away from
    // the fixture's link and buttons.
    await app.evaluate(({ webContents }, url) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === 'webview' && contents.getURL() === url);
      guest?.sendInputEvent({ type: 'mouseDown', x: 200, y: 250, button: 'left', clickCount: 1 });
      guest?.sendInputEvent({ type: 'mouseUp', x: 200, y: 250, button: 'left', clickCount: 1 });
    }, opener);
    await inPage(app, 'guest', opener, `document.getElementById('pop').click(); true`);
    await expect.poll(() => windowCount(app)).toBe(2);
    await loaded(app, 'popup', popup);
    await recordPageKeys(app, 'popup', popup);

    await pressInPage(app, 'popup', popup, 'Q');
    // The hint is the Consola window's, which owns the opener's tab.
    await expect(quitHint(page)).toBeVisible();
    expect(await pageKeys(app, 'popup', popup)).toEqual(['a']);
    await expect(quitHint(page)).toBeHidden({ timeout: 5000 });
    expect(await windowCount(app)).toBe(2);

    await pressInPage(app, 'popup', popup, 'W');
    await expect.poll(() => windowCount(app)).toBe(1);
    // The popup went, not the tab that opened it.
    expect((await tabsOf(page, sessionId)).map((tab) => tab.url)).toEqual([opener]);
  });
});
