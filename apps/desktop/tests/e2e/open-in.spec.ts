import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NewSessionFields } from '../../src/shared/workspace';
import { showBrowser } from './helpers/browserTab';
import { commandPaletteChord, launchElectron } from './helpers/electron';
import { startFixtureServer } from './helpers/fixtureServer';
import { infoPanelChord, infoSection } from './helpers/infoPanel';

/** What a test run would have opened: main records it and opens nothing. */
interface RecordedLaunch {
  targetId: string;
  appPath?: string;
  folder: string;
}

const FINDER = '/System/Library/CoreServices/Finder.app';

/**
 * "Open in" from the info panel: the session's folder opened in an app main
 * found. A test run never opens one: main's launcher records what would have
 * opened (`exposeToTests('openIn')`), and it looks for apps only in the
 * folder this spec fills with empty bundles.
 */
test.describe('open in', () => {
  test.skip(process.platform !== 'darwin', 'Only Finder is offered off macOS');

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let root: string;
  let env: Record<string, string>;
  /** A's folder. */
  let catalog: string;
  /** B's folder. */
  let notes: string;
  /** Where this spec installs apps. */
  let applications: string;

  test.beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-open-in-')));
    catalog = path.join(root, 'catalog-portal');
    notes = path.join(root, 'notes');
    fs.mkdirSync(catalog);
    fs.mkdirSync(notes);
    // VS Code, and IntelliJ under its Community Edition's name.
    applications = path.join(root, 'Applications');
    for (const bundle of ['Visual Studio Code.app', 'IntelliJ IDEA CE.app']) {
      fs.mkdirSync(path.join(applications, bundle, 'Contents'), { recursive: true });
    }

    // The agent, which answers the health probe's --version at once, with a
    // config folder of its own, so nothing reads the person's real one.
    const stub = path.join(root, 'agent.sh');
    fs.writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'case "$*" in *--version*) echo "2.1.0 (Claude Code)"; exit 0;; esac',
        'printf "Agent ready\\n"',
        'exec sleep 300',
      ].join('\n'),
      { mode: 0o755 },
    );
    const configDir = path.join(root, 'claude-config');
    fs.mkdirSync(configDir);

    env = { CONSOLA_OPEN_IN_APPLICATIONS: applications };
    ({ app, page, userDataDir } = await launchElectron({ env }));
    await page.evaluate(
      async ({ catalog, notes, stub, configDir }) => {
        await window.harnessStateAPI.addHarness({
          id: 'open-in-stub',
          driverId: 'claude',
          name: 'Stub',
          binaryPath: stub,
          configDir,
          accentColor: '#555555',
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Sprocket',
          catalog,
          false,
          'open-in-stub',
        );
        const session = (name: string, instanceId: string, more: Partial<NewSessionFields> = {}) =>
          window.workspaceAPI.createSession(workspace.id, {
            name,
            nameIsUserSet: true,
            workspaceId: workspace.id,
            instanceId,
            harnessId: 'open-in-stub',
            scopeId: workspace.scopes[0].id,
            ...more,
          });
        await session('Paginate the catalog search', 'open-a');
        await session('Review notes', 'open-b', { cwd: notes });
      },
      { catalog, notes, stub, configDir },
    );
  });

  test.afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
  });

  async function openSession(name: string): Promise<void> {
    await page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: /Sprocket/ })
      .click();
    await page.locator('.session-nav-item').filter({ hasText: name }).click();
  }

  const environment = () => infoSection(page, 'Environment');
  /** The split button's main part, named for the app it opens in. */
  const openButton = (label: string) =>
    environment().getByRole('button', { name: `Open in ${label}`, exact: true });
  const chevron = () =>
    environment().getByRole('button', { name: 'Choose an app to open the folder in' });
  const menu = () => page.getByRole('menu');
  const menuItem = (label: string) => menu().getByRole('menuitem', { name: label, exact: true });
  const conversation = () =>
    page.locator('[data-conversation-terminal] .terminal-surface textarea');
  const launches = () =>
    app.evaluate(
      () =>
        (globalThis as unknown as { __consolaTest: { openIn: { launches: RecordedLaunch[] } } })
          .__consolaTest.openIn.launches,
    );
  const openChord = () => page.keyboard.press('Meta+KeyO');

  test('the split button opens the folder in the favourite, and a pick from its menu becomes it', async () => {
    await openSession('Paginate the catalog search');
    // Right under the Folder row, in Finder before any pick.
    await expect(openButton('Finder')).toBeVisible();
    expect(
      await environment()
        .locator('.info-open-in')
        .evaluate((split) => split.previousElementSibling?.getAttribute('aria-label')),
    ).toMatch(/^Folder .+\. Copy folder path$/);
    await openButton('Finder').click();
    await expect.poll(launches).toEqual([{ targetId: 'finder', appPath: FINDER, folder: catalog }]);

    // The chevron lists what main found, each with its icon, the favourite's
    // chord on its item.
    await chevron().click();
    await expect(menu().getByRole('menuitem')).toHaveText(['VS Code', 'IntelliJ IDEA', 'Finder⌘O']);
    await expect(menuItem('Finder')).toHaveAttribute('aria-keyshortcuts', 'Meta+O');
    // An icon for each: the app's own, or the folder drawn when Quick Look
    // gives none, which for this spec's empty bundles depends on the machine.
    for (const label of ['VS Code', 'IntelliJ IDEA', 'Finder']) {
      await expect(menuItem(label).locator('.info-open-in-icon > :is(img, svg)')).toHaveCount(1);
    }
    // Closed, it hands the keyboard back to the chevron.
    await page.keyboard.press('Escape');
    await expect(menu()).toHaveCount(0);
    await expect(chevron()).toBeFocused();

    // A pick opens the folder there, and the button and ⌘O follow it.
    await chevron().click();
    await menuItem('IntelliJ IDEA').click();
    await expect(openButton('IntelliJ IDEA')).toBeVisible();
    const intellij = path.join(applications, 'IntelliJ IDEA CE.app');
    await expect.poll(launches).toEqual([
      { targetId: 'finder', appPath: FINDER, folder: catalog },
      { targetId: 'intellij', appPath: intellij, folder: catalog },
    ]);
    await chevron().click();
    await expect(menuItem('IntelliJ IDEA')).toContainText('⌘O');
    await expect(menuItem('Finder')).not.toContainText('⌘O');
    await page.keyboard.press('Escape');

    // ⌘O from the conversation, whether or not the info panel shows.
    await conversation().focus();
    await openChord();
    await expect.poll(async () => (await launches()).length).toBe(3);
    await page.keyboard.press(infoPanelChord());
    await expect(environment()).toHaveCount(0);
    await conversation().focus();
    await openChord();
    await expect.poll(async () => (await launches()).length).toBe(4);
    await page.keyboard.press(infoPanelChord());

    // Another session opens its own folder.
    await openSession('Review notes');
    await expect(openButton('IntelliJ IDEA')).toBeVisible();
    await conversation().focus();
    await openChord();
    await expect
      .poll(async () => (await launches()).at(-1))
      .toEqual({
        targetId: 'intellij',
        appPath: intellij,
        folder: notes,
      });
    expect((await launches()).slice(2, 4)).toEqual([
      { targetId: 'intellij', appPath: intellij, folder: catalog },
      { targetId: 'intellij', appPath: intellij, folder: catalog },
    ]);

    // The palette offers each app, and its pick becomes the favourite too.
    await page.keyboard.press(commandPaletteChord());
    await page.keyboard.type('Open folder in VS Code');
    await page.keyboard.press('Enter');
    await expect(openButton('VS Code')).toBeVisible();
    await expect
      .poll(async () => (await launches()).at(-1))
      .toEqual({
        targetId: 'vscode',
        appPath: path.join(applications, 'Visual Studio Code.app'),
        folder: notes,
      });

    // Main checks the folder itself: one gone since is refused, and says so.
    const opened = (await launches()).length;
    fs.rmSync(notes, { recursive: true, force: true });
    await openButton('VS Code').click();
    await expect(page.locator('.toast-message')).toHaveText(`${notes} does not exist.`);
    expect(await launches()).toHaveLength(opened);
  });

  test('⌘O opens the folder with the keyboard in a browser page, and nothing under the Inbox', async () => {
    const fixtures = await startFixtureServer();
    try {
      await openSession('Paginate the catalog search');
      await expect(openButton('Finder')).toBeVisible();

      // A page in the Browser tab, loaded, with the keyboard in it.
      const url = fixtures.url('/a.html');
      await showBrowser(page);
      const address = page.getByRole('textbox', { name: 'Address' });
      await address.click();
      await address.fill(`${fixtures.host}/a.html`);
      await address.press('Enter');
      await expect
        .poll(() =>
          app.evaluate(({ webContents }, pageUrl) => {
            const guest = webContents
              .getAllWebContents()
              .find(
                (contents) => contents.getType() === 'webview' && contents.getURL() === pageUrl,
              );
            return !!guest && !guest.isLoading();
          }, url),
        )
        .toBe(true);
      await page
        .locator('.browser-page[data-presence="shown"] webview')
        .evaluate((webview) => (webview as HTMLElement).focus());
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('WEBVIEW');

      // A page gets its keys on its own web contents, never the window's, so
      // main stands in for the person there, pressing ⌘O and letting go.
      await app.evaluate(({ webContents }, pageUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getType() === 'webview' && contents.getURL() === pageUrl);
        if (!guest) throw new Error(`no page at ${pageUrl}`);
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['meta'] });
        guest.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['meta'] });
      }, url);
      await expect
        .poll(launches)
        .toEqual([{ targetId: 'finder', appPath: FINDER, folder: catalog }]);

      // Under the Inbox, which covers the session pane: ⌘O opens nothing.
      const inbox = page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Inbox', exact: true });
      await inbox.click();
      await expect(inbox).toHaveAttribute('aria-current', 'page');
      await openChord();

      // ⌘O in another session: had the press under the Inbox opened A's
      // folder, it would be recorded before this one, so the recorder
      // holding B's next says it did not, with no fixed wait.
      await page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('button', { name: 'Home', exact: true })
        .click();
      // The info panel steps aside for the Browser tab on this window: ⌘O
      // opens all the same.
      await openSession('Review notes');
      await expect(page.locator('.workspace-view-header')).toContainText('Review notes');
      await conversation().focus();
      await openChord();
      await expect.poll(launches).toEqual([
        { targetId: 'finder', appPath: FINDER, folder: catalog },
        { targetId: 'finder', appPath: FINDER, folder: notes },
      ]);
    } finally {
      await fixtures.close();
    }
  });

  test('no folder, no button: a removed worktree shows none and ⌘O opens nothing', async () => {
    // The favourite outlives a relaunch.
    await openSession('Paginate the catalog search');
    await chevron().click();
    await menuItem('VS Code').click();
    await expect(openButton('VS Code')).toBeVisible();
    await expect.poll(async () => (await launches()).length).toBe(1);

    // `removedWorktree` is main's to write (`recordWorktreesRemoved`), so the
    // test seeds it through the profile, read at the next launch.
    await app.close();
    const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      workspaces: { name: string; sessions: Record<string, unknown>[] }[];
    };
    const workspace = saved.workspaces.find((candidate) => candidate.name === 'Sprocket')!;
    const sibling = workspace.sessions.find((session) => session.name === 'Review notes')!;
    const worktree = path.join(root, 'old-experiment');
    workspace.sessions.push({
      ...sibling,
      id: 'open-c',
      name: 'Old experiment',
      instanceId: 'open-c',
      claudeSessionId: randomUUID(),
      cwd: worktree,
      removedWorktree: {
        path: worktree,
        mainRepo: path.join(root, 'gone'),
        commit: 'a'.repeat(40),
        branch: 'consola/old-experiment',
        keepRef: 'refs/consola/worktrees/old-experiment',
        trigger: 'settled',
        removedAt: Date.now(),
      },
    });
    fs.writeFileSync(stateFile, JSON.stringify(saved));
    ({ app, page } = await launchElectron({ userDataDir, env }));

    await openSession('Paginate the catalog search');
    await expect(openButton('VS Code')).toBeVisible();

    await openSession('Old experiment');
    await expect(
      environment().getByText('Worktree removed, rebuilt when the session next starts'),
    ).toBeVisible();
    await expect(environment().locator('.info-open-in')).toHaveCount(0);
    await openChord();

    // ⌘O back in a session with a folder: had the press above opened
    // anything, it would be recorded before this one, so the recorder
    // holding this one alone says it did not, with no fixed wait.
    await openSession('Paginate the catalog search');
    await expect(openButton('VS Code')).toBeVisible();
    await openChord();
    await expect.poll(launches).toEqual([
      {
        targetId: 'vscode',
        appPath: path.join(applications, 'Visual Studio Code.app'),
        folder: catalog,
      },
    ]);
  });
});
