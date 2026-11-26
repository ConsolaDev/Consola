import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { showBrowser } from './helpers/browserTab';
import { commandPaletteChord, launchElectron, removeProfile } from './helpers/electron';

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

/** Every fixture server started, so each is stopped even when a later one fails to start. */
const children: ChildProcess[] = [];

test.afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Starts a server with `cwd` as its working folder and resolves with its port. */
async function startServer(cwd: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['-e', SERVER], {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
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

/** A real path for a new temp folder, as `lsof` reports it (macOS's temp folder is a symlink). */
function tempFolder(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * One workspace on `root` with a session there, and one more session per
 * entry of `others` running in that folder instead (as a worktree session
 * does). Returns the session ids, the one on `root` first.
 */
async function seed(page: Page, root: string, others: string[] = []): Promise<string[]> {
  const stub = path.join(root, 'agent.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', { mode: 0o755 });
  return page.evaluate(
    async ({ root, stub, others }) => {
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
      const ids: string[] = [];
      for (const [index, cwd] of [undefined, ...others].entries()) {
        const session = await window.workspaceAPI.createSession(workspace.id, {
          name: index === 0 ? 'Servers session' : `Other session ${index}`,
          nameIsUserSet: true,
          workspaceId: workspace.id,
          instanceId: `browser-servers-${index}`,
          harnessId: 'browser-test',
          scopeId: workspace.scopes[0].id,
          ...(cwd ? { cwd } : {}),
        });
        ids.push(session!.id);
      }
      return ids;
    },
    { root, stub, others },
  );
}

async function openSession(page: Page, name = 'Servers session'): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: /Servers/ })
    .click();
  await page.locator('.session-nav-item').filter({ hasText: name }).click();
}

test.describe('local servers in the browser', () => {
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let root: string;
  let elsewhere: string;

  test.beforeEach(async () => {
    root = tempFolder('consola-servers-');
    elsewhere = tempFolder('consola-elsewhere-');
    ({ app, page, userDataDir } = await launchElectron());
    await seed(page, root);
  });

  test.afterEach(async () => {
    await app.close();
    removeProfile(userDataDir);
    for (const folder of [root, elsewhere]) fs.rmSync(folder, { recursive: true, force: true });
  });

  async function openPanel(): Promise<void> {
    await openSession(page);
    await showBrowser(page);
  }

  test("the empty tab lists this folder's servers and a click loads the page", async () => {
    const mine = await startServer(root);
    const foreign = await startServer(elsewhere);

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
    // The browser's own "+", not the side panel's around it.
    await page
      .getByTestId('browser-panel')
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

test.describe('an empty tab lists only its own session’s servers', () => {
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let root: string;
  let elsewhere: string;
  let bin: string;

  /** While this file exists, the stand-in `lsof` takes a second over the listener scan. */
  const gate = () => path.join(bin, 'slow');

  test.beforeEach(async () => {
    root = tempFolder('consola-servers-');
    elsewhere = tempFolder('consola-elsewhere-');
    // Main runs `lsof` from its PATH: a stand-in ahead of the real one lets
    // the test hold a scan in flight. It answers exactly as lsof does, a
    // second late while the gate is there, well inside the scan's budget.
    bin = tempFolder('consola-servers-bin-');
    const lsof = execFileSync('/bin/sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(
      path.join(bin, 'lsof'),
      `#!/bin/sh\ncase " $* " in *" -iTCP "*) [ -f "${gate()}" ] && sleep 1 ;; esac\nexec "${lsof}" "$@"\n`,
      { mode: 0o755 },
    );
    ({ app, page, userDataDir } = await launchElectron({
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    }));
  });

  test.afterEach(async () => {
    await app.close();
    removeProfile(userDataDir);
    for (const folder of [root, elsewhere, bin]) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  test('switching session shows the new session’s servers, never the old one’s', async () => {
    const mine = await startServer(root);
    const theirs = await startServer(elsewhere);
    await seed(page, root, [elsewhere]);
    const rows = page.getByTestId('browser-local-server');
    const emptyTab = page.getByTestId('browser-empty-tab');

    await openSession(page, 'Servers session');
    await showBrowser(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`localhost:${mine.port}`);

    // While the second session's scan runs, the first one's list is not shown for it.
    fs.writeFileSync(gate(), '');
    await openSession(page, 'Other session 1');
    await expect(emptyTab).toBeVisible();
    await expect(rows).toHaveCount(0);
    fs.rmSync(gate());
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`localhost:${theirs.port}`);

    // A scan still in flight when the person moves on is answered for its own
    // session: the session now shown scans for itself, and the late answer
    // is not written over it.
    fs.writeFileSync(gate(), '');
    await openSession(page, 'Servers session');
    await expect(emptyTab).toBeVisible();
    await openSession(page, 'Other session 1');
    fs.rmSync(gate());
    // Both scans have answered by now.
    await page.waitForTimeout(2500);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`localhost:${theirs.port}`);
    await expect(emptyTab).not.toContainText(`localhost:${mine.port}`);
  });
});
