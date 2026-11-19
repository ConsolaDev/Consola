import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * "Send a screenshot to the session": the button writes the page as a PNG
 * under the session's captures folder and pastes its path, unsubmitted, into
 * the session's terminal. A page is a `<webview>` guest Playwright cannot see,
 * so the file is read from disk and the paste from the terminal's own rows.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

/** One workspace with one session, on a stub harness that never prompts. */
async function seed(page: Page, root: string): Promise<{ workspaceId: string; sessionId: string }> {
  const stub = path.join(root, 'agent.sh');
  // The stub's terminal is raw and it copies what it is typed to a file, so the
  // test sees exactly the bytes the session's input received, Enter included.
  fs.writeFileSync(
    stub,
    `#!/bin/sh\nprintf "Agent ready\\n"\nstty raw -echo\nexec cat > "${typed(root)}"\n`,
    { mode: 0o755 },
  );
  const ids = await page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'capture-test',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const workspace = await window.workspaceAPI.createWorkspace(
        'Capture',
        root,
        false,
        'capture-test',
      );
      const session = await window.workspaceAPI.createSession(workspace.id, {
        name: 'Capture session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'browser-capture',
        harnessId: 'capture-test',
        scopeId: workspace.scopes[0].id,
      });
      return { workspaceId: workspace.id, sessionId: session.id };
    },
    { root, stub },
  );
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /Capture/ })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: 'Capture session' }).click();
  return ids;
}

/** Where the stub writes whatever the session's input receives. */
const typed = (root: string) => path.join(root, 'typed.txt');

const panel = (page: Page) => page.getByTestId('browser-panel');
const address = (page: Page) => page.getByRole('textbox', { name: 'Address' });
const sendButton = (page: Page) =>
  page.getByRole('button', { name: 'Send a screenshot to the session' });

function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
      .map((contents) => contents.getURL()),
  );
}

test.describe('screenshot to the session', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let ids: { workspaceId: string; sessionId: string };

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-capture-'));
    ({ app, page } = await launchElectron());
    ids = await seed(page, root);
    await page.getByRole('button', { name: /^(Show|Hide) browser$/ }).click();
    await expect(panel(page)).toBeVisible();
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('writes a PNG, pastes its path without submitting, and goes with the session', async () => {
    // Nothing to photograph on a blank tab.
    await expect(sendButton(page)).toBeDisabled();

    await address(page).click();
    await address(page).fill(`${fixtures.host}/a.html`);
    await address(page).press('Enter');
    await expect.poll(() => guestUrls(app)).toEqual([fixtures.url('/a.html')]);
    await expect(sendButton(page)).toBeEnabled();

    await sendButton(page).click();

    // Main appends its own suffix to the profile folder, so ask it where that is.
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    const folder = path.join(userData, 'browser-captures', ids.sessionId);
    await expect.poll(() => (fs.existsSync(folder) ? fs.readdirSync(folder).length : 0)).toBe(1);
    const [file] = fs.readdirSync(folder);
    expect(file).toMatch(/\.png$/);
    const bytes = fs.readFileSync(path.join(folder, file));
    expect(bytes.length).toBeGreaterThan(100);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // The path reaches the session's input quoted, as a bracketed paste, and
    // with no Enter after it: nothing was submitted for the person.
    const received = () => (fs.existsSync(typed(root)) ? fs.readFileSync(typed(root), 'utf8') : '');
    await expect.poll(received).toContain(`${path.join(folder, file)}"`);
    expect(received()).not.toMatch(/[\r\n]/);

    // Deleting the session removes its captures.
    await page.evaluate(
      ({ workspaceId, sessionId }) => window.workspaceAPI.deleteSession(workspaceId, sessionId),
      ids,
    );
    await expect.poll(() => fs.existsSync(folder)).toBe(false);
  });
});
