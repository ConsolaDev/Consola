import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  type AgentWorkspace,
  closeAgentWorkspace,
  launchAgentWorkspace,
  showBrowser,
} from './helpers/agentWorkspace';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * A page that asks to stay (`beforeunload`) after the person pressed in it
 * never keeps itself: the address bar still moves it, closing its tab ends
 * it, its popup still closes, and its window still closes. Electron's own
 * default would keep the page each time, with no question and no word, so
 * each test first shows that default holding the page (with the app's answer
 * taken off the page in main), then the app's answer letting it go.
 *
 * The person is stood in for by `sendInputEvent` on the page, which leaves
 * the user activation Chromium wants before a page may ask. Nothing here can
 * raise a box: Electron asks no "Leave site?" of its own, and the app is
 * launched behind the screen guard all the same.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

const SESSION = 'Unload session';

async function typeAddress(page: Page, text: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Address' });
  await field.click();
  await field.fill(text);
  await field.press('Enter');
}

function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
      .map((contents) => contents.getURL()),
  );
}

function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** Where a page lives: a tab's guest, or a popup's own window. */
type Where = 'guest' | 'popup';

/**
 * What main does to the page at `url`. Each runs in main, so each finds the
 * page itself: a function sent to `app.evaluate` can use nothing of this file.
 */
type PageStep =
  | { kind: 'loading' }
  | { kind: 'press'; x: number; y: number }
  | { kind: 'script'; script: string; gesture: boolean }
  | { kind: 'take-answer' }
  | { kind: 'restore-answer' }
  | { kind: 'close-window' }
  | { kind: 'close-key' };

function onPage<T>(
  app: ElectronApplication,
  where: Where,
  url: string,
  step: PageStep,
): Promise<T> {
  return app.evaluate(
    ({ BrowserWindow, webContents }, args) => {
      const window =
        args.where === 'popup'
          ? BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === args.url)
          : undefined;
      const contents =
        args.where === 'guest'
          ? webContents
              .getAllWebContents()
              .find((c) => c.getType() === 'webview' && c.getURL() === args.url)
          : window?.webContents;
      if (!contents) throw new Error(`no page at ${args.url}`);
      const main = globalThis as unknown as { __unloadAnswers?: Array<() => void> };
      const step = args.step;
      switch (step.kind) {
        case 'loading':
          return contents.isLoading();
        case 'press':
          contents.sendInputEvent({
            type: 'mouseDown',
            x: step.x,
            y: step.y,
            button: 'left',
            clickCount: 1,
          });
          contents.sendInputEvent({
            type: 'mouseUp',
            x: step.x,
            y: step.y,
            button: 'left',
            clickCount: 1,
          });
          return true;
        case 'script':
          return contents.executeJavaScript(step.script, step.gesture);
        case 'take-answer':
          // The app's answer to a page asking to stay, off the page until restored.
          main.__unloadAnswers = contents.listeners('will-prevent-unload') as Array<() => void>;
          contents.removeAllListeners('will-prevent-unload');
          return true;
        case 'restore-answer':
          for (const answer of main.__unloadAnswers ?? [])
            contents.on('will-prevent-unload', answer);
          return true;
        case 'close-window':
          // As its close button does.
          window?.close();
          return true;
        case 'close-key':
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
          return true;
      }
    },
    { where, url, step },
  ) as Promise<T>;
}

/** Waits until the page at `url` exists and has finished loading. */
async function loaded(app: ElectronApplication, where: Where, url: string): Promise<void> {
  await expect
    .poll(() =>
      onPage<boolean>(app, where, url, { kind: 'loading' }).then(
        (loading) => !loading,
        () => false,
      ),
    )
    .toBe(true);
}

/**
 * The person presses in the page, away from its links and buttons, and then
 * the page asks to stay whenever it would unload.
 */
async function pressThenAskToStay(app: ElectronApplication, where: Where, url: string) {
  await onPage(app, where, url, { kind: 'press', x: 300, y: 300 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await onPage(app, where, url, {
    kind: 'script',
    script:
      "window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = 'stay'; return 'stay'; }; true",
    gesture: false,
  });
}

test.describe('a page that asks to stay', () => {
  let workspace: AgentWorkspace;
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    workspace = await launchAgentWorkspace('Unload', [SESSION]);
    ({ app, page } = workspace);
    await showBrowser(page);
  });

  test.afterEach(async () => {
    await closeAgentWorkspace(workspace);
  });

  test('still goes where the address bar sends it, and ends when its tab closes', async () => {
    const a = fixtures.url('/a.html');
    const b = fixtures.url('/b.html');
    await typeAddress(page, `${fixtures.host}/a.html`);
    await loaded(app, 'guest', a);
    await pressThenAskToStay(app, 'guest', a);

    // Electron's own default: the page stays where it is, and says nothing.
    await onPage(app, 'guest', a, { kind: 'take-answer' });
    await typeAddress(page, `${fixtures.host}/b.html`);
    await page.waitForTimeout(1_500);
    expect(await guestUrls(app)).toEqual([a]);
    await onPage(app, 'guest', a, { kind: 'restore-answer' });

    // The app's answer: it goes.
    await typeAddress(page, `${fixtures.host}/b.html`);
    await expect.poll(() => guestUrls(app)).toEqual([b]);

    // Closing its tab ends it, whatever it asks.
    await loaded(app, 'guest', b);
    await pressThenAskToStay(app, 'guest', b);
    const sessionId = workspace.sessions[SESSION];
    const [tab] = (await page.evaluate((id) => window.browserAPI.get(id), sessionId)).tabs;
    await page.evaluate((id) => window.browserAPI.close(id), tab.id);
    await expect.poll(() => guestUrls(app)).toEqual([]);
  });

  test('in a popup, still closes from its close button and from ⌘W', async () => {
    const opener = fixtures.url('/opener.html');
    const popup = fixtures.url('/popup.html');
    await typeAddress(page, `${fixtures.host}/opener.html`);
    await loaded(app, 'guest', opener);
    const openPopup = async () => {
      // A popup needs the person's press in the page.
      await onPage(app, 'guest', opener, { kind: 'press', x: 200, y: 250 });
      await onPage(app, 'guest', opener, {
        kind: 'script',
        script: "document.getElementById('pop').click(); true",
        gesture: true,
      });
      await expect.poll(() => windowCount(app)).toBe(2);
      await loaded(app, 'popup', popup);
      await pressThenAskToStay(app, 'popup', popup);
    };

    await openPopup();
    // Electron's own default: the close button closes nothing.
    await onPage(app, 'popup', popup, { kind: 'take-answer' });
    await onPage(app, 'popup', popup, { kind: 'close-window' });
    await page.waitForTimeout(1_500);
    expect(await windowCount(app)).toBe(2);
    await onPage(app, 'popup', popup, { kind: 'restore-answer' });
    // The app's answer: it closes.
    await onPage(app, 'popup', popup, { kind: 'close-window' });
    await expect.poll(() => windowCount(app)).toBe(1);

    test.skip(process.platform !== 'darwin', '⌘W closes a popup on macOS only');
    await openPopup();
    await onPage(app, 'popup', popup, { kind: 'close-key' });
    await expect.poll(() => windowCount(app)).toBe(1);
  });

  test('does not keep its window open', async () => {
    const a = fixtures.url('/a.html');
    await typeAddress(page, `${fixtures.host}/a.html`);
    await loaded(app, 'guest', a);
    await pressThenAskToStay(app, 'guest', a);

    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await expect.poll(() => windowCount(app)).toBe(0);
    expect(await guestUrls(app)).toEqual([]);
  });
});
