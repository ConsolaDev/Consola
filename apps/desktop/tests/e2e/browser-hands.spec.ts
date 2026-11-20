import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * Whose a tab is, end to end: a tab a page opens shows only when the
 * person's press caused it, an agent's move marks the tab and dots the globe,
 * and a download from a tab in the agent's hands never reaches a save dialog.
 * The agent is the session's real browser tools, put on a server of the
 * test's own in main (`__consolaTest.browserTools`); the person is stood in
 * for by `sendInputEvent`, which reaches a page as a real press does.
 *
 * No save dialog may open: every download is recorded, then cancelled by a
 * listener added after the app's, whatever the app decided.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

const DIST_INDEX = path.join(__dirname, '../../dist/main/main/index.js');

/** One workspace with one session, on a stub harness that never prompts. */
async function seed(page: Page, root: string): Promise<string> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  return page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'hands-test',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const workspace = await window.workspaceAPI.createWorkspace(
        'Alpha',
        root,
        false,
        'hands-test',
      );
      const session = await window.workspaceAPI.createSession(workspace.id, {
        name: 'Alpha session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'browser-hands-alpha',
        harnessId: 'hands-test',
        scopeId: workspace.scopes[0].id,
      });
      return session!.id;
    },
    { root, stub },
  );
}

async function openSession(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /Alpha/ })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: 'Alpha session' }).click();
}

const globe = (page: Page) => page.getByRole('button', { name: /^(Show|Hide) browser/ });
const panel = (page: Page) => page.getByTestId('browser-panel');

async function showBrowser(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) await globe(page).click();
  await expect(panel(page)).toBeVisible();
}

async function typeAddress(page: Page, text: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Address' });
  await field.click();
  await field.fill(text);
  await field.press('Enter');
}

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

/** What the host window has focused, which is where the person's keys go. */
function hostFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    return element ? `${element.tagName}.${element.className}` : 'none';
  });
}

/**
 * Runs a script in the guest at `urlPrefix`, after a press of the person's
 * there when `press` (a mouse button going down and up, away from the page's
 * links), or with nobody's press at all.
 */
async function inGuest(
  app: ElectronApplication,
  urlPrefix: string,
  script: string,
  press: boolean,
): Promise<void> {
  await app.evaluate(
    ({ webContents }, args) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(args.prefix));
      if (!guest) throw new Error(`no guest at ${args.prefix}`);
      if (args.press) {
        guest.sendInputEvent({ type: 'mouseDown', x: 300, y: 300, button: 'left', clickCount: 1 });
        guest.sendInputEvent({ type: 'mouseUp', x: 300, y: 300, button: 'left', clickCount: 1 });
      }
    },
    { prefix: urlPrefix, press },
  );
  if (press) await new Promise((resolve) => setTimeout(resolve, 200));
  await app.evaluate(
    ({ webContents }, args) => {
      const guest = webContents
        .getAllWebContents()
        .find((c) => c.getType() === 'webview' && c.getURL().startsWith(args.prefix));
      guest?.executeJavaScript(args.script).catch(() => undefined);
    },
    { prefix: urlPrefix, script },
  );
}

/** Main's globals as these tests use them. */
interface MainGlobals {
  __consolaTest: {
    browserTools: { addTo(server: unknown, sessionId: string): void };
  };
  __tool?: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;
  __downloads?: Array<{ url: string; cancelledByApp: boolean }>;
}

interface ToolAnswer {
  isError: boolean;
  text: string;
}

/** The session's browser tools on a server of the test's own in main, with a client to call them. */
async function connectAgent(app: ElectronApplication, sessionId: string): Promise<void> {
  await app.evaluate(
    async (_electron, args) => {
      const main = globalThis as unknown as MainGlobals & {
        process: { mainModule: { require(id: string): unknown } };
      };
      const { createRequire } = main.process.mainModule.require('node:module') as {
        createRequire(from: string): (id: string) => Record<string, unknown>;
      };
      const req = createRequire(args.distIndex);
      type Ctor = new (...params: unknown[]) => Record<string, (...params: unknown[]) => unknown>;
      const { McpServer } = req('@modelcontextprotocol/sdk/server/mcp.js') as { McpServer: Ctor };
      const { Client } = req('@modelcontextprotocol/sdk/client/index.js') as { Client: Ctor };
      const { InMemoryTransport } = req('@modelcontextprotocol/sdk/inMemory.js') as {
        InMemoryTransport: { createLinkedPair(): [unknown, unknown] };
      };
      const server = new McpServer({ name: 'hands-test', version: '0' });
      main.__consolaTest.browserTools.addTo(server, args.sessionId);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'hands-agent', version: '0' });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      main.__tool = async (name, toolArgs) => {
        const result = (await client.callTool({ name, arguments: toolArgs })) as {
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
        return { isError: result.isError === true, text: result.content?.[0]?.text ?? '' };
      };
    },
    { distIndex: DIST_INDEX, sessionId },
  );
}

function tool(
  app: ElectronApplication,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  return app.evaluate(
    (_electron, call) => {
      const main = globalThis as unknown as MainGlobals;
      if (!main.__tool) throw new Error('no agent connected');
      return main.__tool(call.name, call.args);
    },
    { name, args },
  );
}

/**
 * Records every download of the workspace's pages, and what the app decided
 * of it, then cancels it whatever that was: no save dialog may open.
 */
async function recordDownloads(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const main = globalThis as unknown as MainGlobals;
    if (main.__downloads) return;
    main.__downloads = [];
    const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
    if (!guest) throw new Error('no page yet');
    guest.session.on('will-download', (event, item) => {
      main.__downloads?.push({
        url: item.getURL(),
        cancelledByApp: (event as unknown as { defaultPrevented: boolean }).defaultPrevented,
      });
      event.preventDefault();
    });
  });
}

function downloads(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as unknown as MainGlobals).__downloads ?? []);
}

test.describe('whose hands a tab is in', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let sessionId: string;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-hands-'));
    ({ app, page } = await launchElectron());
    sessionId = await seed(page, root);
    await openSession(page);
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('a tab a page opens with nobody’s press opens behind, as the person’s, and neither shows the panel nor takes focus', async () => {
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/opener.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/opener.html')]);
    const opener = (await tabsOf(page, sessionId)).tabs[0];
    // The person shuts the panel; the page goes on running behind it.
    await globe(page).click();
    await expect(panel(page)).toBeHidden();
    const focus = await hostFocus(page);

    await inGuest(
      app,
      fixtures.url('/opener.html'),
      `document.getElementById('blank-link').click()`,
      false,
    );

    await expect.poll(async () => (await tabsOf(page, sessionId)).tabs.length).toBe(2);
    const after = await tabsOf(page, sessionId);
    expect(after.activeTabId).toBe(opener.id);
    expect(after.tabs[1]).toMatchObject({ url: fixtures.url('/b.html'), openedBy: 'person' });
    await expect(panel(page)).toBeHidden();
    expect(await hostFocus(page)).toBe(focus);
  });

  test('a tab an agent’s click opens is the agent’s, behind the one the person is looking at', async () => {
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/opener.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/opener.html')]);
    const opener = (await tabsOf(page, sessionId)).tabs[0];
    await connectAgent(app, sessionId);
    // More than 3 s after the person typed the address, so the agent may act.
    await page.waitForTimeout(3_100);
    const focus = await hostFocus(page);

    const read = await tool(app, 'consola_browser_snapshot', { tabId: opener.id });
    const ref = /link "new tab" \[ref=(\w+)\]/.exec(read.text)?.[1];
    expect(ref).toBeTruthy();
    const clicked = await tool(app, 'consola_browser_act', {
      tabId: opener.id,
      action: 'click',
      ref,
    });
    expect(clicked.isError).toBe(false);

    await expect.poll(async () => (await tabsOf(page, sessionId)).tabs.length).toBe(2);
    const after = await tabsOf(page, sessionId);
    expect(after.activeTabId).toBe(opener.id);
    expect(after.tabs[1]).toMatchObject({ url: fixtures.url('/b.html'), openedBy: 'agent' });
    expect(await hostFocus(page)).toBe(focus);
    // And it is the agent's to close.
    const closed = await tool(app, 'consola_browser_close', { tabId: after.tabs[1].id });
    expect(closed.isError).toBe(false);
  });

  test('an agent moving the person’s tab dots the globe while the panel is shut, and mounts nothing', async () => {
    const tab = await page.evaluate(({ id, url }) => window.browserAPI.open(id, url), {
      id: sessionId,
      url: fixtures.url('/a.html'),
    });
    await expect(globe(page)).toBeVisible();
    await expect(globe(page)).not.toHaveAttribute('data-agent-dot');
    await connectAgent(app, sessionId);

    const moved = await tool(app, 'consola_browser_navigate', {
      tabId: tab!.id,
      url: fixtures.url('/b.html'),
    });
    expect(moved.isError).toBe(false);
    await expect(globe(page)).toHaveAttribute('data-agent-dot', 'true');
    const after = (await tabsOf(page, sessionId)).tabs[0];
    expect(after).toMatchObject({ url: fixtures.url('/b.html'), live: false, agentActive: false });
    expect(await guestUrls(app)).toEqual([]);
  });

  test('a download from a tab in the agent’s hands is cancelled, then or later, until the person presses in the tab', async () => {
    await showBrowser(page);
    await typeAddress(page, `${fixtures.host}/download.html`);
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/download.html')]);
    const tab = (await tabsOf(page, sessionId)).tabs[0];
    await recordDownloads(app);
    await connectAgent(app, sessionId);
    const report = fixtures.url('/report.csv');

    // The person's own click on a download link: theirs.
    await inGuest(
      app,
      fixtures.url('/download.html'),
      `document.getElementById('dl').click()`,
      true,
    );
    await expect.poll(() => downloads(app)).toEqual([{ url: report, cancelledByApp: false }]);

    // More than 3 s on, the agent sends the tab to the file itself: cancelled.
    await page.waitForTimeout(3_100);
    expect(
      (await tool(app, 'consola_browser_navigate', { tabId: tab.id, url: report })).isError,
    ).toBe(false);
    await expect.poll(async () => (await downloads(app)).length).toBe(2);
    expect((await downloads(app))[1]).toEqual({ url: report, cancelledByApp: true });

    // The agent sends it to a page that starts a download 4 s after it loads: cancelled too.
    expect(
      (
        await tool(app, 'consola_browser_navigate', {
          tabId: tab.id,
          url: fixtures.url('/later.html'),
        })
      ).isError,
    ).toBe(false);
    await expect.poll(async () => (await downloads(app)).length, { timeout: 15_000 }).toBe(3);
    expect((await downloads(app))[2]).toEqual({ url: report, cancelledByApp: true });

    // The person presses in the tab: it is theirs again, and so is what it downloads.
    await inGuest(app, fixtures.url('/later.html'), `location.href = '/report.csv'`, true);
    await expect.poll(async () => (await downloads(app)).length).toBe(4);
    expect((await downloads(app))[3]).toEqual({ url: report, cancelledByApp: false });
  });
});
