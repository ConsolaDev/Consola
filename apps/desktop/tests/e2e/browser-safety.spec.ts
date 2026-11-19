import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron, settingsChord } from './helpers/electron';
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
async function seed(page: Page, root: string): Promise<string> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  const workspaceId = await page.evaluate(
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
      await window.workspaceAPI.createSession(workspace.id, {
        name: 'Safety session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'browser-safety',
        harnessId: 'browser-test',
        scopeId: workspace.scopes[0].id,
      });
      return workspace.id;
    },
    { root, stub },
  );
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /Safety/ })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: 'Safety session' }).click();
  return workspaceId;
}

const panel = (page: Page) => page.getByTestId('browser-panel');
const address = (page: Page) => page.getByRole('textbox', { name: 'Address' });

async function showBrowser(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) {
    await page.getByRole('button', { name: /^(Show|Hide) browser$/ }).click();
  }
  await expect(panel(page)).toBeVisible();
}

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

  test.beforeEach(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-browser-safety-'));
    ({ app, page } = await launchElectron());
    workspaceId = await seed(page, root);
    await showBrowser(page);
  });

  test.afterEach(async () => {
    await app.close();
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
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
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
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await typeAddress(page, tls.url);
    await expect(page.locator('.browser-error')).toContainText('is not trusted');
  });

  test('a page that asks for a sign-in shows a dialog and loads with the credentials', async () => {
    await typeAddress(page, `${fixtures.host}/secret.html`);

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText(`Sign in to ${fixtures.url('')}`);
    await expect(dialog).toContainText('Fixture area');
    await dialog.getByLabel('Username').fill('ada');
    await dialog.getByLabel('Password').fill('lovelace');
    await dialog.getByRole('button', { name: 'Sign in' }).click();

    await expect.poll(() => guestTitles(app)).toEqual(['Secret']);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('cancelling the sign-in leaves the page as the server answered it', async () => {
    await typeAddress(page, `${fixtures.host}/secret.html`);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => guestTitles(app)).toEqual(['Unauthorized']);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('closing the tab takes the sign-in dialog away', async () => {
    await typeAddress(page, `${fixtures.host}/secret.html`);
    await expect(page.getByRole('dialog')).toBeVisible();
    // The dialog is modal, so the tab is closed the way main would be told.
    const tabId = await page.locator('.browser-page').first().getAttribute('data-tab-id');
    await page.evaluate((id) => window.browserAPI.close(id as string), tabId);
    // Main cancels the request with its page, and the window drops the dialog.
    await expect(page.getByRole('dialog')).toHaveCount(0);
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
    await modal.getByRole('button', { name: 'Browser', exact: true }).click();
    await modal.getByRole('button', { name: /Clear browsing data/ }).click();
    // The confirmation is a second dialog over the settings.
    await page
      .getByRole('dialog', { name: 'Clear browsing data?' })
      .getByRole('button', { name: 'Clear browsing data', exact: true })
      .click();

    await expect.poll(() => cookiesIn(app, workspaceId)).toEqual([]);
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
