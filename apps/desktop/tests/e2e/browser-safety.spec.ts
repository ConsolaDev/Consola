import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { showBrowser } from './helpers/browserTab';
import { launchElectron, removeProfile, settingsChord } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';
import { startTlsFixture, type TlsFixture } from './helpers/tlsFixture';

/**
 * What the in-app browser does about a page's certificate, a sign-in request
 * and the person's browsing data. A page is a `<webview>` guest Playwright
 * cannot see, so what it loaded is read from main, and the host's own controls
 * are driven as a person would.
 */

let fixtures: FixtureServer;
let tls: TlsFixture;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  tls = await startTlsFixture();
});

test.afterAll(async () => {
  await fixtures.close();
  await tls.close();
});

/** One workspace with one session, on a stub harness that never prompts. */
async function seed(page: Page, root: string): Promise<{ workspaceId: string; sessionId: string }> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  const ids = await page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'browser-test',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const workspace = await window.workspaceAPI.createWorkspace(
        'Safety',
        root,
        false,
        'browser-test',
      );
      const session = await window.workspaceAPI.createSession(workspace.id, {
        name: 'Safety session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'browser-safety',
        harnessId: 'browser-test',
        scopeId: workspace.scopes[0].id,
      });
      return { workspaceId: workspace.id, sessionId: session?.id as string };
    },
    { root, stub },
  );
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /Safety/ })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: 'Safety session' }).click();
  return ids;
}

const panel = (page: Page) => page.getByTestId('browser-panel');
const address = (page: Page) => page.getByRole('textbox', { name: 'Address' });

async function typeAddress(page: Page, text: string): Promise<void> {
  await address(page).click();
  await address(page).fill(text);
  await address(page).press('Enter');
}

function guestTitles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview')
      .map((contents) => contents.getTitle()),
  );
}

function cookiesIn(app: ElectronApplication, workspaceId: string): Promise<string[]> {
  return app.evaluate(({ session }, id) => {
    return session
      .fromPartition(`persist:consola-browser-${id}`)
      .cookies.get({})
      .then((cookies) => cookies.map((cookie) => `${cookie.name}=${cookie.value}`));
  }, workspaceId);
}

test.describe('in-app browser safety', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspaceId: string;
  let sessionId: string;
  let root: string;
  let userDataDir: string;

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-safety-'));
    ({ app, page, userDataDir } = await launchElectron());
    ({ workspaceId, sessionId } = await seed(page, root));
    await showBrowser(page);
  });

  test.afterEach(async () => {
    await app.close();
    removeProfile(userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a self-signed certificate on this machine is refused, then trusted only on request', async () => {
    await typeAddress(page, tls.url);

    const error = page.locator('.browser-error');
    await expect(error).toContainText('is not trusted');
    await expect(error).toContainText('127.0.0.1');
    await expect(error).toContainText('ERR_CERT_AUTHORITY_INVALID');
    // Refused means it did not load.
    expect(await guestTitles(app)).not.toContain('Secure');

    await error.getByRole('button', { name: 'Continue anyway' }).click();
    await expect.poll(() => guestTitles(app)).toContain('Secure');
    await expect(page.locator('.browser-error')).toHaveCount(0);

    // The approval is for this certificate: a second tab loads without asking.
    await panel(page).getByRole('button', { name: 'New tab', exact: true }).click();
    await typeAddress(page, tls.url);
    await expect
      .poll(async () => (await guestTitles(app)).filter((t) => t === 'Secure').length)
      .toBe(2);
  });

  test('clearing browsing data takes the certificate approval back', async () => {
    await typeAddress(page, tls.url);
    await page.locator('.browser-error').getByRole('button', { name: 'Continue anyway' }).click();
    await expect.poll(() => guestTitles(app)).toContain('Secure');

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Clear browsing data' }).click();
    await page.getByRole('button', { name: 'Clear browsing data', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Asked again, as if it had never been approved.
    await panel(page).getByRole('button', { name: 'New tab', exact: true }).click();
    await typeAddress(page, tls.url);
    await expect(page.locator('.browser-error')).toContainText('is not trusted');
  });

  const prompt = (page: Page) => page.getByTestId('browser-auth');

  test('a page that navigates to a sign-in shows a prompt in its tab, without taking focus, and loads with the credentials', async () => {
    await address(page).click();
    await expect(address(page)).toBeFocused();
    await address(page).fill(`${fixtures.host}/secret.html`);
    await address(page).press('Enter');

    const form = prompt(page);
    await expect(form.getByRole('heading')).toHaveText(`Sign in to ${fixtures.url('')}`);
    await expect(form).toContainText('Fixture area');
    // Keystrokes the person was typing elsewhere do not land in the prompt.
    await expect(form.getByLabel('Username')).not.toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await form.getByLabel('Username').click();
    await expect(form.getByLabel('Username')).toBeFocused();
    await form.getByLabel('Username').fill('ada');
    await form.getByLabel('Password').fill('lovelace');
    await form.getByRole('button', { name: 'Sign in' }).click();

    await expect.poll(() => guestTitles(app)).toEqual(['Secret']);
    await expect(prompt(page)).toHaveCount(0);
  });

  test('a tab opened on the protected address, a genuine first load, prompts too', async () => {
    // The page's webview is created with this address as its `src`, so the
    // load starts before anything could have been watching it.
    await page.evaluate(
      ([id, url]) => window.browserAPI.open(id, url),
      [sessionId, `${fixtures.host}/secret.html`.replace(/^/, 'http://')],
    );
    const form = prompt(page);
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Username')).not.toBeFocused();
    await form.getByLabel('Username').fill('ada');
    await form.getByLabel('Password').fill('lovelace');
    await form.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => guestTitles(app)).toEqual(['Secret']);
  });

  test('a 401 the page fetches in the background raises no prompt', async () => {
    await typeAddress(page, `${fixtures.host}/fetch-secret.html`);
    await expect.poll(() => guestTitles(app)).toEqual(['fetched:401']);
    await expect(prompt(page)).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('cancelling the sign-in leaves the page as the server answered it', async () => {
    await typeAddress(page, `${fixtures.host}/secret.html`);
    await expect(prompt(page)).toBeVisible();
    await prompt(page).getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => guestTitles(app)).toEqual(['Unauthorized']);
    await expect(prompt(page)).toHaveCount(0);
  });

  test('closing the tab takes the sign-in prompt away', async () => {
    await typeAddress(page, `${fixtures.host}/secret.html`);
    await expect(prompt(page)).toBeVisible();
    const tabId = await page.locator('.browser-page').first().getAttribute('data-tab-id');
    await page.evaluate((id) => window.browserAPI.close(id as string), tabId);
    await expect(prompt(page)).toHaveCount(0);
  });

  test('a sign-in waits for its tab to be the one shown', async () => {
    await typeAddress(page, `${fixtures.host}/secret.html`);
    await expect(prompt(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(prompt(page)).toHaveCount(0);
    await panel(page).getByRole('tab').first().click();
    await expect(prompt(page)).toBeVisible();
  });

  test('clearing browsing data forgets the sign-in, so the page asks again', async () => {
    await typeAddress(page, `${fixtures.host}/secret.html`);
    await prompt(page).getByLabel('Username').fill('ada');
    await prompt(page).getByLabel('Password').fill('lovelace');
    await prompt(page).getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => guestTitles(app)).toEqual(['Secret']);

    // Remembered: leave and come back, and it loads without asking.
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestTitles(app)).toEqual(['Page A']);
    await typeAddress(page, `${fixtures.host}/secret.html?again=1`);
    await expect.poll(() => guestTitles(app)).toEqual(['Secret']);
    await expect(prompt(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Clear browsing data' }).click();
    await page.getByRole('button', { name: 'Clear browsing data', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await typeAddress(page, `${fixtures.host}/secret.html?after=1`);
    await expect(prompt(page)).toBeVisible();
  });

  test('clearing browsing data removes a cookie, from the More menu', async () => {
    await typeAddress(page, `${fixtures.host}/set-cookie.html`);
    await expect.poll(() => cookiesIn(app, workspaceId)).toContain('fixture=signed-in');

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Clear browsing data' }).click();
    await expect(page.getByRole('dialog')).toContainText('Signs you out of every site');
    await page.getByRole('button', { name: 'Clear browsing data', exact: true }).click();

    await expect.poll(() => cookiesIn(app, workspaceId)).toEqual([]);
  });

  test('clearing browsing data removes a cookie, from workspace settings', async () => {
    await typeAddress(page, `${fixtures.host}/set-cookie.html`);
    await expect.poll(() => cookiesIn(app, workspaceId)).toContain('fixture=signed-in');

    await page.keyboard.press(settingsChord());
    const modal = page.getByRole('dialog', { name: /Settings/ });
    // The app has its own "Browser links" entry; this is the workspace's.
    await modal
      .getByRole('group', { name: /^Workspace/ })
      .getByRole('button', { name: 'Browser', exact: true })
      .click();
    await modal.getByRole('button', { name: /Clear browsing data/ }).click();
    // The confirmation is a second dialog over the settings.
    await page
      .getByRole('dialog', { name: 'Clear browsing data?' })
      .getByRole('button', { name: 'Clear browsing data', exact: true })
      .click();

    await expect.poll(() => cookiesIn(app, workspaceId)).toEqual([]);
  });

  test("the workspace's switch turns its agents' browser access off, and back on", async () => {
    // What the record says: 'off', or nothing, which means on.
    const access = () =>
      page.evaluate(async (id) => {
        const { workspaces } = await window.workspaceAPI.getSnapshot();
        return workspaces.find((candidate) => candidate.id === id)?.browserAgentAccess ?? 'on';
      }, workspaceId);

    await page.keyboard.press(settingsChord());
    const modal = page.getByRole('dialog', { name: /Settings/ });
    await modal
      .getByRole('group', { name: /^Workspace/ })
      .getByRole('button', { name: 'Browser', exact: true })
      .click();
    const toggle = modal.getByRole('switch', { name: "Let agents use this workspace's browser" });
    await expect(toggle).toBeChecked();
    expect(await access()).toBe('on');
    // When each way takes effect: off at once, on from a session's next start.
    await expect(
      modal.getByText(
        'Turning this off stops agents at once; turning it on reaches a session the next time it starts.',
        { exact: false },
      ),
    ).toBeVisible();

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(access).toBe('off');

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(access).toBe('on');
  });

  test('a page asking to capture the screen is refused without an error in main', async () => {
    await typeAddress(page, `${fixtures.host}/a.html`);
    await expect.poll(() => guestTitles(app)).toEqual(['Page A']);
    const outcome = await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
      return guest?.executeJavaScript(
        "navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'granted', (e) => e.name)",
        true,
      );
    });
    expect(outcome).not.toBe('granted');
    expect(typeof outcome).toBe('string');
  });
});
