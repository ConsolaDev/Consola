import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron, removeProfile, settingsChord } from './helpers/electron';
import { type FixtureServer, startFixtureServer } from './helpers/fixtureServer';

/**
 * Links clicked in a session's terminal. A real click on a link printed in the
 * session's shell goes through xterm's own link provider and the app's
 * `openTerminalLink`, so the Shift key is the one the browser gives xterm.
 * The system browser is never opened: main's `shell.openExternal` is replaced
 * with a recorder before any click.
 */

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

const panel = (page: Page) => page.getByTestId('browser-panel');

async function seed(page: Page, root: string): Promise<{ workspaceId: string; sessionId: string }> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  return page.evaluate(
    async ({ root, stub }) => {
      await window.harnessStateAPI.addHarness({
        id: 'links-test',
        driverId: 'claude',
        name: 'Stub',
        binaryPath: stub,
        accentColor: '#555555',
      });
      const workspace = await window.workspaceAPI.createWorkspace(
        'Links',
        root,
        false,
        'links-test',
      );
      const session = await window.workspaceAPI.createSession(workspace.id, {
        name: 'Links session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'links-a',
        harnessId: 'links-test',
        scopeId: workspace.scopes[0].id,
      });
      return { workspaceId: workspace.id, sessionId: session!.id };
    },
    { root, stub },
  );
}

/** Replace the OS-browser hand-off in main with a recorder. */
async function recordSystemOpens(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __systemOpens?: string[] }).__systemOpens = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

function systemOpens(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [
    ...((globalThis as { __systemOpens?: string[] }).__systemOpens ?? []),
  ]);
}

/** Print `url` in the session's shell and return the row that shows it. */
async function printLink(page: Page, url: string): Promise<Locator> {
  const shell = page.getByTestId('session-shell');
  // The URL is assembled by printf, so the echoed command line never holds it
  // whole and only the printed line is a link.
  const at = url.indexOf('//') + 2;
  await shell
    .locator('textarea')
    .pressSequentially(`printf '%s%s\\n' '${url.slice(0, at)}' '${url.slice(at)}'`);
  await page.keyboard.press('Enter');
  const row = shell.locator('.xterm-rows > div').filter({ hasText: url }).last();
  await expect(row).toBeVisible();
  return row;
}

async function clickLink(page: Page, row: Locator, shift: boolean): Promise<void> {
  // The row is only the DOM renderer's text; xterm's screen layer sits over it
  // and takes the pointer, so click at the row's coordinates like a person's
  // mouse does. xterm finds a link on mouse move, so move there first.
  // Opening the browser panel narrows the terminal and xterm reflows it, so
  // wait for the row to stop moving before aiming at it.
  let previous = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await row.boundingBox());
      const settled = now === previous;
      previous = now;
      return settled;
    })
    .toBe(true);
  const box = await row.boundingBox();
  if (!box) throw new Error('the link row has no box');
  const x = box.x + 24;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 5, y);
  await page.mouse.move(x, y);
  if (shift) await page.keyboard.down('Shift');
  try {
    await page.mouse.down();
    await page.mouse.up();
  } finally {
    if (shift) await page.keyboard.up('Shift');
  }
}

test.describe('terminal links and the session browser', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let userDataDir: string;
  let ids: { workspaceId: string; sessionId: string };

  test.beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-links-'));
    ({ app, page, userDataDir } = await launchElectron());
    // The shell is the side panel's Terminal tab, a narrower column than the
    // conversation's. A wider window keeps each printed link on one row,
    // which `printLink` finds it by, with the browser open beside it too.
    const appWindow = await app.browserWindow(page);
    await appWindow.evaluate((browserWindow) => browserWindow.setContentSize(1400, 800));
    ids = await seed(page, root);
    await recordSystemOpens(app);
    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Links/ })
      .click();
    await page.locator('.session-nav-item').filter({ hasText: 'Links session' }).click();
    await page.locator('.terminal-surface textarea').focus();
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('session-shell')).toBeVisible();
    await expect(page.locator('.shell-directory')).toBeVisible();
  });

  test.afterEach(async () => {
    await app.close();
    removeProfile(userDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a local link opens in the session browser, Shift sends it to the system, and an outside link goes out', async () => {
    const local = fixtures.url('/a.html');
    await expect(panel(page)).toHaveCount(0);

    const row = await printLink(page, local);
    await clickLink(page, row, false);
    await expect(panel(page)).toBeVisible();
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.browserAPI.get(id), ids.sessionId)).tabs.map(
          (tab) => tab.url,
        ),
      )
      .toEqual([local]);
    expect(await systemOpens(app)).toEqual([]);

    // Shift is the other way, for this click only.
    await clickLink(page, row, true);
    await expect.poll(() => systemOpens(app)).toEqual([local]);
    const tabs = await page.evaluate((id) => window.browserAPI.get(id), ids.sessionId);
    expect(tabs.tabs).toHaveLength(1);

    // Under "local", an address that is not on this machine leaves Consola.
    const outside = 'https://example.com/docs';
    const outsideRow = await printLink(page, outside);
    await clickLink(page, outsideRow, false);
    await expect.poll(() => systemOpens(app)).toEqual([local, outside]);
  });

  test('"Every link opens in the system browser" sends a local link out, and Shift brings it back', async () => {
    await page.keyboard.press(settingsChord());
    const modal = page.getByRole('dialog', { name: 'Settings', exact: true });
    await modal
      .getByRole('group', { name: 'App', exact: true })
      .getByRole('button', { name: 'Browser links', exact: true })
      .click();
    await expect(modal.getByText('Hold Shift while you click', { exact: false })).toBeVisible();
    const rules = modal.getByRole('radiogroup', { name: 'Terminal links' });
    await expect(
      rules.getByRole('radio', { name: 'Local addresses open in Consola' }),
    ).toHaveAttribute('aria-checked', 'true');
    await rules.getByRole('radio', { name: 'Every link opens in the system browser' }).click();
    await expect(
      rules.getByRole('radio', { name: 'Every link opens in the system browser' }),
    ).toHaveAttribute('aria-checked', 'true');
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();

    const local = fixtures.url('/b.html');
    const row = await printLink(page, local);
    await clickLink(page, row, false);
    await expect.poll(() => systemOpens(app)).toEqual([local]);
    await expect(panel(page)).toHaveCount(0);

    await clickLink(page, row, true);
    await expect(panel(page)).toBeVisible();
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.browserAPI.get(id), ids.sessionId)).tabs.map(
          (tab) => tab.url,
        ),
      )
      .toEqual([local]);
    expect(await systemOpens(app)).toEqual([local]);
  });
});
