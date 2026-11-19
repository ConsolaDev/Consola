import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * How an agent's call reaches a page (`AgentPages`, `PageDriver`), driven
 * through main's test hook (`exposeToTests('browserAgent', …)`), since the
 * MCP tools come later. A page is a `<webview>` guest that Playwright's `page`
 * cannot see: the host document shows how a page is mounted, and main shows
 * the guest itself.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

interface Seeded {
  alpha: string;
  alphaSecond: string;
}

/** Two sessions in Alpha and one in Beta, on a stub harness that never prompts. */
async function seed(page: Page, root: string): Promise<Seeded> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  return page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'driver-test',
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
          harnessId: 'driver-test',
          scopeId: workspace.scopes[0].id,
        });
        return session!.id;
      };
      const alpha = await window.workspaceAPI.createWorkspace('Alpha', root, false, 'driver-test');
      const beta = await window.workspaceAPI.createWorkspace('Beta', root, false, 'driver-test');
      await addSession(beta, 'Beta session', 'driver-beta');
      return {
        alpha: await addSession(alpha, 'Alpha session', 'driver-alpha'),
        alphaSecond: await addSession(alpha, 'Alpha second', 'driver-alpha-2'),
      };
    },
    { root, stub },
  );
}

async function openSession(page: Page, workspace: string, sessionName: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: new RegExp(workspace) })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: sessionName }).click();
}

const panel = (page: Page) => page.getByTestId('browser-panel');
const pageElement = (page: Page, tabId: string) =>
  page.locator(`.browser-page[data-tab-id="${tabId}"]`);

/** The fixture's tab in a session the person is not looking at: an address, no page. */
async function unseenTab(page: Page, seeded: Seeded): Promise<string> {
  await openSession(page, 'Alpha', 'Alpha second');
  const tab = await page.evaluate(({ sessionId, url }) => window.browserAPI.open(sessionId, url), {
    sessionId: seeded.alpha,
    url: fixtures.url('/agent.html'),
  });
  expect(tab).not.toBeNull();
  return tab!.id;
}

/** Main's globals as these tests use them: the test hook, and a call a test holds open. */
interface MainGlobals {
  __consolaTest: {
    browserAgent: {
      calls: { beginToolCall(tabId: string): Promise<{ end(): void }> };
      driver: {
        snapshot(
          tabId: string,
          options: { screenshot?: boolean },
        ): Promise<{
          outline: string;
          title: string;
          consoleErrors: Array<{ text: string }>;
          failedRequests: Array<{ url: string; reason: string }>;
          png?: Buffer;
          screenshotError?: string;
        }>;
      };
    };
  };
  __heldCall?: { end(): void };
}

/** Starts an agent call on the tab and leaves it open, as a slow tool would. */
function beginCall(app: ElectronApplication, tabId: string): Promise<void> {
  return app.evaluate(async (_electron, id) => {
    const main = globalThis as unknown as MainGlobals;
    main.__heldCall = await main.__consolaTest.browserAgent.calls.beginToolCall(id);
  }, tabId);
}

function endCall(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    (globalThis as unknown as MainGlobals).__heldCall?.end();
  });
}

interface SnapshotSeen {
  error?: string;
  outline?: string;
  title?: string;
  consoleErrors?: string[];
  failedRequests?: Array<{ url: string; reason: string }>;
  image?: { width: number; height: number; centre: number[] };
  screenshotError?: string;
  ms?: number;
}

/**
 * What the driver's snapshot of a tab says, or the error it gave. The image
 * is read in main: its size and the colour at its centre, in whatever order
 * the bitmap keeps its channels.
 */
function snapshotOf(
  app: ElectronApplication,
  tabId: string,
  screenshot = false,
): Promise<SnapshotSeen> {
  return app.evaluate(
    async ({ nativeImage }, args) => {
      const { driver } = (globalThis as unknown as MainGlobals).__consolaTest.browserAgent;
      const started = Date.now();
      try {
        const snapshot = await driver.snapshot(args.tabId, { screenshot: args.screenshot });
        let image: { width: number; height: number; centre: number[] } | undefined;
        if (snapshot.png) {
          const decoded = nativeImage.createFromBuffer(snapshot.png);
          const { width, height } = decoded.getSize();
          const bitmap = decoded.toBitmap();
          const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
          image = { width, height, centre: [...bitmap.subarray(at, at + 3)] };
        }
        return {
          outline: snapshot.outline,
          title: snapshot.title,
          consoleErrors: snapshot.consoleErrors.map((entry) => entry.text),
          failedRequests: snapshot.failedRequests.map(({ url, reason }) => ({ url, reason })),
          image,
          screenshotError: snapshot.screenshotError,
          ms: Date.now() - started,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    { tabId, screenshot },
  );
}

function guestFacts(app: ElectronApplication, urlPrefix: string) {
  return app.evaluate(({ BrowserWindow, webContents }, prefix) => {
    const guest = webContents
      .getAllWebContents()
      .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
    return {
      exists: !!guest,
      title: guest?.getTitle() ?? '',
      focused: guest?.isFocused() ?? false,
      debuggerAttached: guest?.debugger.isAttached() ?? false,
      devToolsOpen: guest?.isDevToolsOpened() ?? false,
      windowFocused: BrowserWindow.getAllWindows().some((window) => window.isFocused()),
    };
  }, urlPrefix);
}

/** `document.hasFocus()` in the page, asked by main rather than over the debugger. */
function pageHasFocus(app: ElectronApplication, urlPrefix: string): Promise<boolean> {
  return app.evaluate(({ webContents }, prefix) => {
    const guest = webContents
      .getAllWebContents()
      .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
    if (!guest) throw new Error(`no guest at ${prefix}`);
    return guest.executeJavaScript('document.hasFocus()');
  }, urlPrefix);
}

/** What has the keyboard in the host document, as a short description. */
function hostFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active ? `${active.tagName}.${active.className}` : 'none';
  });
}

test.describe('an agent call on a page', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-driver-'));
    ({ app, page } = await launchElectron());
  });

  test.afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('mounts a page nobody is looking at, keeps it painting unseen and unfocused, and reads it', async () => {
    const seeded = await seed(page, root);
    const tabId = await unseenTab(page, seeded);
    const url = fixtures.url('/agent.html');

    // Never shown: the tab has an address and no page.
    expect(
      (await page.evaluate((id) => window.browserAPI.get(id), seeded.alpha)).tabs[0],
    ).toMatchObject({ id: tabId, live: false, agentActive: false });
    expect((await guestFacts(app, url)).exists).toBe(false);
    const focusBefore = await hostFocus(page);

    await beginCall(app, tabId);
    // The window mounted it for the call: painting but unseen, and the panel stays shut.
    await expect(pageElement(page, tabId)).toHaveAttribute('data-presence', 'painting');
    await expect(panel(page)).toBeHidden();
    await expect.poll(async () => (await guestFacts(app, url)).title).toBe('Agent fixture');
    // Everything the page does as it loads happens before the agent connects.
    await expect.poll(() => fixtures.hits('/agent-missing.png')).toBe(1);
    await page.waitForTimeout(300);
    expect((await guestFacts(app, url)).debuggerAttached).toBe(false);

    const pageFocusBefore = await pageHasFocus(app, url);
    const seen = await snapshotOf(app, tabId, true);
    expect(seen.error).toBeUndefined();
    // Reading the page leaves its own sense of focus as it found it.
    expect(await pageHasFocus(app, url)).toBe(pageFocusBefore);
    expect(seen.title).toBe('Agent fixture');
    expect(seen.outline).toMatch(/heading "Agent fixture" \[level=1\] \[ref=e\d+\]/);
    expect(seen.outline).toMatch(/textbox "Name" \[ref=e\d+\]/);
    expect(seen.outline).toMatch(/button "Greet" \[ref=e\d+\]/);
    expect(seen.consoleErrors).toEqual(
      expect.arrayContaining([
        'fixture: something broke',
        expect.stringMatching(/^Uncaught Error: fixture: uncaught/),
      ]),
    );
    expect(seen.failedRequests).toEqual(
      expect.arrayContaining([
        { url: fixtures.url('/agent-missing.png'), reason: expect.stringContaining('404') },
        {
          url: 'http://127.0.0.1:9/unreachable',
          reason: expect.stringContaining('net::ERR_'),
        },
      ]),
    );
    // The page painted, though nobody could see it: the screenshot is the
    // fixture's red, not the app's near-black. In the display's colour
    // profile (sRGB red is about 234, 51, 35 in Display P3), so one strong
    // channel and two weak ones, green among them.
    expect(seen.screenshotError).toBeUndefined();
    expect(seen.image?.width).toBeGreaterThan(100);
    expect(seen.image?.height).toBeGreaterThan(100);
    const centre = seen.image?.centre ?? [];
    expect(Math.max(...centre)).toBeGreaterThan(200);
    expect(centre.filter((channel) => channel < 80)).toHaveLength(2);
    expect(centre[1]).toBeLessThan(80);
    // Well inside its bound: the page had loaded, so nothing waited out a timeout.
    expect(seen.ms).toBeLessThan(5_000);

    // Nothing took focus, and the agent is marked on the tab while it works.
    expect(await hostFocus(page)).toBe(focusBefore);
    const facts = await guestFacts(app, url);
    expect(facts.focused).toBe(false);
    expect(facts.windowFocused).toBe(false);
    expect(facts.debuggerAttached).toBe(true);
    expect(
      (await page.evaluate((id) => window.browserAPI.get(id), seeded.alpha)).tabs[0],
    ).toMatchObject({ live: true, agentActive: true });

    // Since the last snapshot: nothing new.
    const again = await snapshotOf(app, tabId);
    expect(again.consoleErrors).toEqual([]);
    expect(again.failedRequests).toEqual([]);

    // The call ends: the page stays live but stops painting, and the agent's mark goes.
    await endCall(app);
    await expect(pageElement(page, tabId)).toHaveAttribute('data-presence', 'hidden');
    expect(
      (await page.evaluate((id) => window.browserAPI.get(id), seeded.alpha)).tabs[0],
    ).toMatchObject({ live: true, agentActive: false });
    await expect(panel(page)).toBeHidden();

    // A live page that is hidden (`display: none`) is read at once: the call
    // starts before the window has it painting again, and still gets refs
    // and a painted image, since a hidden guest keeps its size.
    const hiddenRead = await snapshotOf(app, tabId, true);
    expect(hiddenRead.error).toBeUndefined();
    expect(hiddenRead.outline).toMatch(/button "Greet" \[ref=e\d+\]/);
    expect(hiddenRead.screenshotError).toBeUndefined();
    expect(Math.max(...(hiddenRead.image?.centre ?? [0]))).toBeGreaterThan(200);
    await expect(pageElement(page, tabId)).toHaveAttribute('data-presence', 'hidden');

    // A workspace no window holds has no page to give.
    await openSession(page, 'Beta', 'Beta session');
    const refused = await app.evaluate(async (_electron, id) => {
      const { calls } = (globalThis as unknown as MainGlobals).__consolaTest.browserAgent;
      try {
        (await calls.beginToolCall(id)).end();
        return 'began';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, tabId);
    expect(refused).toBe('Open this workspace in a window to use its browser.');
    // Its page went with the window, and the agent's connection with it.
    await expect.poll(async () => (await guestFacts(app, url)).exists).toBe(false);
  });

  test('DevTools on the page refuses the agent, and opening it detaches the agent', async () => {
    const seeded = await seed(page, root);
    const tabId = await unseenTab(page, seeded);
    const url = fixtures.url('/agent.html');

    const first = await snapshotOf(app, tabId);
    expect(first.error).toBeUndefined();
    expect(first.consoleErrors).toContain('fixture: something broke');
    expect((await guestFacts(app, url)).debuggerAttached).toBe(true);

    // The person opens DevTools on the page, detached as the More menu does
    // it, without activating it. (DevTools drawn into a hidden window of our
    // own fires `devtools-opened` but never counts as open, so it cannot
    // stand in for the person's.)
    await app.evaluate(({ webContents }, prefix) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
      if (!guest) throw new Error('no guest');
      guest.openDevTools({ mode: 'detach', activate: false });
    }, url);
    await expect.poll(async () => (await guestFacts(app, url)).devToolsOpen).toBe(true);
    // The person wins: the agent's attachment is gone.
    await expect.poll(async () => (await guestFacts(app, url)).debuggerAttached).toBe(false);

    const refused = await snapshotOf(app, tabId);
    expect(refused.error).toBe(
      'DevTools is open on this tab; close it to let the agent use the page.',
    );

    // Closed again, the agent can connect, and is not told twice what it was told.
    await app.evaluate(({ webContents }, prefix) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(prefix));
      guest?.closeDevTools();
    }, url);
    await expect.poll(async () => (await guestFacts(app, url)).devToolsOpen).toBe(false);
    const after = await snapshotOf(app, tabId);
    expect(after.error).toBeUndefined();
    expect(after.outline).toMatch(/button "Greet" \[ref=e\d+\]/);
    expect(after.consoleErrors).toEqual([]);
    expect(after.failedRequests).toEqual([]);
  });
});
