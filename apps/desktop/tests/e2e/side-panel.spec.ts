import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commandPaletteChord, launchElectron } from './helpers/electron';

/**
 * The side panel beside a session's conversation: a panel of tab groups to
 * the right of it, opened from the header's shortcuts and the palette.
 */
test.describe('side panel', () => {
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let root: string;

  test.beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-side-panel-')));

    // A repository with one changed file, so Changes lists exactly that file.
    const repo = path.join(root, 'catalog-portal');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'src', 'search.ts'), 'export const pageSize = 20;\n');
    git('add', '.');
    git(
      '-c',
      'user.name=JaviDev',
      '-c',
      'user.email=javidev@sprocket.example',
      'commit',
      '-q',
      '-m',
      'Search the catalog',
    );
    fs.writeFileSync(path.join(repo, 'src', 'search.ts'), 'export const pageSize = 50;\n');

    // A folder outside git, for a session Changes does not apply to.
    const notes = path.join(root, 'notes');
    fs.mkdirSync(notes);

    const stub = path.join(root, 'agent.sh');
    fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', {
      mode: 0o755,
    });

    ({ app, page, userDataDir } = await launchElectron());
    await page.evaluate(
      async ({ repo, notes, stub }) => {
        await window.harnessStateAPI.addHarness({
          id: 'side-panel-stub',
          driverId: 'claude',
          name: 'Stub',
          binaryPath: stub,
          accentColor: '#555555',
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Sprocket',
          repo,
          true,
          'side-panel-stub',
        );
        const session = (name: string, instanceId: string, cwd?: string) =>
          window.workspaceAPI.createSession(workspace.id, {
            name,
            nameIsUserSet: true,
            workspaceId: workspace.id,
            instanceId,
            harnessId: 'side-panel-stub',
            scopeId: workspace.scopes[0].id,
            ...(cwd ? { cwd } : {}),
          });
        await session('Paginate the catalog search', 'side-a');
        await session('Fix flaky upload test', 'side-b');
        await session('Review notes', 'side-c', notes);
      },
      { repo, notes, stub },
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

  const changesShortcut = () => page.getByRole('button', { name: 'Changes', exact: true });
  const changesTab = () => page.getByRole('tab', { name: 'Changes' });
  const filesTab = () => page.getByRole('tab', { name: 'Files', exact: true });
  const filesChord = process.platform === 'darwin' ? 'Meta+Shift+KeyE' : 'Control+Shift+KeyE';
  const filesScopeChord = process.platform === 'darwin' ? 'Meta+Shift+KeyO' : 'Control+Shift+KeyO';
  const sidePanelChord = process.platform === 'darwin' ? 'Meta+Alt+KeyB' : 'Control+Alt+KeyB';
  const conversation = () =>
    page.locator('[data-conversation-terminal] .terminal-surface textarea');
  const sidePanelToggle = () => page.getByRole('button', { name: /^(Show|Hide) side panel$/ });
  // The browser has a `New tab` button and tabs of its own, so these are
  // found inside the side panel's tab bar.
  const sidePanelTabs = () => page.getByRole('tablist', { name: 'Side panel tabs' });
  const sidePanelTab = (name: string) => sidePanelTabs().getByRole('tab', { name, exact: true });
  const plusButton = () =>
    page.locator('.side-panel-tab-bar').getByRole('button', { name: 'New tab', exact: true });
  const newTabList = () => page.getByRole('listbox', { name: 'Open in this tab' });

  /**
   * Counts every session shell view that mounts from now on, however
   * briefly: a view that mounts attaches, and attaching spawns the shell.
   */
  async function countShellMounts(): Promise<() => Promise<number>> {
    await page.evaluate(() => {
      const record = globalThis as { shellMounts?: number };
      record.shellMounts = 0;
      const shellSelector = '[data-testid="session-shell"]';
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches(shellSelector) || node.querySelector(shellSelector)) {
              record.shellMounts! += 1;
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    return () => page.evaluate(() => (globalThis as { shellMounts?: number }).shellMounts ?? 0);
  }

  test('the Changes shortcut opens its tab and hides the side panel when pressed again', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();

    await expect(page.getByTestId('side-panel')).toBeVisible();
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.git-review-panel')).toContainText('search.ts');
    await expect(changesShortcut()).toHaveAttribute('aria-pressed', 'true');

    await changesShortcut().click();
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(changesShortcut()).toHaveAttribute('aria-pressed', 'false');
  });

  test('Escape in the conversation leaves the Changes tab open', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');

    await page.locator('[data-conversation-terminal] .terminal-surface textarea').focus();
    await page.keyboard.press('Escape');
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.git-review-panel')).toBeVisible();

    // xterm stops the Escape it sends at its own textarea, so the conversation
    // alone cannot tell a listener on the window from one on the tab. Escape
    // on the header, outside both, can: it must leave the tab open too.
    await changesShortcut().focus();
    await page.keyboard.press('Escape');
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');

    // Escape pressed inside the tab is the one that closes it.
    await page.getByPlaceholder('Enter commit message...').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
  });

  test('Escape after a click on the diff closes the Changes tab', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');

    // Nothing in the diff can take focus itself, so the click must land it
    // inside the review rather than on the tab panel around it.
    await page.locator('.git-review-panel .git-review-inline-diff-content').first().click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
  });

  test('the palette opens Changes', async () => {
    await openSession('Paginate the catalog search');
    await expect(page.locator('[data-conversation-terminal]')).toBeVisible();

    await page.keyboard.press(commandPaletteChord());
    await page.keyboard.type('Open Changes');
    await page.keyboard.press('Enter');

    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.git-review-panel')).toContainText('search.ts');
  });

  test('⇧⌘E opens Files and a chosen file opens beside the tree', async () => {
    await openSession('Paginate the catalog search');
    await page.locator('[data-conversation-terminal] .terminal-surface textarea').focus();
    await page.keyboard.press(filesChord);

    await expect(filesTab()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('files-previews')).toContainText(
      'Choose a file to preview it here.',
    );
    const tree = page.getByTestId('files-tree');
    await tree.getByText('src', { exact: true }).click();
    await tree.getByText('search.ts', { exact: true }).click();
    await expect(page.locator('.preview-panel')).toBeVisible();
    await expect(page.locator('.preview-tab-bar')).toContainText('search.ts');

    // The keyboard is in the tree now; the chord still reaches the window.
    await page.keyboard.press(filesChord);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
  });

  test('a changed file chosen in the palette opens in the Files tab', async () => {
    await openSession('Paginate the catalog search');
    await expect(page.locator('[data-conversation-terminal]')).toBeVisible();

    await page.keyboard.press(filesScopeChord);
    await page.keyboard.type('search.ts');
    // The row appears once git has said what changed.
    await expect(page.getByRole('option', { name: /search\.ts/ })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(filesTab()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.preview-tab-bar')).toContainText('search.ts');
  });

  test('showing an empty side panel shows the list of tabs', async () => {
    await openSession('Paginate the catalog search');
    // Last in the header, after the folder's own toggles.
    await expect(page.locator('.workspace-view-header button').last()).toHaveAccessibleName(
      'Show side panel',
    );
    await sidePanelToggle().click();

    await expect(sidePanelTab('New tab')).toHaveAttribute('aria-selected', 'true');
    await expect(newTabList()).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Open in this tab' })).toBeVisible();
    await expect(sidePanelToggle()).toHaveAccessibleName('Hide side panel');
    await expect(sidePanelToggle()).toHaveAttribute('aria-pressed', 'true');
  });

  test('the list opens a kind by mouse and by key', async () => {
    await openSession('Paginate the catalog search');
    await sidePanelToggle().click();

    // A click turns the placeholder into the kind, in place.
    await newTabList().getByRole('option', { name: 'Files' }).click();
    await expect(sidePanelTab('Files')).toHaveAttribute('aria-selected', 'true');
    await expect(sidePanelTab('New tab')).toHaveCount(0);

    // A letter chooses its kind. A chord with it does not.
    await plusButton().click();
    await expect(newTabList()).toBeFocused();
    await page.keyboard.press('Control+KeyD');
    await expect(sidePanelTab('New tab')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('d');
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
    await expect(sidePanelTab('New tab')).toHaveCount(0);

    // The first available row is highlighted; the arrows move among them.
    await plusButton().click();
    await expect(newTabList().getByRole('option', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('ArrowDown');
    await expect(newTabList().getByRole('option', { name: 'Files' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Enter');
    // Files is open already: it comes to the front where it is.
    await expect(sidePanelTab('Files')).toHaveAttribute('aria-selected', 'true');
    await expect(sidePanelTab('New tab')).toHaveCount(0);
    await expect(sidePanelTabs().getByRole('tab')).toHaveCount(2);

    // Escape takes the placeholder away and fronts the tab before it.
    await plusButton().click();
    await expect(newTabList()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sidePanelTab('New tab')).toHaveCount(0);
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
  });

  test('a kind that does not apply is dimmed and says why', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await plusButton().click();

    const pullRequest = newTabList().getByRole('option', { name: 'Pull request' });
    await expect(pullRequest).toHaveAttribute('aria-disabled', 'true');
    await expect(pullRequest).toContainText(
      'This session is not linked to a pull request or issue.',
    );

    await expect(newTabList()).toBeFocused();
    await page.keyboard.press('p');
    await expect(sidePanelTab('New tab')).toHaveAttribute('aria-selected', 'true');
    await expect(newTabList()).toBeVisible();
  });

  test('⌥⌘B toggles the side panel from the conversation', async () => {
    await openSession('Paginate the catalog search');
    await conversation().focus();
    await page.keyboard.press(sidePanelChord);
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await expect(sidePanelToggle()).toHaveAttribute('aria-pressed', 'true');

    await conversation().focus();
    await page.keyboard.press(sidePanelChord);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(sidePanelToggle()).toHaveAttribute('aria-pressed', 'false');

    // From the shell, which hands the chord to the window.
    await conversation().focus();
    await page.keyboard.press('Control+Backquote');
    const shell = page.getByTestId('session-shell').locator('textarea');
    await expect(shell).toBeFocused();
    await page.keyboard.press(sidePanelChord);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);

    // Shown again, the Terminal tab comes back in front, but nobody asked
    // for the shell this time, so it leaves the keyboard alone.
    await page.keyboard.press(sidePanelChord);
    await expect(page.locator('.shell-directory')).toHaveText(/^Started in: \//);
    await expect(shell).not.toBeFocused();

    // From the list, which the person just opened, so it takes the keyboard,
    // and which hands a chord pressed in it to the window.
    await plusButton().click();
    await expect(newTabList()).toBeFocused();
    await page.keyboard.press(sidePanelChord);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
  });

  test('a Terminal tab behind another tab starts no shell', async () => {
    const shell = page.getByTestId('session-shell');
    await openSession('Paginate the catalog search');
    await conversation().focus();
    await page.keyboard.press('Control+Backquote');
    await expect(shell.locator('textarea')).toBeFocused();
    await changesShortcut().click();
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');
    await expect(shell).toHaveCount(0);

    // Arriving on another session mounts nothing for the tab behind, not
    // even for a moment: a mount would spawn that session's shell.
    const shellMounts = await countShellMounts();
    await openSession('Fix flaky upload test');
    await expect(conversation()).toBeVisible();
    await expect(page.locator('.git-review-panel')).toBeVisible();
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');
    await expect(shell).toHaveCount(0);
    expect(await shellMounts()).toBe(0);

    // Brought to the front by the person, it starts and takes the keyboard.
    await sidePanelTab('Terminal').click();
    await expect(page.locator('.shell-directory')).toHaveText(
      `Started in: ${path.join(root, 'catalog-portal')}`,
    );
    await expect(shell.locator('textarea')).toBeFocused();
    expect(await shellMounts()).toBe(1);
  });

  test('the conversation keeps its terminal while the Terminal tab opens, closes and moves', async () => {
    const group = (tabs: string) =>
      page.locator('.side-panel-group').filter({ has: page.getByRole('tablist', { name: tabs }) });

    // Two groups, with Terminal in front of the bottom one. No control
    // splits the panel yet, so the layout is restored from storage, which
    // is also a mount nobody asked for: the keyboard stays where it was.
    await openSession('Paginate the catalog search');
    await expect(conversation()).toBeVisible();
    await page.evaluate((key) => {
      const layout = {
        version: 1,
        visible: true,
        root: {
          type: 'split',
          orientation: 'stacked',
          children: [
            { type: 'group', id: 'g1', tabs: ['changes'], active: 'changes' },
            { type: 'group', id: 'g2', tabs: ['terminal'], active: 'terminal' },
          ],
        },
        maximized: null,
        lastGroupOf: {},
      };
      localStorage.setItem(
        key,
        JSON.stringify({ state: { layout, uses: {}, rememberLayout: true }, version: 0 }),
      );
    }, 'consola-side-panel');
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    const shell = page.getByTestId('session-shell');
    await expect(page.locator('.shell-directory')).toHaveText(/^Started in: \//);
    await expect(conversation()).toBeFocused();

    // The conversation's xterm, held on to: a remount would replace it.
    const xterm = await page.locator('[data-conversation-terminal] .xterm').elementHandle();
    if (!xterm) throw new Error('the conversation has no terminal');
    const sameConversation = () =>
      xterm.evaluate(
        (element) =>
          element.isConnected &&
          element === document.querySelector('[data-conversation-terminal] .xterm'),
      );

    // Maximizing the other group hides Terminal's, and takes its shell away.
    await group('Top group tabs').getByRole('button', { name: 'Maximize group' }).click();
    await expect(shell).toHaveCount(0);
    expect(await sameConversation()).toBe(true);
    await group('Top group tabs').getByRole('button', { name: 'Restore group' }).click();
    await expect(shell).toHaveCount(1);
    expect(await sameConversation()).toBe(true);

    // Closed, its group goes with it; opened again, it joins the other.
    await page.getByRole('button', { name: 'Close Terminal tab', exact: true }).click();
    await expect(shell).toHaveCount(0);
    await expect(sidePanelTabs().getByRole('tab')).toHaveCount(1);
    expect(await sameConversation()).toBe(true);
    await conversation().focus();
    await page.keyboard.press('Control+Backquote');
    await expect(sidePanelTabs().getByRole('tab')).toHaveCount(2);
    await expect(sidePanelTab('Terminal')).toHaveAttribute('aria-selected', 'true');
    await expect(shell.locator('textarea')).toBeFocused();
    expect(await sameConversation()).toBe(true);

    // Behind another tab and in front again.
    await sidePanelTab('Changes').click();
    await expect(shell).toHaveCount(0);
    await sidePanelTab('Terminal').click();
    await expect(shell.locator('textarea')).toBeFocused();
    expect(await sameConversation()).toBe(true);

    // The panel hidden and shown.
    await page.keyboard.press(sidePanelChord);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    expect(await sameConversation()).toBe(true);
    await page.keyboard.press(sidePanelChord);
    await expect(shell).toHaveCount(1);
    expect(await sameConversation()).toBe(true);

    // In a hidden panel, arriving on another session starts no shell.
    await page.keyboard.press(sidePanelChord);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    const shellMounts = await countShellMounts();
    await openSession('Fix flaky upload test');
    await expect(page.locator('.workspace-view-session')).toHaveText('Fix flaky upload test');
    await expect(conversation()).toBeVisible();
    expect(await shellMounts()).toBe(0);
    // Another session's conversation is another terminal: the check above
    // does see a terminal that was replaced.
    expect(await sameConversation()).toBe(false);
  });

  test('a list the person did not just open leaves the keyboard in the conversation', async () => {
    await openSession('Paginate the catalog search');
    await sidePanelToggle().click();
    await expect(newTabList()).toBeFocused();

    // To another session and back: the list is still there, the keyboard is
    // the conversation's, and a kind's letter typed there chooses nothing.
    await openSession('Fix flaky upload test');
    await openSession('Paginate the catalog search');
    await expect(newTabList()).toBeVisible();
    await expect(conversation()).toBeFocused();
    await page.keyboard.press('d');
    await expect(sidePanelTab('New tab')).toHaveAttribute('aria-selected', 'true');

    // Relaunched, the app comes back on this session and the remembered
    // layout mounts the list afresh, unasked. Nothing is clicked on the way:
    // a click on the session's row would take the keyboard itself.
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await expect(newTabList()).toBeVisible();
    await expect(conversation()).toBeFocused();
    await expect(newTabList()).not.toBeFocused();
    await page.keyboard.press('d');
    await expect(sidePanelTab('New tab')).toHaveAttribute('aria-selected', 'true');
    await expect(sidePanelTab('Changes')).toHaveCount(0);
  });

  test('the list takes the keyboard when its tab is clicked, not when it comes in front by itself', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await plusButton().click();
    await expect(newTabList()).toBeFocused();

    // Clicked from behind another tab: the person asked for the list.
    await sidePanelTab('Changes').click();
    await expect(newTabList()).toHaveCount(0);
    await sidePanelTab('New tab').click();
    await expect(newTabList()).toBeFocused();

    // In front again only because the tab before it closed: nobody asked.
    await sidePanelTab('Changes').click();
    await page.getByRole('button', { name: 'Close Changes tab', exact: true }).click();
    await expect(sidePanelTab('New tab')).toHaveAttribute('aria-selected', 'true');
    await expect(newTabList()).toBeVisible();
    // Two frames, time enough for any deferred focus to land, before saying none did.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await expect(newTabList()).not.toBeFocused();
    await page.keyboard.press('d');
    await expect(sidePanelTab('New tab')).toHaveAttribute('aria-selected', 'true');
    await expect(sidePanelTab('Changes')).toHaveCount(0);
  });
});
