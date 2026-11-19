import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandPaletteChord, launchElectron } from './helpers/electron';

/**
 * The browser's empty tab lists the servers running from the session's
 * folder. The servers here are real `node` processes whose working directory
 * is set by the spec, since that is the only thing `lsof` can see.
 */

test.skip(process.platform === 'win32', 'the local-server scan is macOS and Linux only');

const SERVER = `
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Local dev server</title><body>served from ' + process.cwd());
  });
  server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
  setInterval(() => {}, 1000);
`;

/** Starts a server with `cwd` as its working folder and resolves with its port. */
async function startServer(cwd: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['-e', SERVER], {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', () => reject(new Error('the fixture server exited')));
  });
  return { child, port };
}

async function seed(page: Page, root: string): Promise<{ sessionId: string }> {
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
      const workspace = await window.workspaceAPI.createWorkspace(
        'Servers',
        root,
        false,
        'browser-test',
      );
      const session = await window.workspaceAPI.createSession(workspace.id, {
        name: 'Servers session',
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: 'browser-servers',
        harnessId: 'browser-test',
        scopeId: workspace.scopes[0].id,
      });
      return { sessionId: session!.id };
    },
    { root, stub },
  );
}

test.describe('local servers in the browser', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let elsewhere: string;
  const children: ChildProcess[] = [];

  test.beforeEach(async () => {
    // Real paths, as `lsof` reports them (macOS's temp folder is a symlink).
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-servers-')));
    elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-elsewhere-')));
    ({ app, page } = await launchElectron());
    await seed(page, root);
  });

  test.afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await app.close();
  });

  async function openPanel(): Promise<void> {
    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Servers/ })
      .click();
    await page.locator('.session-nav-item').filter({ hasText: 'Servers session' }).click();
    const panel = page.getByTestId('browser-panel');
    if (!(await panel.isVisible())) {
      await page.getByRole('button', { name: /^(Show|Hide) browser$/ }).click();
    }
    await expect(panel).toBeVisible();
  }

  test("the empty tab lists this folder's servers and a click loads the page", async () => {
    const mine = await startServer(root);
    const foreign = await startServer(elsewhere);
    children.push(mine.child, foreign.child);

    await openPanel();
    const rows = page.getByTestId('browser-local-server');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`localhost:${mine.port}`);
    await expect(rows.first()).toContainText('node');
    await expect(page.getByTestId('browser-empty-tab')).not.toContainText(
      `localhost:${foreign.port}`,
    );

    await rows.first().click();
    await expect
      .poll(() =>
        app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getType() === 'webview')
            .map((contents) => contents.getURL()),
        ),
      )
      .toEqual([`http://localhost:${mine.port}/`]);
    // The page replaces the empty tab.
    await expect(page.getByTestId('browser-empty-tab')).toHaveCount(0);
  });

  test('a blank tab hosts no page until it has an address', async () => {
    await openPanel();
    await page
      .getByRole('button', { name: /new tab/i })
      .first()
      .click();
    await expect(page.getByTestId('browser-empty-tab')).toBeVisible();
    const count = await app.evaluate(
      ({ webContents }) =>
        webContents.getAllWebContents().filter((contents) => contents.getType() === 'webview')
          .length,
    );
    expect(count).toBe(0);
  });

  test("the palette offers the folder's servers and the address row", async () => {
    const mine = await startServer(root);
    children.push(mine.child);

    await openPanel();
    await page.keyboard.press(commandPaletteChord());
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await palette.getByRole('combobox').fill('localhost');
    await expect(
      palette.getByRole('option', { name: new RegExp(`Open localhost:${mine.port}`) }),
    ).toBeVisible();

    await palette.getByRole('combobox').fill('Open address');
    await palette.getByRole('option', { name: /Open address in browser/ }).click();
    await expect(page.getByRole('textbox', { name: 'Address' })).toBeFocused();
  });
});
