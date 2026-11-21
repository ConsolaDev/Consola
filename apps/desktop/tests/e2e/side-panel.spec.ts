import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { browserChord } from './helpers/browserTab';
import { commandPaletteChord, launchElectron, settingsChord } from './helpers/electron';

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
  const tabList = (name: string) => page.getByRole('tablist', { name, exact: true });
  /** A group of the side panel, found by its tab list's name. */
  const group = (tabs: string) => page.locator('.side-panel-group').filter({ has: tabList(tabs) });
  /** Opens a tab's menu with the pointer and chooses `item`. */
  async function chooseFromTabMenu(tab: Locator, item: string): Promise<void> {
    await tab.click({ button: 'right' });
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  }
  /** Presses on `tab` and moves the pointer to `to` in 10 steps, leaving the button down. */
  async function dragTab(tab: Locator, to: { x: number; y: number }): Promise<void> {
    const box = (await tab.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
  }
  /**
   * Waits out dnd-kit's click guard, before a click that follows a drag. A
   * drag that began stops every click in the document (a capture listener
   * its sensor adds as the drag starts) until 50ms after it ends (the
   * sensor's `detach` removes it in a `setTimeout` of 50), so a click sent
   * sooner is swallowed. A page timer queued now for 60ms fires after that
   * one, since timers fire in order of expiry: a click after this lands.
   */
  async function waitOutDragClickGuard(): Promise<void> {
    await page.evaluate(() => new Promise((done) => setTimeout(done, 60)));
  }
  /** A tab's whole box in its bar, its close button included: its trigger's parent. */
  const tabBox = async (tab: Locator) => (await tab.locator('xpath=..').boundingBox())!;

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

    // Escape closes the only tab, the panel hides, and the keyboard goes
    // back to the conversation.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(conversation()).toBeFocused();
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

  /** The accessible names of the header's side panel controls, in order. */
  const headerControls = () =>
    page
      .locator('.side-panel-controls')
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  /** What the side panel store has written, as the next launch will read it. */
  const storedUses = () =>
    page.evaluate((key): Record<string, number[]> => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
      return stored.state?.uses ?? {};
    }, 'consola-side-panel');

  test('the header shows the three most-used kinds, worked out at launch', async () => {
    await openSession('Paginate the catalog search');
    await expect.poll(headerControls).toEqual(['Changes', 'Files', 'Terminal', 'Show side panel']);
    const controls = page.locator('.side-panel-controls');
    // One upright separator, between the shortcuts and the toggle.
    const separator = controls.getByRole('separator');
    await expect(separator).toHaveCount(1);
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    const separatorBox = (await separator.boundingBox())!;
    const lastShortcut = (await controls
      .getByRole('button', { name: 'Terminal', exact: true })
      .boundingBox())!;
    const toggleBox = (await sidePanelToggle().boundingBox())!;
    expect(separatorBox.x).toBeGreaterThanOrEqual(lastShortcut.x + lastShortcut.width);
    expect(separatorBox.x + separatorBox.width).toBeLessThanOrEqual(toggleBox.x);
    // Each says its chord, as main's header toggles did.
    await expect(controls.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
      'aria-keyshortcuts',
      process.platform === 'darwin' ? 'Meta+Shift+E' : 'Control+Shift+E',
    );
    await expect(controls.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+`',
    );
    await expect(changesShortcut()).not.toHaveAttribute('aria-keyshortcuts');

    // Pull request opened five times today, read at the next launch.
    await page.evaluate((key) => {
      const now = Date.now();
      localStorage.setItem(
        key,
        JSON.stringify({
          state: { uses: { 'pull-request': [now, now, now, now, now] }, rememberLayout: true },
          version: 0,
        }),
      );
    }, 'consola-side-panel');
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await openSession('Paginate the catalog search');
    await expect
      .poll(headerControls)
      .toEqual(['Changes', 'Files', 'Pull request', 'Show side panel']);

    // Terminal opened ten times through the "+" list: ten uses today, which
    // would rank it above Files. The header keeps what launch worked out.
    await sidePanelToggle().click();
    for (let opened = 0; opened < 10; opened += 1) {
      if (opened > 0) await plusButton().click();
      await newTabList().getByRole('option', { name: 'Terminal' }).click();
      await expect(sidePanelTab('Terminal')).toHaveAttribute('aria-selected', 'true');
    }
    await expect.poll(async () => (await storedUses()).terminal?.length).toBe(10);
    await expect
      .poll(headerControls)
      .toEqual(['Changes', 'Files', 'Pull request', 'Hide side panel']);
  });

  test('a shortcut that does not apply is dimmed in place, with its reason', async () => {
    await openSession('Review notes');
    await expect(changesShortcut()).toHaveAttribute('aria-disabled', 'true');
    await expect.poll(headerControls).toEqual(['Changes', 'Files', 'Terminal', 'Show side panel']);
    await changesShortcut().hover();
    await expect(page.getByRole('tooltip')).toHaveText('This folder is not a git repository.');
    // Forced: Playwright does not click what says it is disabled.
    await changesShortcut().click({ force: true });
    await expect(page.getByTestId('side-panel')).toHaveCount(0);

    // In front it is pressed and not dimmed, though Changes still does not
    // apply: opened on a session in git, the tab stays in front on this one,
    // saying why, and pressing the shortcut only hides the side panel.
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await expect(changesTab()).toHaveAttribute('aria-selected', 'true');
    await openSession('Review notes');
    await expect(changesShortcut()).toHaveAttribute('aria-pressed', 'true');
    await expect(changesShortcut()).not.toHaveAttribute('aria-disabled');
    await changesShortcut().hover();
    await expect(page.getByRole('tooltip')).toHaveText('This folder is not a git repository.');
    await changesShortcut().click();
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(changesShortcut()).toHaveAttribute('aria-pressed', 'false');
    await expect(changesShortcut()).toHaveAttribute('aria-disabled', 'true');
  });

  test('the header keeps its shortcuts and side panel toggle for a session with no checkout', async () => {
    // A worktree a cleanup rule removed, which cannot be rebuilt: its
    // repository is gone too. So the session keeps no checkout to show.
    // `removedWorktree` is main's to write (`recordWorktreesRemoved`), so the
    // test seeds it through the profile: the record is written where main
    // keeps it and read at the next launch.
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
      id: 'side-d',
      name: 'Old experiment',
      instanceId: 'side-d',
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
    ({ app, page } = await launchElectron({ userDataDir }));
    await openSession('Old experiment');
    await expect(page.locator('.workspace-view-session')).toHaveText('Old experiment');
    // No folder to show, so no git stats either.
    await expect(page.locator('.path-display-container')).toHaveCount(0);
    await expect.poll(headerControls).toEqual(['Changes', 'Files', 'Terminal', 'Show side panel']);
    const removedReason =
      'This session’s worktree was removed. It is rebuilt when the session next starts.';
    await expect(changesShortcut()).toHaveAttribute('aria-disabled', 'true');
    await changesShortcut().hover();
    await expect(page.getByRole('tooltip')).toHaveText(removedReason);

    await sidePanelToggle().click();
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await expect(newTabList()).toBeFocused();
    await expect(newTabList().getByRole('option', { name: 'Files' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await sidePanelToggle().click();
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
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
    // Two groups, with Terminal in front of the bottom one, restored from
    // storage: a mount nobody asked for, so the keyboard stays where it was.
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

  test('the tab menu splits and moves tabs', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(sidePanelTab('Files')).toHaveAttribute('aria-selected', 'true');

    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');
    await expect(tabList('Top group tabs').getByRole('tab')).toHaveText(['Changes']);
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files']);

    // From the keyboard, the same menu, under the tab. The tab is measured
    // first: an open menu hides the rest of the window from the
    // accessibility tree, and the tab with it.
    const changes = tabList('Top group tabs').getByRole('tab', { name: 'Changes', exact: true });
    const tabBox = (await changes.boundingBox())!;
    await changes.focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Close', 'Move to other group']);
    // Its top-left corner at the tab's bottom-left, once it has slid into place.
    const offTab = async () => {
      const box = (await menu.boundingBox())!;
      return Math.max(Math.abs(box.y - (tabBox.y + tabBox.height)), Math.abs(box.x - tabBox.x));
    };
    await expect.poll(offTab).toBeLessThanOrEqual(3);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Move to other group' })).toBeFocused();
    await page.keyboard.press('Enter');

    // The top group is gone; the keyboard went with the tab, along its new bar.
    await expect(tabList('Top group tabs')).toHaveCount(0);
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Files', 'Changes']);
    await expect(sidePanelTab('Changes')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(sidePanelTab('Files')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(sidePanelTab('Changes')).toBeFocused();

    // Closed from its menu, the keyboard goes to the tab now in front.
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Files']);
    await expect(sidePanelTab('Files')).toBeFocused();
    await changesShortcut().click();

    // Side by side.
    await chooseFromTabMenu(sidePanelTab('Changes'), 'Split right');
    await expect(tabList('Left group tabs').getByRole('tab')).toHaveText(['Files']);
    await expect(tabList('Right group tabs').getByRole('tab')).toHaveText(['Changes']);
  });

  /** Changes over Files: the split both restart tests arrange. */
  async function splitChangesOverFiles(): Promise<void> {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(sidePanelTab('Files')).toHaveAttribute('aria-selected', 'true');
    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');
    await expect(tabList('Top group tabs').getByRole('tab')).toHaveText(['Changes']);
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files']);
  }
  const settings = () => page.getByRole('dialog', { name: 'Settings', exact: true });
  async function openAppearanceSettings(): Promise<void> {
    await page.keyboard.press(settingsChord());
    await settings().getByRole('button', { name: 'Appearance', exact: true }).click();
  }
  const rememberLayout = () =>
    settings().getByRole('checkbox', { name: 'Remember the side panel’s layout', exact: true });

  test('a split survives a restart', async () => {
    await splitChangesOverFiles();

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await openSession('Paginate the catalog search');
    await expect(tabList('Top group tabs').getByRole('tab')).toHaveText(['Changes']);
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files']);
  });

  test('with remembering off, a restart starts from the defaults', async () => {
    await splitChangesOverFiles();

    // A function, so that it finds the window of the app relaunched below.
    const sidePanel = () => page.getByTestId('side-panel');
    const panelWidth = async () => {
      const box = await sidePanel().boundingBox();
      if (!box) throw new Error('the side panel is not on screen');
      return box.width;
    };
    const atDefault = await panelWidth();
    // The side panel's edge dragged 60px into the conversation, so its width
    // is no longer the default one.
    const separator = page.locator('.resize-handle:has(+ [data-testid="side-panel"])');
    const edge = (await separator.boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 - 60, edge.y + edge.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(panelWidth).toBeGreaterThan(atDefault + 40);
    const widened = await panelWidth();

    await openAppearanceSettings();
    await expect(rememberLayout()).toBeChecked();
    await expect(rememberLayout()).toHaveAccessibleDescription(
      'On: tabs and splits come back the way you left them. Off: the side panel starts as a single group every time, and a shortcut opens its tab there.',
    );
    await rememberLayout().uncheck();
    await expect(rememberLayout()).not.toBeChecked();
    // Off keeps the arrangement on screen for the rest of the run.
    await page.keyboard.press('Escape');
    await expect(settings()).toHaveCount(0);
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files']);

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir }));
    await openSession('Paginate the catalog search');
    await expect(page.locator('.workspace-view-session')).toHaveText('Paginate the catalog search');
    await expect(sidePanelToggle()).toHaveAccessibleName('Show side panel');
    await expect(sidePanel()).toHaveCount(0);

    await sidePanelToggle().click();
    await expect(page.locator('.side-panel-group')).toHaveCount(1);
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['New tab']);
    // Sizes are remembered whatever the setting says.
    await expect.poll(async () => Math.abs((await panelWidth()) - widened)).toBeLessThanOrEqual(2);

    await openAppearanceSettings();
    await expect(rememberLayout()).not.toBeChecked();
  });

  test('a tab closed from the keyboard hands it to a tab still on screen, else the conversation', async () => {
    const bottomFiles = () =>
      tabList('Bottom group tabs').getByRole('tab', { name: 'Files', exact: true });
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');

    // A group's only tab, closed from its menu: its bar goes with it, and the
    // keyboard goes to the group left.
    await bottomFiles().focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(tabList('Bottom group tabs')).toHaveCount(0);
    await expect(sidePanelTab('Changes')).toBeFocused();

    // The same by Delete.
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');
    await bottomFiles().focus();
    await page.keyboard.press('Delete');
    await expect(tabList('Bottom group tabs')).toHaveCount(0);
    await expect(sidePanelTab('Changes')).toBeFocused();

    // The last tab of all: the side panel hides, and the keyboard goes back
    // to the conversation.
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(conversation()).toBeFocused();
  });

  test('a right-click on a tab leaves the keyboard in the conversation', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();

    // On its close button, then an item.
    await conversation().focus();
    await page.getByRole('button', { name: 'Close Files tab', exact: true }).click({
      button: 'right',
    });
    await page.getByRole('menuitem', { name: 'Split down', exact: true }).click();
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files']);
    await expect(conversation()).toBeFocused();

    // On the tab itself, then dismissed.
    await tabList('Top group tabs')
      .getByRole('tab', { name: 'Changes', exact: true })
      .click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(conversation()).toBeFocused();
  });

  test('a Terminal tab in a group hidden by Maximize starts no shell', async () => {
    const shell = page.getByTestId('session-shell');
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(shell).toHaveCount(1);
    await chooseFromTabMenu(sidePanelTab('Terminal'), 'Split down');
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Terminal']);
    await expect(shell).toHaveCount(1);

    await group('Top group tabs').getByRole('button', { name: 'Maximize group' }).click();
    await expect(shell).toHaveCount(0);
    const shellMounts = await countShellMounts();
    await openSession('Fix flaky upload test');
    await expect(page.locator('.workspace-view-session')).toHaveText('Fix flaky upload test');
    await expect(page.locator('.git-review-panel')).toBeVisible();
    await expect(shell).toHaveCount(0);
    expect(await shellMounts()).toBe(0);

    await group('Top group tabs').getByRole('button', { name: 'Restore group' }).click();
    await expect(page.locator('.shell-directory')).toHaveText(
      `Started in: ${path.join(root, 'catalog-portal')}`,
    );
    expect(await shellMounts()).toBe(1);
  });

  test('a key held to close the last tab never repeats into the conversation', async () => {
    await openSession('Paginate the catalog search');
    await expect(conversation()).toBeVisible();
    // Every key the conversation's terminal is sent, its repeats marked. On
    // capture, as xterm listens: it stops each key there.
    await conversation().evaluate((element) => {
      const heard: string[] = [];
      (window as unknown as { __heard: string[] }).__heard = heard;
      element.addEventListener(
        'keydown',
        (event) => heard.push(event.repeat ? `${event.key} repeat` : event.key),
        true,
      );
    });
    const heard = () =>
      page.evaluate(() => (window as unknown as { __heard: string[] }).__heard.splice(0));

    // Backspace held on the last tab closes it, and the keyboard goes back
    // to the conversation, where its repeats would delete the person's text.
    await changesShortcut().click();
    await sidePanelTab('Changes').focus();
    await page.keyboard.down('Backspace');
    await expect(conversation()).toBeFocused();
    await page.keyboard.down('Backspace');
    await page.keyboard.down('Backspace');
    await page.keyboard.up('Backspace');
    // Pressed again, the key is the person's, meant for the conversation.
    await page.keyboard.press('Backspace');
    expect(await heard()).toEqual(['Backspace']);

    // Escape held on a lone placeholder: its repeats would interrupt Claude.
    await sidePanelToggle().click();
    await expect(newTabList()).toBeFocused();
    await page.keyboard.down('Escape');
    await expect(conversation()).toBeFocused();
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    expect(await heard()).toEqual([]);

    // Enter held on the menu's Close: its repeats would submit the composer.
    await changesShortcut().click();
    await sidePanelTab('Changes').focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.down('Enter');
    await expect(conversation()).toBeFocused();
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    expect(await heard()).toEqual([]);
  });

  test('a tab closed by its ✕ takes the keyboard only when the tab had it', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    const closeButton = (title: string) =>
      page.getByRole('button', { name: `Close ${title} tab`, exact: true });

    // From the conversation, the keyboard stays there.
    await conversation().focus();
    await closeButton('Changes').click();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Files']);
    await expect(conversation()).toBeFocused();

    // On the tab, it goes to the tab now in front, as a close from the keyboard does.
    await changesShortcut().click();
    await sidePanelTab('Changes').focus();
    await closeButton('Changes').click();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Files']);
    await expect(sidePanelTab('Files')).toBeFocused();

    // In what the tab shows, the same.
    await changesShortcut().click();
    await sidePanelTab('Files').click();
    await page.getByTestId('files-tree').getByText('src', { exact: true }).click();
    await closeButton('Files').click();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes']);
    await expect(sidePanelTab('Changes')).toBeFocused();
  });

  test('a tab moved or closed from its menu takes the keyboard out of its content to a tab', async () => {
    const tree = page.getByTestId('files-tree');
    const keyboardInTree = () =>
      tree.evaluate((element) => element.contains(document.activeElement));
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');

    // Moved: the content goes with the tab, and the keyboard to its trigger
    // in the bar it moved to.
    await tree.getByText('src', { exact: true }).click();
    expect(await keyboardInTree()).toBe(true);
    await chooseFromTabMenu(
      tabList('Bottom group tabs').getByRole('tab', { name: 'Files', exact: true }),
      'Move to other group',
    );
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Files']);
    await expect(sidePanelTab('Files')).toBeFocused();

    // Closed: to the tab now in front.
    await tree.getByText('src', { exact: true }).click();
    expect(await keyboardInTree()).toBe(true);
    await chooseFromTabMenu(sidePanelTab('Files'), 'Close');
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes']);
    await expect(sidePanelTab('Changes')).toBeFocused();
  });

  test('Close group hands the keyboard to the group left, and a click on it leaves it alone', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');

    // From the keyboard.
    await group('Bottom group tabs').getByRole('button', { name: 'Close group' }).focus();
    await page.keyboard.press('Enter');
    await expect(tabList('Bottom group tabs')).toHaveCount(0);
    await expect(sidePanelTab('Changes')).toBeFocused();

    // By the pointer, from the conversation.
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');
    await conversation().focus();
    await group('Bottom group tabs').getByRole('button', { name: 'Close group' }).click();
    await expect(tabList('Bottom group tabs')).toHaveCount(0);
    await expect(conversation()).toBeFocused();
  });

  test('dragging a tab to the bottom edge splits the panel', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(sidePanelTab('Files')).toHaveAttribute('aria-selected', 'true');
    // A drag is the pointer's: the keyboard stays in the conversation.
    await conversation().focus();
    const host = page.locator('.browser-host');
    await expect(host).not.toHaveAttribute('data-dragging');

    const area = (await page.locator('.side-panel-group-body').boundingBox())!;
    await dragTab(sidePanelTab('Files'), {
      x: area.x + area.width / 2,
      y: area.y + area.height * 0.9,
    });
    await expect(page.locator('.side-panel-drop-target[data-edge="bottom"]')).toBeVisible();
    // Pages let the pointer through while the tab is dragged, and nothing
    // has moved before the drop.
    await expect(host).toHaveAttribute('data-dragging', '');
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Files']);
    await page.mouse.up();

    await expect(page.locator('.side-panel-drop-target')).toHaveCount(0);
    await expect(host).not.toHaveAttribute('data-dragging');
    await expect(tabList('Top group tabs').getByRole('tab')).toHaveText(['Changes']);
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files']);
    await expect(conversation()).toBeFocused();

    // Back onto the top bar, before Changes: one group again.
    const changes = await tabBox(
      tabList('Top group tabs').getByRole('tab', { name: 'Changes', exact: true }),
    );
    await dragTab(tabList('Bottom group tabs').getByRole('tab', { name: 'Files', exact: true }), {
      x: changes.x + 4,
      y: changes.y + changes.height / 2,
    });
    await expect(page.locator('.side-panel-drop-caret')).toBeVisible();
    await page.mouse.up();
    await expect(tabList('Bottom group tabs')).toHaveCount(0);
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Files', 'Changes']);
    await expect(conversation()).toBeFocused();
  });

  test('a tab dragged along its bar lands where the caret shows, never past the "+"', async () => {
    // Wide enough that the bar has room after its "+".
    const appWindow = await app.browserWindow(page);
    await appWindow.evaluate((browserWindow) => browserWindow.setContentSize(1400, 800));
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await plusButton().click();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Files', 'New tab']);
    const caret = page.locator('.side-panel-drop-caret');
    const middle = (box: { x: number; width: number }) => box.x + box.width / 2;

    // The placeholder is never dragged: no caret follows it.
    const first = await tabBox(sidePanelTab('Changes'));
    await dragTab(sidePanelTab('New tab'), { x: first.x + 4, y: first.y + first.height / 2 });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await expect(caret).toHaveCount(0);
    await expect(page.locator('.side-panel-tab[data-dragging]')).toHaveCount(0);
    await page.mouse.up();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Files', 'New tab']);

    // Past the middle of Files, Changes goes one place along: between Files
    // and the placeholder, counted without Changes itself.
    const files = await tabBox(sidePanelTab('Files'));
    const placeholder = await tabBox(sidePanelTab('New tab'));
    await dragTab(sidePanelTab('Changes'), {
      x: files.x + files.width - 2,
      y: files.y + files.height / 2,
    });
    await expect(caret).toBeVisible();
    const between = middle((await caret.boundingBox())!);
    expect(between).toBeGreaterThanOrEqual(files.x + files.width - 1);
    expect(between).toBeLessThanOrEqual(placeholder.x + 1);
    await page.mouse.up();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Files', 'Changes', 'New tab']);

    // The bar's free space after its "+" is the bar too: a drop there goes
    // at the end, and the caret is drawn before the "+".
    const plus = (await plusButton().boundingBox())!;
    const controls = (await group('Side panel tabs')
      .getByRole('button', { name: 'Close group' })
      .boundingBox())!;
    expect(controls.x - (plus.x + plus.width)).toBeGreaterThan(40);
    await dragTab(sidePanelTab('Changes'), {
      x: (plus.x + plus.width + controls.x) / 2,
      y: plus.y + plus.height / 2,
    });
    await expect(caret).toBeVisible();
    const end = (await caret.boundingBox())!;
    expect(end.x + end.width).toBeLessThanOrEqual(plus.x);
    await page.mouse.up();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Files', 'New tab', 'Changes']);
  });

  test('Escape cancels a drag and reaches nothing else, the conversation included', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    // Every key the conversation's terminal is sent, on capture as xterm listens.
    await conversation().evaluate((element) => {
      const heard: string[] = [];
      (window as unknown as { __heard: string[] }).__heard = heard;
      element.addEventListener(
        'keydown',
        (event) => heard.push(event.repeat ? `${event.key} repeat` : event.key),
        true,
      );
    });
    const heard = () =>
      page.evaluate(() => (window as unknown as { __heard: string[] }).__heard.splice(0));
    // The person is typing to Claude.
    await conversation().focus();
    await page.keyboard.type('hi');
    expect(await heard()).toEqual(['h', 'i']);

    // Dragged by its ✕, which leaves the keyboard in the conversation.
    const area = (await page.locator('.side-panel-group-body').boundingBox())!;
    await dragTab(page.getByRole('button', { name: 'Close Files tab', exact: true }), {
      x: area.x + area.width / 2,
      y: area.y + area.height * 0.9,
    });
    const target = page.locator('.side-panel-drop-target');
    await expect(target).toBeVisible();
    await expect(conversation()).toBeFocused();

    // Escape, held: the drag is cancelled, and neither the key nor its
    // repeats reach the conversation, where Escape interrupts Claude.
    await page.keyboard.down('Escape');
    await expect(target).toHaveCount(0);
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await page.mouse.up();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Files']);
    await expect(tabList('Bottom group tabs')).toHaveCount(0);
    expect(await heard()).toEqual([]);
    await expect(conversation()).toBeFocused();
    // Pressed once the drag is over, Escape is the conversation's again.
    await page.keyboard.press('Escape');
    expect(await heard()).toEqual(['Escape']);
  });

  test('Escape is held only while a drag lasts, even one that ends before it begins', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await conversation().evaluate((element) => {
      const heard: string[] = [];
      (window as unknown as { __heard: string[] }).__heard = heard;
      element.addEventListener('keydown', (event) => heard.push(event.key), true);
    });
    const heard = () =>
      page.evaluate(() => (window as unknown as { __heard: string[] }).__heard.splice(0));
    await conversation().focus();

    // A press, a move past the 6px that starts a drag, and the release, all
    // in one task: the drag ends before dnd-kit has rendered its start, and
    // so with neither its end nor its cancel.
    await sidePanelTab('Files').evaluate((trigger) => {
      const box = trigger.getBoundingClientRect();
      const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      const send = (target: EventTarget, type: string, dx: number) =>
        target.dispatchEvent(
          new MouseEvent(type, { bubbles: true, button: 0, ...at, clientX: at.clientX + dx }),
        );
      send(trigger, 'mousedown', 0);
      send(document, 'mousemove', 10);
      send(document, 'mouseup', 10);
    });
    await expect(conversation()).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await heard()).toEqual(['Escape']);
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Files']);

    // A drag that does begin holds Escape until it is over, and no longer.
    const area = (await page.locator('.side-panel-group-body').boundingBox())!;
    await dragTab(page.getByRole('button', { name: 'Close Files tab', exact: true }), {
      x: area.x + area.width / 2,
      y: area.y + area.height * 0.9,
    });
    await expect(page.locator('.side-panel-drop-target')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.side-panel-drop-target')).toHaveCount(0);
    await page.mouse.up();
    expect(await heard()).toEqual([]);
    await page.keyboard.press('Escape');
    expect(await heard()).toEqual(['Escape']);
  });

  test('a tab closed while it is dragged still holds Escape until the drag is over', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    // Every key anything in the window is sent, wherever the keyboard is.
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as unknown as { __heard: string[] }).__heard = heard;
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.isTrusted) heard.push(event.key);
        },
        true,
      );
    });
    const heard = () =>
      page.evaluate(() => (window as unknown as { __heard: string[] }).__heard.splice(0));

    // Pressed, the tab takes the keyboard, so Delete there closes it while
    // it is dragged. The drag goes on without it until the release.
    const area = (await page.locator('.side-panel-group-body').boundingBox())!;
    await dragTab(sidePanelTab('Files'), {
      x: area.x + area.width / 2,
      y: area.y + area.height / 2,
    });
    await expect(page.locator('.side-panel-tab[data-dragging]')).toHaveCount(1);
    await expect(sidePanelTab('Files')).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes']);
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 3, { steps: 2 });
    expect(await heard()).toEqual(['Delete']);

    // Escape cancels it, and reaches nothing else.
    await page.keyboard.press('Escape');
    expect(await heard()).toEqual([]);
    await page.mouse.up();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes']);
    // Pressed once the drag is over, it is heard again.
    await page.keyboard.press('Escape');
    expect(await heard()).toEqual(['Escape']);
  });

  test('a tab closed while it is dragged leaves the keyboard where the close put it', async () => {
    await openSession('Paginate the catalog search');
    await changesShortcut().click();
    const area = (await page.locator('.side-panel-group-body').boundingBox())!;
    /** From the conversation, Files pressed, dragged, and closed by Delete on the way. */
    const closeFilesMidDrag = async () => {
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await conversation().focus();
      await dragTab(sidePanelTab('Files'), {
        x: area.x + area.width / 2,
        y: area.y + area.height / 2,
      });
      await expect(page.locator('.side-panel-tab[data-dragging]')).toHaveCount(1);
      await page.keyboard.press('Delete');
      await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes']);
      await expect(sidePanelTab('Changes')).toBeFocused();
    };
    const twoFrames = () =>
      page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );

    // Released: there is no tab to drop, nor a keyboard to give back.
    await closeFilesMidDrag();
    await page.mouse.up();
    await twoFrames();
    await expect(sidePanelTab('Changes')).toBeFocused();

    // Cancelled by Escape: the same. It begins with a click on Files.
    await waitOutDragClickGuard();
    await closeFilesMidDrag();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await twoFrames();
    await expect(sidePanelTab('Changes')).toBeFocused();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes']);
  });

  test('no layout change remounts the conversation terminal', async () => {
    await openSession('Paginate the catalog search');
    const xterm = page.locator('[data-conversation-terminal] .xterm');
    await expect(xterm).toBeVisible();
    // The conversation's xterm, which a remount would replace, and the
    // browser's host, which lives at the layout's root and which no layout
    // change may touch.
    await page.evaluate(() => {
      const kept = window as unknown as Record<string, Element | null>;
      kept.__conversation = document.querySelector('[data-conversation-terminal] .xterm');
      kept.__browserHost = document.querySelector('.browser-host');
    });
    const same = () =>
      page.evaluate(() => {
        const kept = window as unknown as Record<string, Element | null>;
        const still = (name: string, selector: string) =>
          !!kept[name]?.isConnected && document.querySelector(selector) === kept[name];
        return {
          conversation: still('__conversation', '[data-conversation-terminal] .xterm'),
          browserHost: still('__browserHost', '.browser-host'),
        };
      });
    const untouched = async (after: string) =>
      expect(await same(), after).toEqual({ conversation: true, browserHost: true });
    const width = async () => (await xterm.boundingBox())?.width ?? 0;
    const shell = page.getByTestId('session-shell');

    // Shown, the side panel takes its width from the conversation, which
    // only resizes.
    const alone = await width();
    await sidePanelToggle().click();
    await expect(newTabList()).toBeFocused();
    await untouched('the side panel shown');
    await newTabList().getByRole('option', { name: 'Changes' }).click();
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(width).toBeLessThan(alone - 100);
    await untouched('Changes chosen');

    // Files, Terminal and Browser, each opened in the same group.
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(sidePanelTab('Files')).toHaveAttribute('aria-selected', 'true');
    await untouched('Files opened');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(shell).toHaveCount(1);
    await untouched('Terminal opened');
    await page.keyboard.press(browserChord());
    await expect(page.getByTestId('browser-panel')).toBeVisible();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText([
      'Changes',
      'Files',
      'Terminal',
      'Browser',
    ]);
    await untouched('Browser opened');

    // Files split down by its menu, its group maximized, then restored.
    await chooseFromTabMenu(sidePanelTab('Files'), 'Split down');
    await expect(tabList('Top group tabs').getByRole('tab')).toHaveText([
      'Changes',
      'Terminal',
      'Browser',
    ]);
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files']);
    await untouched('Files split down');
    await group('Bottom group tabs').getByRole('button', { name: 'Maximize group' }).click();
    await expect(tabList('Top group tabs')).toHaveCount(0);
    await untouched('the bottom group maximized');
    await group('Bottom group tabs').getByRole('button', { name: 'Restore group' }).click();
    await expect(tabList('Top group tabs')).toHaveCount(1);
    await untouched('the bottom group restored');

    // Terminal dragged onto the bottom bar, after Files.
    const files = await tabBox(
      tabList('Bottom group tabs').getByRole('tab', { name: 'Files', exact: true }),
    );
    await dragTab(tabList('Top group tabs').getByRole('tab', { name: 'Terminal', exact: true }), {
      x: files.x + files.width + 20,
      y: files.y + files.height / 2,
    });
    await expect(page.locator('.side-panel-drop-caret')).toBeVisible();
    await untouched('Terminal dragged');
    await page.mouse.up();
    await expect(tabList('Top group tabs').getByRole('tab')).toHaveText(['Changes', 'Browser']);
    await expect(tabList('Bottom group tabs').getByRole('tab')).toHaveText(['Files', 'Terminal']);
    await expect(shell).toHaveCount(1);
    await untouched('Terminal dropped on the bottom bar');

    // The bottom group closed, with its two tabs.
    await waitOutDragClickGuard();
    await group('Bottom group tabs').getByRole('button', { name: 'Close group' }).click();
    await expect(tabList('Bottom group tabs')).toHaveCount(0);
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Browser']);
    await expect(shell).toHaveCount(0);
    await untouched('the bottom group closed');

    // The side panel's edge dragged 80px into the conversation.
    const separator = page.locator('.resize-handle:has(+ [data-testid="side-panel"])');
    const edge = (await separator.boundingBox())!;
    const beside = await width();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 - 80, edge.y + edge.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(width).toBeLessThan(beside - 60);
    await untouched('the side panel widened');

    // Hidden and shown with ⌥⌘B.
    await conversation().focus();
    await page.keyboard.press(sidePanelChord);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await untouched('the side panel hidden');
    await page.keyboard.press(sidePanelChord);
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Changes', 'Browser']);
    await untouched('the side panel shown again');

    // Every tab closed, until the side panel hides with the last.
    await page.getByRole('button', { name: 'Close Changes tab', exact: true }).click();
    await expect(sidePanelTabs().getByRole('tab')).toHaveText(['Browser']);
    await untouched('Changes closed');
    await page.getByRole('button', { name: 'Close Browser tab', exact: true }).click();
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await untouched('Browser closed, and the side panel with it');
    // The whole width again.
    await expect.poll(width).toBeGreaterThan(alone - 2);
  });
});
