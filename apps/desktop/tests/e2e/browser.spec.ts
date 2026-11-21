import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandPaletteChord, launchElectron, removeProfile } from './helpers/electron';
import { browserChord, showBrowser, sidePanelChord } from './helpers/browserTab';
import { type FixtureServer, PROBE_SCRIPT, startFixtureServer } from './helpers/fixtureServer';

/**
 * The in-app browser. A page is a `<webview>` guest, so Playwright's `page`
 * sees only the host document. Everything about a guest is asserted from main
 * (`electronApp.evaluate`), and everything about the tab list through
 * `window.browserAPI` in the host, which is main's answer.
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
  let userDataDir: string;
  let ids: Seeded;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-'));
    ({ app, page, userDataDir } = await launchElectron());
    ids = await seed(page, root);
  });

  test.afterEach(async () => {
    await app.close();
    removeProfile(userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the "+" list, the chord and the palette each open the Browser tab, and the chord hides it', async () => {
    await openSession(page, 'Alpha');
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    await page
      .getByRole('listbox', { name: 'Open in this tab' })
      .getByRole('option', { name: /^Browser/ })
      .click();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // The chord from the conversation, where a stray key is most likely swallowed.
    await page.locator('[data-conversation-terminal] .terminal-surface textarea').focus();
    await page.keyboard.press(browserChord());
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await page.keyboard.press(browserChord());
    await expect(panel(page)).toBeVisible();

    // The palette opens it, and opening it again leaves it open.
    await page.keyboard.press(browserChord());
    await expect(panel(page)).toHaveCount(0);
    const viaPalette = async () => {
      await page.keyboard.press(commandPaletteChord());
      const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
      await palette.getByRole('combobox').fill('Open Browser');
      await palette.getByRole('option', { name: /^Open Browser/ }).click();
    };
    await viaPalette();
    await expect(panel(page)).toBeVisible();
    await viaPalette();
    await expect(panel(page)).toBeVisible();
  });

  test('an address loads, links, Back, Forward and Reload work', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);

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
    await showBrowser(page);
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

    // The same script in the host window finds the bridge there, so an empty
    // list from the page means the page has none, not that the probe is blind.
    const inHost = await page.evaluate(`(() => {
      const title = document.title;
      ${PROBE_SCRIPT}
      document.title = title;
      const probe = window.__probe;
      delete window.__probe;
      return probe;
    })()`);
    expect(inHost).toMatchObject({ ran: true, found: expect.arrayContaining(['browserAPI']) });
  });

  test('a cookie set in one workspace is absent from another', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
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

  test('the palette draws over a visible page, and a page taking focus closes a menu', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
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
    // The host closes menus by dispatching a synthetic pointerdown when the
    // page takes focus. Record untrusted ones, so the menu closing is tied to
    // that path and not to Radix reacting to the click or focus change itself.
    await page.evaluate(() => {
      const w = window as unknown as { __syntheticPointerDowns: number };
      w.__syntheticPointerDowns = 0;
      document.addEventListener(
        'pointerdown',
        (event) => {
          if (!event.isTrusted) w.__syntheticPointerDowns += 1;
        },
        true,
      );
    });
    // In the hidden test window a guest never gains real window focus, so
    // neither a mouse click nor `focus()` makes the `<webview>` element emit
    // its `focus` event (checked: activeElement becomes the webview, no event).
    // Emit it the way the tag does when the guest takes focus; this guards the
    // wiring from that event to closing the app's menus.
    await page.evaluate(() => {
      document.querySelector('webview')?.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('.dropdown-content')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __syntheticPointerDowns: number }).__syntheticPointerDowns,
      ),
    ).toBeGreaterThan(0);
  });

  test('a drag across a page lets the pointer through, and only while it lasts', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    const host = page.locator('.browser-host');
    const shown = page.locator('.browser-page[data-presence="shown"]');
    await expect(shown).toBeVisible();
    const pointerEvents = () =>
      shown.evaluate((element) => getComputedStyle(element).pointerEvents);
    expect(await pointerEvents()).toBe('auto');
    await expect(host).not.toHaveAttribute('data-dragging');

    // The person takes the side panel's edge, which lies against the page.
    const separator = page.locator('.resize-handle:has(+ [data-testid="side-panel"])');
    const width = async () => (await panel(page).boundingBox())?.width ?? 0;
    const grab = async () => {
      const box = await separator.boundingBox();
      if (!box) throw new Error('no separator before the side panel');
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      return at;
    };
    // First wider, over the terminal, so the drag over the page has room to shrink it.
    const start = await grab();
    await page.mouse.move(start.x - 200, start.y, { steps: 4 });
    await page.mouse.up();
    const before = await width();

    const at = await grab();
    await expect(host).toHaveAttribute('data-dragging', '');
    expect(await pointerEvents()).toBe('none');
    // Dragged over the page, the edge keeps following the pointer.
    await page.mouse.move(at.x + 150, at.y, { steps: 8 });
    await expect.poll(width).toBeLessThan(before - 100);
    await page.mouse.up();
    await expect(host).not.toHaveAttribute('data-dragging');
    expect(await pointerEvents()).toBe('auto');
  });

  test('switching workspace and back returns the page at its latest address', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
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

  test('the Browser tab keeps its page when it goes behind and when the side panel hides', async () => {
    await openSession(page, 'Alpha');
    await showBrowser(page);
    const url = fixtures.url('/a.html');
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestUrls(app)).toEqual([url]);
    const [guest] = await guests(app);
    await inGuest(app, url, 'window.__kept = 1');
    await page.evaluate(() => {
      (window as unknown as { __page?: Element | null }).__page =
        document.querySelector('.browser-page webview');
    });
    const presence = () => page.locator('.browser-page').getAttribute('data-presence');
    /**
     * The same element, the same guest, and a page that never reloaded. A
     * page shown is drawn exactly over its slot: without a slot to anchor to
     * it would cover the whole window, and still be the same page.
     */
    const untouched = async () => {
      expect(
        await page.evaluate(() => {
          const kept = (window as unknown as { __page?: Element | null }).__page;
          return !!kept?.isConnected && document.querySelector('.browser-page webview') === kept;
        }),
      ).toBe(true);
      expect((await guests(app)).map((each) => each.id)).toEqual([guest.id]);
      expect(await inGuest(app, url, 'window.__kept')).toBe(1);
      if ((await presence()) !== 'shown') return;
      const drawn = (await page.locator('.browser-page').boundingBox())!;
      const slot = (await page.getByTestId('browser-slot').boundingBox())!;
      for (const side of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(drawn[side] - slot[side]), side).toBeLessThanOrEqual(2);
      }
    };
    expect((await page.getByTestId('browser-slot').boundingBox())!.height).toBeGreaterThan(200);

    // Behind another tab: the panel unmounts, and the page only hides.
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(presence).toBe('hidden');
    await untouched();

    await page.getByRole('tab', { name: 'Browser', exact: true }).click();
    await expect.poll(presence).toBe('shown');
    await untouched();

    // The side panel hidden and shown again.
    await page.keyboard.press(sidePanelChord());
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect.poll(presence).toBe('hidden');
    await untouched();
    await page.keyboard.press(sidePanelChord());
    await expect.poll(presence).toBe('shown');
    await untouched();

    // Another session of the same workspace, whose own Browser tab takes the
    // slot, and back: the page is hidden meanwhile, never ended.
    await page.evaluate(
      async ({ workspaceId }) => {
        const { workspaces } = await window.workspaceAPI.getSnapshot();
        const workspace = workspaces.find((each) => each.id === workspaceId)!;
        await window.workspaceAPI.createSession(workspaceId, {
          name: 'Alpha second',
          nameIsUserSet: true,
          workspaceId,
          instanceId: 'browser-Alpha-2',
          harnessId: 'browser-test',
          scopeId: workspace.scopes[0].id,
        });
      },
      { workspaceId: ids.alpha.workspaceId },
    );
    await page.locator('.session-nav-item').filter({ hasText: 'Alpha second' }).click();
    await expect(panel(page)).toBeVisible();
    await expect.poll(presence).toBe('hidden');
    await untouched();
    await openSession(page, 'Alpha');
    await expect.poll(presence).toBe('shown');
    await untouched();

    // Split away from Files: the page follows its tab into the new group.
    const tabs = (list: string) => page.getByRole('tablist', { name: list, exact: true });
    const browserTab = (list: string) => tabs(list).getByRole('tab', { name: 'Browser' });
    await browserTab('Side panel tabs').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Split down', exact: true }).click();
    await expect(tabs('Top group tabs').getByRole('tab')).toHaveText(['Files']);
    await expect(tabs('Bottom group tabs').getByRole('tab')).toHaveText(['Browser']);
    await expect.poll(presence).toBe('shown');
    await untouched();

    // Files' group fills the panel and hides Browser's: the page only hides.
    const filesGroup = page.locator('.side-panel-group').filter({ has: tabs('Top group tabs') });
    await filesGroup.getByRole('button', { name: 'Maximize group' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(presence).toBe('hidden');
    await untouched();
    await filesGroup.getByRole('button', { name: 'Restore group' }).click();
    await expect.poll(presence).toBe('shown');
    await untouched();

    // Back beside Files, at the end of its bar.
    await browserTab('Bottom group tabs').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to other group', exact: true }).click();
    await expect(tabs('Side panel tabs').getByRole('tab')).toHaveText(['Files', 'Browser']);
    await expect.poll(presence).toBe('shown');
    await untouched();
  });
});

test('tabs and the address come back after a relaunch', async () => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-'));
  const first = await launchElectron();
  try {
    let ids: Seeded;
    try {
      ids = await seed(first.page, root);
      await openSession(first.page, 'Alpha');
      await showBrowser(first.page);
      await typeAddress(first.page, `${fixtures.host}/b.html`);
      await expect.poll(() => guestUrls(first.app)).toEqual([fixtures.url('/b.html')]);

      // State is written about a second after the last change; closing sooner
      // would lose it, so wait for it to be on disk.
      const userData = await first.app.evaluate(({ app }) => app.getPath('userData'));
      const stateFile = path.join(userData, 'browser-state.json');
      const stateFiles = () => (fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '');
      await expect.poll(stateFiles, { timeout: 10_000 }).toContain(fixtures.url('/b.html'));
    } finally {
      await first.app.close();
    }

    const second = await launchElectron({ userDataDir: first.userDataDir });
    try {
      await openSession(second.page, 'Alpha');
      await showBrowser(second.page);
      await expect(address(second.page)).toHaveValue(fixtures.url('/b.html'));
      await expect.poll(() => guestUrls(second.app)).toEqual([fixtures.url('/b.html')]);
      const snapshot = await tabsOf(second.page, ids.alpha.sessionId);
      expect(snapshot.tabs.map((tab) => tab.url)).toEqual([fixtures.url('/b.html')]);
    } finally {
      await second.app.close();
    }
  } finally {
    removeProfile(first.userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a guest paints in the hidden test window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-'));
  const { app, page, userDataDir } = await launchElectron();
  try {
    await seed(page, root);
    await openSession(page, 'Alpha');
    await showBrowser(page);
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
            // Under load the compositor can fail a capture once
            // (UnknownVizError): that one is tried again, a few times at most.
            const capture = async (): Promise<Electron.NativeImage> => {
              for (let attempt = 1; ; attempt += 1) {
                try {
                  return await guest.capturePage();
                } catch (error) {
                  if (attempt >= 3 || !String(error).includes('UnknownVizError')) throw error;
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
              }
            };
            const image = await capture();
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
    removeProfile(userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
