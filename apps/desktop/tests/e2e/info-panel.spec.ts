import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NewSessionFields } from '../../src/shared/workspace';
import { CONVERSATION_ROOM_PX, INFO_PANEL_ROOM_PX } from '../../src/renderer/infoPanel/stepAside';
import { commandPaletteChord, launchElectron } from './helpers/electron';
import { infoPanel, infoPanelChord, infoSection, roomForBothPanels } from './helpers/infoPanel';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');

/**
 * The info panel beside a session's conversation: a glance at where the
 * session runs, its branch and its pull request, in sections that fold.
 */
test.describe('info panel', () => {
  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let root: string;
  let env: Record<string, string>;
  /** The clone's own checkout, on `feat/search-pagination`. */
  let repo: string;
  /** The second checkout, a linked worktree of the clone on `docs/readme`. */
  let docs: string;
  /** Where the stub reads #51's details from. */
  let detailsDir: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=JaviDev', '-c', 'user.email=javidev@sprocket.example', ...args],
      { cwd, stdio: 'pipe' },
    );

  test.beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-info-panel-')));
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };

    // origin, seeded with one commit on main.
    const origin = path.join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    write(path.join(seed, 'src', 'search.ts'), 'export const pageSize = 20;\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'Search the catalog');
    git(seed, 'push', '-q', origin, 'main');
    fs.rmSync(seed, { recursive: true, force: true });

    // The clone, so origin/HEAD is set: feat/search-pagination pushed once,
    // then two commits ahead of it, and one uncommitted line.
    repo = path.join(root, 'catalog-portal');
    git(root, 'clone', '-q', origin, repo);
    git(repo, 'checkout', '-q', '-b', 'feat/search-pagination');
    write(path.join(repo, 'src', 'cursor.ts'), 'export function cursor() {\n  return 0;\n}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'Add a cursor');
    git(repo, 'push', '-q', '-u', 'origin', 'feat/search-pagination');
    write(path.join(repo, 'src', 'query.ts'), 'export const query = "";\nexport const page = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'Add a query');
    write(
      path.join(repo, 'tests', 'search.test.ts'),
      'import { query } from "../src/query";\n\ntest("query", () => {});\nvoid query;\n',
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'Test the search');
    write(path.join(repo, 'src', 'search.ts'), 'export const pageSize = 50;\n');
    // Where a real clone would point. Nothing here ever fetches.
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/sprocket/catalog-portal.git');

    // A second checkout of the clone, and a folder outside git.
    docs = path.join(root, 'catalog-portal-docs');
    git(repo, 'worktree', 'add', '-q', '--no-track', '-b', 'docs/readme', docs, 'origin/main');
    const notes = path.join(root, 'notes');
    fs.mkdirSync(notes);

    // The agent, which answers the health probe's --version at once.
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
    // The harness's own config folder, signed in as a fictional account, so
    // nothing reads the person's real Claude config.
    const configDir = path.join(root, 'claude-config');
    write(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'javidev@sprocket.example' } }),
    );

    // GitHub's answers for each branch's pull requests: A's branch has #51,
    // B's none. Any other branch is a 404.
    const pulls = path.join(root, 'pulls.txt');
    const pullsOf = 'repos/sprocket/catalog-portal/pulls?state=all&per_page=20&head=sprocket%3A';
    fs.writeFileSync(
      pulls,
      [
        `${pullsOf}feat%2Fsearch-pagination [{"number":51,"state":"open","merged_at":null,"html_url":"https://github.com/sprocket/catalog-portal/pull/51","created_at":"2026-11-18T09:00:00Z","head":{"sha":"${'a'.repeat(40)}","ref":"feat/search-pagination"}}]`,
        `${pullsOf}docs%2Freadme []`,
        '',
      ].join('\n'),
    );
    // #51's details, in a copy a test may change: a fixture moved away fails
    // the read that needs it.
    detailsDir = path.join(root, 'details');
    fs.cpSync(path.join(STUB_GH_DIR, 'details'), detailsDir, { recursive: true });
    env = {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      STUB_GH_LOG: path.join(root, 'gh.log'),
      STUB_GH_PULLS: pulls,
      STUB_GH_PULLS_HOLD: path.join(root, 'pulls.hold'),
      STUB_GH_DETAILS_DIR: detailsDir,
      // While this file exists, GitHub refuses every write.
      STUB_GH_MUTATION_FAILURE_FILE: path.join(root, 'writes.refused'),
      // Every git command main runs, so a test can count its reads.
      GIT_TRACE: path.join(root, 'git-trace.log'),
    };

    ({ app, page, userDataDir } = await launchElectron({ env }));
    await page.evaluate(
      async ({ repo, docs, notes, stub, configDir }) => {
        await window.harnessStateAPI.addHarness({
          id: 'info-panel-stub',
          driverId: 'claude',
          name: 'Stub',
          binaryPath: stub,
          configDir,
          accentColor: '#555555',
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Sprocket',
          repo,
          true,
          'info-panel-stub',
        );
        await window.workspaceAPI.setProviderBinding(workspace.id, {
          id: 'github',
          accountLogin: 'JaviDev',
          org: 'sprocket',
        });
        const session = (name: string, instanceId: string, more: Partial<NewSessionFields> = {}) =>
          window.workspaceAPI.createSession(workspace.id, {
            name,
            nameIsUserSet: true,
            workspaceId: workspace.id,
            instanceId,
            harnessId: 'info-panel-stub',
            scopeId: workspace.scopes[0].id,
            ...more,
          });
        await session('Paginate the catalog search', 'info-a');
        await session('Update the readme', 'info-b', { cwd: docs });
        await session('Review notes', 'info-c', { cwd: notes });
        // Started from #51 with the Fix CI action, in the clone's own checkout.
        await session('Fix CI for billing', 'info-d', {
          workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 },
          workItemAction: 'Fix CI',
        });
      },
      { repo, docs, notes, stub, configDir },
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

  const conversation = () =>
    page.locator('[data-conversation-terminal] .terminal-surface textarea');
  /** The folder row, a button that copies the path: named `<kind> <path>. Copy folder path`. */
  const folderRow = (kind: string) =>
    infoSection(page, 'Environment').getByRole('button', {
      name: new RegExp(`^${kind} .+\\. Copy folder path$`),
    });
  /**
   * The Folder row's card, which explains the checkout, and its parts. Child
   * combinators: Radix also renders a visually hidden copy of the content for
   * screen readers, which a descendant query would count twice.
   */
  const checkoutCard = () => page.locator('.checkout-tooltip');
  const checkoutCardTitle = () => page.locator('.checkout-tooltip > .checkout-tooltip-title');
  const checkoutCardHint = () => page.locator('.checkout-tooltip > .checkout-tooltip-hint');
  /** The Branch section's first row: the checkout's branch, and what waits to be pushed. */
  const branchRow = (branch: string) =>
    infoSection(page, 'Branch').locator('.info-row').filter({ hasText: branch });
  /** Uncommitted, a button that opens Changes: named `Uncommitted, <value>. Open Changes`. */
  const uncommitted = () =>
    infoSection(page, 'Branch').getByRole('button', { name: /^Uncommitted, .+\. Open Changes$/ });
  /**
   * The session header's buttons out of reach, by name: not wholly inside
   * the window, or with something else drawn over their centre. None, when
   * each is on screen and takes its own click.
   */
  const coveredHeaderControls = () =>
    page.locator('.workspace-view-header').evaluate((row) =>
      [...row.querySelectorAll('button')]
        .filter((button) => {
          const box = button.getBoundingClientRect();
          if (box.width === 0 || box.left < 0 || box.right > window.innerWidth) return true;
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return !hit || !button.contains(hit);
        })
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    );
  /** Gives the window this content width, as a person narrowing it would. */
  const windowWidth = async (width: number) => {
    const appWindow = await app.browserWindow(page);
    await appWindow.evaluate(
      (browserWindow, size) => browserWindow.setContentSize(size, 700),
      width,
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  };
  /** The session pane's width, which the conversation and both panels share. */
  const paneWidth = async () =>
    (await page.locator('.workspace-view-content').boundingBox())?.width ?? 0;
  /** Gives the window the width that leaves the session pane `width` wide. */
  const windowForPane = async (width: number) => {
    const besidePane = (await page.evaluate(() => window.innerWidth)) - (await paneWidth());
    await windowWidth(Math.round(width + besidePane));
  };
  /**
   * The conversation's 60 columns, as drawn. react-resizable-panels turns
   * `CONVERSATION_ROOM_PX` into a share of the panels' widths, which it
   * measures in whole pixels, so the floor lands within a pixel of it.
   */
  const SIXTY_COLUMNS = CONVERSATION_ROOM_PX - 1;
  /** A panel's width in the session pane, by its id: `agent` is the conversation. */
  const panelWidth = async (id: 'agent' | 'info-panel' | 'side-panel') =>
    (await page.getByTestId(id).boundingBox())?.width ?? 0;
  /** Holds on to the conversation's xterm, which a remount would replace. */
  const holdConversation = () =>
    page.evaluate(() => {
      (window as unknown as Record<string, Element | null>).__conversation = document.querySelector(
        '[data-conversation-terminal] .xterm',
      );
    });
  /** Whether the conversation still has the xterm `holdConversation` held. */
  const sameConversation = () =>
    page.evaluate(() => {
      const kept = (window as unknown as Record<string, Element | null>).__conversation;
      return (
        !!kept?.isConnected &&
        document.querySelector('[data-conversation-terminal] .xterm') === kept
      );
    });
  /** Adds a session to Sprocket, in `cwd`, once the app is up. */
  const addSession = (name: string, instanceId: string, cwd: string) =>
    page.evaluate(
      async ({ name, instanceId, cwd }) => {
        const { workspaces } = await window.workspaceAPI.getSnapshot();
        const workspace = workspaces.find((candidate) => candidate.name === 'Sprocket');
        if (!workspace) throw new Error('No Sprocket workspace');
        await window.workspaceAPI.createSession(workspace.id, {
          name,
          nameIsUserSet: true,
          workspaceId: workspace.id,
          instanceId,
          harnessId: 'info-panel-stub',
          scopeId: workspace.scopes[0].id,
          cwd,
        });
      },
      { name, instanceId, cwd },
    );
  /** Copies land in a stand-in for the clipboard, never the person's own. */
  const standInClipboard = () =>
    page.evaluate(() => {
      const copied: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = copied;
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => {
          copied.push(text);
        },
      });
    });
  const copiedPaths = () =>
    page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  /** The branch against its base, a plain fact. */
  const baseRow = (ref: string) =>
    infoSection(page, 'Branch')
      .locator('.info-row')
      .filter({ hasText: `vs ${ref}` });
  /** Session D, started from #51: its sidebar row reads as the item and the action. */
  const FIX_CI = 'PR #51 · Fix CI';
  const prSection = () => infoSection(page, 'Pull request');
  /** The controls beside the section's heading, drawn while it is open. */
  const prActions = () => prSection().locator('.info-section-actions');
  const prTitle = () =>
    prSection().getByRole('button', { name: 'Extract billing client #51', exact: true });
  /** The pane in the side panel's Pull request tab, where GitHub's item is drawn. */
  const remote = () =>
    page.getByTestId('work-item-panel').getByRole('region', { name: 'Remote item details' });
  const sidePanelTab = (name: string) =>
    page.getByRole('tablist', { name: 'Side panel tabs' }).getByRole('tab', { name, exact: true });
  /**
   * How many times #51's details were read: each read asks REST for its
   * changed files, alongside its GraphQL queries, so those requests count
   * the reads.
   */
  const detailReadsOf51 = () => {
    const log = env.STUB_GH_LOG;
    return (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter((line) => line.includes('repos/sprocket/catalog-portal/pulls/51/files')).length;
  };
  /** How many times GitHub was asked for the pull requests whose head is `branch`. */
  const lookupsOf = (branch: string) => {
    const log = env.STUB_GH_LOG;
    return (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter((line) => line.includes(`head=sprocket%3A${encodeURIComponent(branch)}`)).length;
  };
  /**
   * How many times main read a branch's facts, of any checkout: each read
   * asks git for the upstream this way once (`gitBranch.ts`), and nothing
   * else in main does.
   */
  const branchFactsReads = () => {
    const trace = env.GIT_TRACE;
    return (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '')
      .split('\n')
      .filter((line) => line.includes('rev-parse --abbrev-ref --symbolic-full-name')).length;
  };
  /** #51's header in the stub's details, which a read of them needs. */
  const pullRequestFixture = () => path.join(detailsDir, 'ConsolaPullRequest.json');
  /** The next read of #51's details fails, as GitHub's would, until `answerReads`. */
  const failReads = () => fs.renameSync(pullRequestFixture(), `${pullRequestFixture()}.away`);
  const answerReads = () => fs.renameSync(`${pullRequestFixture()}.away`, pullRequestFixture());
  const sidePanelToggle = () => page.getByRole('button', { name: /^(Show|Hide) side panel/ });
  /** The side panel's list of kinds, which an empty side panel shows when it is shown. */
  const newTabOption = (name: string) =>
    page
      .getByRole('listbox', { name: 'Open in this tab' })
      .getByRole('option', { name, exact: true });
  /** Shows the side panel, empty, and picks a kind from its list by its key, once the list has the keyboard. */
  const openTabFromList = async (key: string) => {
    await sidePanelToggle().click();
    await expect(page.getByRole('listbox', { name: 'Open in this tab' })).toBeFocused();
    await page.keyboard.press(key);
  };
  const FOUND = 'Found from the branch';

  test('the info panel sits beside the conversation, and its toggle and chord hide and show it', async () => {
    await openSession('Paginate the catalog search');
    await expect(infoPanel(page)).toBeVisible();
    const hide = page.getByRole('button', { name: 'Hide info panel', exact: true });
    await expect(hide).toHaveAttribute('aria-pressed', 'true');
    // In the header's controls, right before the side panel's toggle.
    expect(
      await hide.evaluate((button) => {
        const controls = button.closest('.side-panel-controls');
        // Its label may go on to say a mark, once the Inbox has been read.
        const sidePanel = controls?.querySelector('[aria-label^="Show side panel"]');
        return (
          !!sidePanel &&
          !!(button.compareDocumentPosition(sidePanel) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);

    await hide.click();
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Show info panel', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');

    // The chord from the conversation shows it, and leaves the keyboard there.
    await conversation().focus();
    await page.keyboard.press(infoPanelChord());
    await expect(infoPanel(page)).toBeVisible();
    await expect(conversation()).toBeFocused();

    await page.keyboard.press(commandPaletteChord());
    await page.keyboard.type('Hide info panel');
    await page.keyboard.press('Enter');
    await expect(infoPanel(page)).toHaveCount(0);
  });

  test('⌥⌘J on a row of the panel hands the keyboard to the conversation, and in a shell types nothing there', async () => {
    // The Terminal tab beside the panel, which needs a wide window.
    await roomForBothPanels(app, page);
    await openSession('Paginate the catalog search');

    // The row goes with the panel, so the keyboard goes to the conversation,
    // never to the body.
    await folderRow('Main checkout').focus();
    await expect(folderRow('Main checkout')).toBeFocused();
    await page.keyboard.press(infoPanelChord());
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(conversation()).toBeFocused();
    await page.keyboard.press(infoPanelChord());
    await expect(infoPanel(page)).toBeVisible();
    await expect(conversation()).toBeFocused();

    // In the Terminal tab's shell, running `cat -v`, which prints back every
    // byte it is sent, an escape as `^[`.
    await page.keyboard.press('Control+Backquote');
    const shell = page.getByTestId('session-shell');
    const input = shell.locator('textarea');
    await expect(input).toBeFocused();
    const shellLines = () =>
      shell
        .locator('.xterm-rows > div')
        .evaluateAll((rows) => rows.map((row) => (row.textContent ?? '').trim()));
    await input.pressSequentially("printf 'rea''dy\\n'; cat -v");
    await page.keyboard.press('Enter');
    await expect.poll(shellLines, { timeout: 15_000 }).toContain('ready');

    // The chord hides the panel and shows it again, and the keyboard stays
    // in the shell.
    await page.keyboard.press(infoPanelChord());
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(input).toBeFocused();
    await page.keyboard.press(infoPanelChord());
    await expect(infoPanel(page)).toBeVisible();
    await expect(input).toBeFocused();

    // The line typed next, as the terminal echoes it and as `cat -v` prints
    // it, and no other line after `ready`, so the shell was sent nothing by
    // the chord. Off macOS the chord is Ctrl+Alt+J, which xterm would send as
    // an escape and a line feed: `cat -v` would print a `^[` line of its own.
    // On macOS xterm never sends a ⌘ chord, so there this guards the toggle
    // and the keyboard staying in the shell.
    await page.keyboard.type('end');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const lines = await shellLines();
        return lines.slice(lines.indexOf('ready') + 1).filter((line) => line !== '');
      })
      .toEqual(['end', 'end']);
  });

  test('on the default window the info panel steps aside for the side panel, and is back when there is room', async () => {
    await openSession('Paginate the catalog search');
    await expect(infoPanel(page)).toBeVisible();
    const show = () => page.getByRole('button', { name: 'Show info panel', exact: true });
    const hide = () => page.getByRole('button', { name: 'Hide info panel', exact: true });
    const changes = () =>
      page.locator('.side-panel-controls').getByRole('button', { name: 'Changes', exact: true });
    const sidePanel = () => page.getByTestId('side-panel');
    // The conversation's xterm, which a remount would replace.
    await page.evaluate(() => {
      (window as unknown as Record<string, Element | null>).__conversation = document.querySelector(
        '[data-conversation-terminal] .xterm',
      );
    });
    const same = () =>
      page.evaluate(() => {
        const kept = (window as unknown as Record<string, Element | null>).__conversation;
        return (
          !!kept?.isConnected &&
          document.querySelector('[data-conversation-terminal] .xterm') === kept
        );
      });
    const widthOf = async (testId: string) =>
      (await page.getByTestId(testId).boundingBox())?.width ?? 0;

    // The side panel opens: the info panel steps aside, the toggle says so,
    // and the conversation has its width back.
    await changes().click();
    await expect(sidePanel()).toBeVisible();
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(show()).toHaveAttribute('aria-pressed', 'false');
    // Beside the side panel at its default 40%, the conversation is the rest
    // of the pane, about 420px on this window, where beside both panels it
    // kept about 160px.
    const pane = (await page.locator('.workspace-view-content').boundingBox())?.width ?? 0;
    const edge =
      (await page.locator('.resize-handle:has(+ [data-testid="side-panel"])').boundingBox())
        ?.width ?? 0;
    await expect
      .poll(async () =>
        Math.abs(pane - (await widthOf('side-panel')) - edge - (await widthOf('agent'))),
      )
      .toBeLessThan(1.5);
    expect(await widthOf('agent')).toBeGreaterThanOrEqual(400);
    expect(await same(), 'the info panel stepped aside').toBe(true);

    // The side panel hides: the info panel is back.
    await changes().click();
    await expect(sidePanel()).toHaveCount(0);
    await expect(infoPanel(page)).toBeVisible();
    await expect(hide()).toHaveAttribute('aria-pressed', 'true');
    expect(await same(), 'the info panel back').toBe(true);

    // A row that opens a tab takes the panel, and the row just pressed, with
    // it: the keyboard goes to the conversation, never the body.
    await uncommitted().click();
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(conversation()).toBeFocused();

    // The person shows it anyway, beside the side panel, until the side
    // panel next hides.
    await show().click();
    await expect(infoPanel(page)).toBeVisible();
    await expect(sidePanel()).toBeVisible();
    await expect(hide()).toHaveAttribute('aria-pressed', 'true');
    expect(await same(), 'the info panel kept').toBe(true);
    await changes().click();
    await expect(sidePanel()).toHaveCount(0);
    await expect(infoPanel(page)).toBeVisible();
    await changes().click();
    await expect(sidePanel()).toBeVisible();
    await expect(infoPanel(page)).toHaveCount(0);
    expect(await same(), 'the info panel stepped aside again').toBe(true);

    // Nothing was written: the next launch shows the panel once the side
    // panel hides.
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir, env }));
    await openSession('Paginate the catalog search');
    await expect(sidePanel()).toBeVisible();
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(show()).toHaveAttribute('aria-pressed', 'false');
    await changes().click();
    await expect(sidePanel()).toHaveCount(0);
    await expect(infoPanel(page)).toBeVisible();
    await expect(hide()).toHaveAttribute('aria-pressed', 'true');
  });

  test('on a wide window the info panel stays beside the side panel', async () => {
    await roomForBothPanels(app, page);
    await openSession('Paginate the catalog search');
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await expect(infoPanel(page)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Hide info panel', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('beside both panels the conversation keeps 60 columns while the pane holds them', async () => {
    await openSession('Paginate the catalog search');
    await expect(infoPanel(page)).toBeVisible();
    await holdConversation();
    const sidePanel = () => page.getByTestId('side-panel');
    /** The panels' widths and their total, which each size is a share of (no separators). */
    const widths = async () => {
      const [agent, info, side] = await Promise.all(
        (['agent', 'info-panel', 'side-panel'] as const).map(panelWidth),
      );
      return { agent, side, panels: agent + info + side };
    };

    // A pane just over the room for all three, and the side panel opened at
    // its default 40%, which would leave the conversation about 360px: the
    // panels give way instead, the side panel among them.
    await windowForPane(INFO_PANEL_ROOM_PX + 10);
    await page
      .locator('.side-panel-controls')
      .getByRole('button', { name: 'Changes', exact: true })
      .click();
    await expect(sidePanel()).toBeVisible();
    await expect(infoPanel(page)).toBeVisible();
    await expect.poll(() => panelWidth('agent')).toBeGreaterThanOrEqual(SIXTY_COLUMNS);
    const opened = await widths();
    expect(opened.side).toBeLessThan(0.4 * opened.panels - 4);
    expect(await sameConversation(), 'the side panel opened beside both').toBe(true);

    // The default window: the info panel steps aside, and the 60 columns go
    // with it.
    await windowWidth(1000);
    await expect(infoPanel(page)).toHaveCount(0);
    expect(await sameConversation(), 'the info panel stepped aside').toBe(true);

    // The person keeps the panel, on a pane with no room for 60 columns
    // beside both: the conversation can still go down to a fifth of it.
    await page.getByRole('button', { name: 'Show info panel', exact: true }).click();
    await expect(infoPanel(page)).toBeVisible();
    await expect(sidePanel()).toBeVisible();
    const edge = (await page.locator('.info-panel-resize-handle').boundingBox())!;
    const paneLeft = (await page.locator('.workspace-view-content').boundingBox())!.x;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(paneLeft + 4, edge.y + edge.height / 2, { steps: 8 });
    await page.mouse.up();
    const conversationShare = async () => {
      const { agent, panels } = await widths();
      return agent / panels;
    };
    await expect.poll(conversationShare).toBeLessThan(0.21);
    expect(await conversationShare()).toBeGreaterThan(0.19);
    expect(await sameConversation(), 'kept on a narrow pane').toBe(true);

    // Room again: the keep ends, all three stay, and the conversation has its
    // 60 columns back from the split the narrow pane left.
    await windowWidth(1400);
    await expect(infoPanel(page)).toBeVisible();
    await expect(sidePanel()).toBeVisible();
    await expect.poll(() => panelWidth('agent')).toBeGreaterThanOrEqual(SIXTY_COLUMNS);
    expect(await sameConversation(), 'room again').toBe(true);
  });

  test('a split saved with the conversation at its narrow floor restores with 60 columns on a wide window', async () => {
    // react-resizable-panels' key for the session pane's three-panel layout.
    const allThree = 'react-resizable-panels:session-pane:agent:info-panel:side-panel';
    await roomForBothPanels(app, page);
    await openSession('Paginate the catalog search');
    await page
      .locator('.side-panel-controls')
      .getByRole('button', { name: 'Changes', exact: true })
      .click();
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await expect(infoPanel(page)).toBeVisible();
    // What a keep on a narrow window leaves saved: the conversation dragged
    // to a fifth of the pane. Written after the last layout change, just
    // before the app quits.
    await page.evaluate(
      (key) =>
        localStorage.setItem(
          key,
          JSON.stringify({ agent: 20, 'info-panel': 35, 'side-panel': 45 }),
        ),
      allThree,
    );
    await app.close();

    ({ app, page } = await launchElectron({ userDataDir, env }));
    // The window comes back as wide as it was, the side panel open beside
    // the info panel.
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1400);
    await openSession('Paginate the catalog search');
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await expect(infoPanel(page)).toBeVisible();
    await expect.poll(() => panelWidth('agent')).toBeGreaterThanOrEqual(SIXTY_COLUMNS);
  });

  test('Environment says where each session runs', async () => {
    await openSession('Paginate the catalog search');
    const environment = infoSection(page, 'Environment');
    // The driver's label, as the sidebar's harness mark words it, and the
    // account its config folder is signed in as.
    const harnessRow = environment.locator('.info-row').filter({ hasText: 'Claude Code · Stub' });
    await expect(harnessRow).toBeVisible();
    // The row says what the harness's health last read, and asks nothing
    // itself: the person's re-check reads it, from the stub's own folder.
    await page.keyboard.press(commandPaletteChord());
    await page.keyboard.type('Re-check harnesses');
    await page.keyboard.press('Enter');
    await expect(harnessRow).toContainText('javidev@sprocket.example');
    // The re-check probes the built-in harness too, which the launch pins to
    // a stub and a folder of the profile's: never the person's own Claude.
    const builtIn = await page.evaluate(
      async () =>
        (await window.harnessStateAPI.getSnapshot()).harnesses.find(
          (harness) => harness.isBuiltIn,
        ) ?? null,
    );
    expect(builtIn?.binaryPath?.startsWith(`${userDataDir}${path.sep}`)).toBe(true);
    expect(builtIn?.configDir?.startsWith(`${userDataDir}${path.sep}`)).toBe(true);
    await expect(folderRow('Main checkout')).toBeVisible();
    // The computer's name, or "This Mac": never an empty row.
    await expect(environment.locator('.info-row').first()).toHaveText(/\S/);
    // Pointed at, the row's card says what a main checkout is, and no native
    // title shows beside it.
    await folderRow('Main checkout').hover();
    await expect(checkoutCardTitle()).toHaveText('Main checkout');
    await expect(checkoutCard()).toContainText(
      'This session works directly in the folder you opened, not in a worktree.',
    );
    await expect(folderRow('Main checkout')).not.toHaveAttribute('title');

    await openSession('Update the readme');
    await expect(folderRow('Worktree')).toBeVisible();
    await folderRow('Worktree').hover();
    await expect(checkoutCardTitle()).toHaveText('Worktree');
    await expect(checkoutCard()).toContainText('docs/readme');
    await expect(checkoutCardHint()).toHaveText('Click to copy the folder path');
    await standInClipboard();
    await folderRow('Worktree').click();
    // The click closes the card; it opens again to say so, for 1.5 s.
    await expect(checkoutCardHint()).toHaveText('Copied the folder path', { timeout: 1_000 });
    expect(await copiedPaths()).toEqual([docs]);
    await expect(checkoutCardHint()).toHaveText('Click to copy the folder path');

    // Copied again, but the clipboard answers only once A's card is up: B's
    // copy lands while A is on screen, and A's folder was not copied, so its
    // card does not say so. Held, the copy's 1.5 s cannot run out first.
    await page.evaluate(() => {
      const stand = window as unknown as { __copied: string[]; __answerCopy?: () => void };
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: (text: string) =>
          new Promise<void>((resolve) => {
            stand.__answerCopy = () => {
              stand.__copied.push(text);
              resolve();
            };
          }),
      });
    });
    await folderRow('Worktree').click();
    await expect
      .poll(() =>
        page.evaluate(
          () => typeof (window as unknown as { __answerCopy?: () => void }).__answerCopy,
        ),
      )
      .toBe('function');
    await openSession('Paginate the catalog search');
    await folderRow('Main checkout').hover();
    await expect(checkoutCardTitle()).toHaveText('Main checkout');
    await expect(checkoutCardHint()).toHaveText('Click to copy the folder path');
    await page.evaluate(async () => {
      (window as unknown as { __answerCopy: () => void }).__answerCopy();
      // The row's own `then` runs in the microtasks after the answer; React
      // draws what it set in a task after that.
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((drawn) => setTimeout(drawn, 100));
    });
    expect(await copiedPaths()).toEqual([docs, docs]);
    expect(await checkoutCardHint().textContent()).toBe('Click to copy the folder path');

    // A folder outside git has no card: its native title explains the copy.
    await openSession('Review notes');
    await expect(folderRow('Folder')).toBeVisible();
    await expect(folderRow('Folder')).toHaveAttribute('title', /Click to copy the folder path$/);
  });

  test('a folded section stays folded after a relaunch, as does a hidden panel', async () => {
    await openSession('Paginate the catalog search');
    const heading = () =>
      infoSection(page, 'Environment').getByRole('button', { name: 'Environment', exact: true });
    await expect(heading()).toHaveAttribute('aria-expanded', 'true');
    await expect(folderRow('Main checkout')).toBeVisible();
    // Open, the heading names the body it folds, which is there.
    const body = await heading().getAttribute('aria-controls');
    expect(body).toBeTruthy();
    await expect(page.locator(`[id="${body}"]`)).toHaveCount(1);

    await heading().click();
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    await expect(infoSection(page, 'Environment').locator('.info-row')).toHaveCount(0);
    // Folded, the body is not drawn, so the heading names nothing.
    await expect(heading()).not.toHaveAttribute('aria-controls');

    await page.getByRole('button', { name: 'Hide info panel', exact: true }).click();
    await expect(infoPanel(page)).toHaveCount(0);

    await app.close();
    ({ app, page } = await launchElectron({ userDataDir, env }));
    await openSession('Paginate the catalog search');
    const show = page.getByRole('button', { name: 'Show info panel', exact: true });
    await expect(show).toHaveAttribute('aria-pressed', 'false');
    await expect(infoPanel(page)).toHaveCount(0);

    await show.click();
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    await expect(infoSection(page, 'Environment').locator('.info-row')).toHaveCount(0);
  });

  test('Branch counts what waits to be pushed, what is uncommitted, and what differs from origin', async () => {
    await openSession('Paginate the catalog search');
    const branch = branchRow('feat/search-pagination');
    await expect(branch).toContainText('↑2');
    await expect(branch).toHaveAttribute(
      'title',
      '2 commits to push to origin/feat/search-pagination',
    );

    await expect(uncommitted()).toContainText('1 file');
    await expect(uncommitted()).toContainText('+1');
    await expect(uncommitted()).toContainText('−1');
    await expect(uncommitted()).toHaveAccessibleName('Uncommitted, 1 file +1 −1. Open Changes');

    // Against what the clone has of origin's default branch: the three files
    // the branch's commits added, nine lines in all.
    const base = baseRow('origin/main');
    await expect(base).toContainText('3 files');
    await expect(base).toContainText('+9');
    await expect(base).toContainText('−0');
    await expect(base).toHaveAttribute('title', /Consola never fetches\./);
    // A plain fact, which opens nothing.
    await expect(
      infoSection(page, 'Branch').getByRole('button', { name: /vs origin\/main/ }),
    ).toHaveCount(0);
  });

  test('a branch with no upstream is not pushed yet, and a folder outside git has no Branch section', async () => {
    await openSession('Update the readme');
    await expect(branchRow('docs/readme')).toContainText('Not pushed yet');
    await expect(baseRow('origin/main')).toContainText('No changes');

    await openSession('Review notes');
    // Git has answered for the folder: it is no checkout.
    await expect(folderRow('Folder')).toBeVisible();
    await expect(infoPanel(page).getByRole('button', { name: 'Branch', exact: true })).toHaveCount(
      0,
    );
  });

  test('Uncommitted opens the Changes tab', async () => {
    await openSession('Paginate the catalog search');
    const sidePanel = page.getByTestId('side-panel');
    await expect(sidePanel).toHaveCount(0);

    await uncommitted().click();
    await expect(sidePanel).toBeVisible();
    await expect(
      page.getByRole('tablist', { name: 'Side panel tabs' }).getByRole('tab', { name: 'Changes' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  test("the header's refresh reads the branch again", async () => {
    await openSession('Paginate the catalog search');
    await expect(branchRow('feat/search-pagination')).toContainText('↑2');
    await expect(uncommitted()).toContainText('1 file');

    // At the default window, with the sidebar shown, the session's name gives
    // way: the refresh sits clear of the side panel controls, and every
    // header control takes its own click.
    const refresh = page.getByRole('button', { name: 'Refresh git status', exact: true });
    const header = page.locator('.workspace-view-header');
    const refreshBox = await refresh.boundingBox();
    const controlsBox = await header.locator('.side-panel-controls').boundingBox();
    if (!refreshBox || !controlsBox) throw new Error('The header draws no refresh or no controls');
    expect(refreshBox.x + refreshBox.width).toBeLessThanOrEqual(controlsBox.x);
    expect(await coveredHeaderControls()).toEqual([]);

    // Committed behind Consola's back, so only a refresh can tell.
    git(repo, 'commit', '-q', '-am', 'Show fifty results a page');
    await refresh.click();
    await expect(branchRow('feat/search-pagination')).toContainText('↑3');
    await expect(uncommitted()).toContainText('None');
  });

  test('a folded Branch section, or a hidden panel, reads nothing of the branch', async () => {
    await openSession('Paginate the catalog search');
    const branch = branchRow('feat/search-pagination');
    const heading = () =>
      infoSection(page, 'Branch').getByRole('button', { name: 'Branch', exact: true });
    const refresh = page.getByRole('button', { name: 'Refresh git status', exact: true });
    await expect(branch).toContainText('↑2');
    // Read again against #51's base once its details land, found from the
    // branch: every read the open section asks for is in before folding.
    await expect(prSection().getByText('into main', { exact: true })).toBeVisible();
    await expect(baseRow('origin/main')).toContainText('3 files');
    await page.waitForTimeout(1000);
    const open = branchFactsReads();
    expect(open).toBeGreaterThan(0);

    // Folded: a commit made behind Consola's back, the header's refresh,
    // another session and back, none of which an open section lets pass.
    await heading().click();
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    git(repo, 'commit', '-q', '-am', 'Show fifty results a page');
    await refresh.click();
    await openSession('Update the readme');
    await openSession('Paginate the catalog search');
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(1000);
    expect(branchFactsReads()).toBe(open);

    // Open again, it reads, and counts the commit.
    await heading().click();
    await expect(branch).toContainText('↑3');
    const reopened = branchFactsReads();
    expect(reopened).toBeGreaterThan(open);

    // Hidden: the same.
    await page.getByRole('button', { name: 'Hide info panel', exact: true }).click();
    await expect(infoPanel(page)).toHaveCount(0);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Note the page size');
    await refresh.click();
    await openSession('Update the readme');
    await openSession('Paginate the catalog search');
    await expect(refresh).toBeVisible();
    await page.waitForTimeout(1000);
    expect(branchFactsReads()).toBe(reopened);
    await page.getByRole('button', { name: 'Show info panel', exact: true }).click();
    await expect(branch).toContainText('↑4');
  });

  test('a removed worktree’s Branch section names the branch it was on, and reads no checkout in its place', async () => {
    // `removedWorktree` is main's to write (`recordWorktreesRemoved`), so the
    // test seeds it through the profile, read at the next launch. Its main
    // checkout is the clone, the session's scope folder too, so a read that
    // fell back to either would be traced. A read of the removed folder
    // itself never reaches the trace (git stops at `-C` on a missing folder
    // before it traces anything), so that is not what this pins.
    await app.close();
    const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      workspaces: Array<{ name: string; sessions: Array<Record<string, unknown>> }>;
    };
    const workspace = saved.workspaces.find((candidate) => candidate.name === 'Sprocket')!;
    const sibling = workspace.sessions.find((session) => session.name === 'Review notes')!;
    const worktree = path.join(root, 'old-experiment');
    workspace.sessions.push({
      ...sibling,
      id: 'info-g',
      name: 'Old experiment',
      instanceId: 'info-g',
      claudeSessionId: randomUUID(),
      cwd: worktree,
      removedWorktree: {
        path: worktree,
        mainRepo: repo,
        commit: 'a'.repeat(40),
        branch: 'consola/old-experiment',
        keepRef: 'refs/consola/worktrees/old-experiment',
        trigger: 'settled',
        removedAt: Date.now(),
      },
    });
    fs.writeFileSync(stateFile, JSON.stringify(saved));
    ({ app, page } = await launchElectron({ userDataDir, env }));

    // From a session with a live checkout, whose reads this launch's trace
    // counts, once every read it asks for is in (the one against #51's base
    // included).
    const atLaunch = branchFactsReads();
    await openSession('Paginate the catalog search');
    await expect(branchRow('feat/search-pagination')).toContainText('↑2');
    await expect(prSection().getByText('into main', { exact: true })).toBeVisible();
    await expect(baseRow('origin/main')).toContainText('3 files');
    await page.waitForTimeout(1000);
    const before = branchFactsReads();
    expect(before).toBeGreaterThan(atLaunch);

    await openSession('Old experiment');
    const section = infoSection(page, 'Branch');
    await expect(section.locator('.info-row').first()).toHaveText('consola/old-experiment');
    await expect(
      section.getByText('No checkout until the session next starts.', { exact: true }),
    ).toBeVisible();
    // Nothing else: no folder to count changes in, or to compare.
    await expect(section.locator('.info-row')).toHaveCount(2);
    await page.waitForTimeout(1000);
    expect(branchFactsReads()).toBe(before);
  });

  test("a snoozed session's header keeps every control in reach at the default window", async () => {
    await openSession('Paginate the catalog search');
    await expect(uncommitted()).toContainText('1 file');
    await page
      .locator('.session-nav-item')
      .filter({ hasText: 'Paginate the catalog search' })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Snooze', exact: true }).hover();
    await page.getByRole('menuitem', { name: /^In 3 hours/ }).click();

    // The fullest header: name, snooze chip and Wake, counts, refresh, three
    // shortcuts and both toggles. The name and then the snooze chip's words
    // give way; no control is drawn over another.
    const header = page.locator('.workspace-view-header');
    await expect(header.getByRole('button', { name: 'Wake', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: /^(Show|Hide) side panel/ })).toBeVisible();
    expect(await coveredHeaderControls()).toEqual([]);
  });

  test('down to an 800px window, every header control is in reach, and a folder outside git cuts its path', async () => {
    // A folder outside git whose path is longer than a narrow header holds.
    const minutes = path.join(
      root,
      'notes',
      'meeting-minutes-for-the-catalog-portal-search-pagination-review-with-ellen-and-mateo',
    );
    fs.mkdirSync(minutes, { recursive: true });
    await addSession('Read the pagination review minutes', 'info-e', minutes);
    await windowWidth(800);
    const header = page.locator('.workspace-view-header');
    const controls = header.locator('.side-panel-controls');

    // A checkout: its counts and refresh, then the controls, all in reach.
    await openSession('Paginate the catalog search');
    await expect(uncommitted()).toContainText('1 file');
    await expect(header.locator('.git-stats-count')).toHaveText('1 file');
    await expect(header.getByRole('button', { name: 'Refresh git status' })).toBeVisible();
    expect(await coveredHeaderControls()).toEqual([]);

    // A folder outside git prints its path, cut with an ellipsis before the
    // controls, which stay in reach.
    await openSession('Read the pagination review minutes');
    await expect(folderRow('Folder')).toBeVisible();
    const folder = header.locator('.workspace-view-path');
    await expect(folder).toContainText('meeting-minutes');
    expect(await folder.evaluate((text) => text.scrollWidth > text.clientWidth)).toBe(true);
    const folderBox = await folder.boundingBox();
    const controlsBox = await controls.boundingBox();
    if (!folderBox || !controlsBox) throw new Error('The header draws no folder or no controls');
    expect(folderBox.x + folderBox.width).toBeLessThanOrEqual(controlsBox.x);
    expect(await coveredHeaderControls()).toEqual([]);
  });

  test('a session in a folder below its checkout’s top: the card names that folder, and Uncommitted waits for git', async () => {
    // Git status is read only at a repository's top, so nobody has counted
    // this folder's changes.
    const src = path.join(repo, 'src');
    await addSession('Tidy the search module', 'info-f', src);
    await openSession('Paginate the catalog search');
    await expect(uncommitted()).toContainText('1 file');

    await openSession('Tidy the search module');
    await expect(branchRow('feat/search-pagination')).toBeVisible();
    // This folder's own read has landed: it says no repository, so the
    // header has no refresh, and Uncommitted is not drawn, never `None`.
    await expect(page.getByRole('button', { name: 'Refresh git status' })).toHaveCount(0);
    await expect(
      infoSection(page, 'Branch').getByRole('button', { name: /^Uncommitted/ }),
    ).toHaveCount(0);

    // The card's Folder is the session's own, the path the row copies, not
    // the checkout's top.
    await standInClipboard();
    await folderRow('Main checkout').hover();
    await expect(checkoutCardTitle()).toHaveText('Main checkout');
    const cardFolder = page.locator(
      '.checkout-tooltip > .checkout-tooltip-facts > dd:nth-of-type(2) > .checkout-tooltip-value',
    );
    await expect(cardFolder).toHaveText(src);
    await folderRow('Main checkout').click();
    await expect(checkoutCardHint()).toHaveText('Copied the folder path', { timeout: 1_000 });
    expect(await copiedPaths()).toEqual([src]);
  });

  test("a linked session's pull request, at a glance", async () => {
    await openSession(FIX_CI);
    const section = prSection();
    await expect(prTitle()).toBeVisible();
    // The info panel holds what the strip above the terminal once did.
    await expect(page.locator('.work-item-strip')).toHaveCount(0);
    // The state in the pane's own words, the base, and the action as a fact.
    await expect(section.getByText('Open', { exact: true })).toBeVisible();
    await expect(section.getByText('into main', { exact: true })).toBeVisible();
    await expect(section.getByText('Fix CI', { exact: true })).toBeVisible();
    await expect(section.getByText('Fix CI', { exact: true })).toHaveAttribute(
      'title',
      'Started with the Fix CI action',
    );
    await expect(section.getByRole('button', { name: 'Fix CI', exact: true })).toHaveCount(0);

    const checks = section.locator('.info-row').filter({ hasText: '1 check failing' });
    await expect(checks).toContainText('1 ✓');
    await expect(checks).toHaveAttribute('data-tone', 'error');
    const review = section.locator('.info-row').filter({ hasText: 'Changes requested' });
    await expect(review.locator('.inbox-detail-avatar')).toHaveCount(3);
    await expect(section.getByText('2 unresolved threads', { exact: true })).toBeVisible();
    await expect(
      section.getByText('Blocked until requirements pass', { exact: true }),
    ).toBeVisible();

    await expect(
      prActions().getByRole('link', { name: 'Open on GitHub', exact: true }),
    ).toHaveAttribute('href', 'https://github.com/sprocket/catalog-portal/pull/51');
    await expect(
      prActions().getByRole('button', { name: 'Refresh pull request', exact: true }),
    ).toBeVisible();
    await expect(
      prActions().getByRole('button', { name: 'Run an action in Fix CI for billing', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(test.info().outputDir, 'info-panel-pull-request.png'),
    });

    // The same pull request found from another session's branch: the action
    // belongs to D's link, so A shows none.
    await openSession('Paginate the catalog search');
    await expect(prSection().getByText(FOUND, { exact: true })).toBeVisible();
    await expect(prTitle()).toBeVisible();
    await expect(prSection().getByText('Fix CI', { exact: true })).toHaveCount(0);
  });

  test('a pull request found from the branch shows, and opens its tab', async () => {
    await openSession('Paginate the catalog search');
    const section = prSection();
    await expect(prTitle()).toBeVisible();
    await expect(section.getByText(FOUND, { exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Link', exact: true })).toBeVisible();
    // Run sends an action into a linked session only.
    await expect(
      prActions().getByRole('button', { name: 'Refresh pull request', exact: true }),
    ).toBeVisible();
    await expect(prActions().getByRole('button', { name: /^Run an action in/ })).toHaveCount(0);

    // "+" then P: the kind applies, named by the found pull request.
    await sidePanelToggle().click();
    await expect(newTabOption('Pull request #51')).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('p');
    await expect(sidePanelTab('Pull request #51')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('work-item-panel')).toContainText('Extract billing client');
  });

  test('a branch with no pull request says so, and the kind stays unavailable', async () => {
    await openSession('Update the readme');
    await expect(
      prSection().getByText('No pull request for this branch.', { exact: true }),
    ).toBeVisible();

    await sidePanelToggle().click();
    await expect(newTabOption('Pull request')).toHaveAttribute('aria-disabled', 'true');
  });

  test('the lookup is asked once per branch, and not while folded or hidden', async () => {
    const noPullRequest = () =>
      prSection().getByText('No pull request for this branch.', { exact: true });
    const heading = () => prSection().getByRole('button', { name: 'Pull request', exact: true });

    // Folded on D, which is linked and looks nothing up: B is not looked up.
    await openSession(FIX_CI);
    await heading().click();
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    await openSession('Update the readme');
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(1000);
    expect(lookupsOf('docs/readme')).toBe(0);
    await heading().click();
    await expect(noPullRequest()).toBeVisible();
    expect(lookupsOf('docs/readme')).toBe(1);

    // Hidden: A is not looked up either.
    await page.getByRole('button', { name: 'Hide info panel', exact: true }).click();
    await expect(infoPanel(page)).toHaveCount(0);
    await openSession('Paginate the catalog search');
    await expect(page.locator('.workspace-view-header')).toContainText(
      'Paginate the catalog search',
    );
    await page.waitForTimeout(1000);
    expect(lookupsOf('feat/search-pagination')).toBe(0);
    await page.getByRole('button', { name: 'Show info panel', exact: true }).click();
    await expect(prSection().getByText(FOUND, { exact: true })).toBeVisible();

    // A, B, then A again: each branch asked about once.
    await openSession('Update the readme');
    await expect(noPullRequest()).toBeVisible();
    await openSession('Paginate the catalog search');
    await expect(prSection().getByText(FOUND, { exact: true })).toBeVisible();
    expect(lookupsOf('feat/search-pagination')).toBe(1);
    expect(lookupsOf('docs/readme')).toBe(1);

    // Folded, then B and A: nothing more.
    await heading().click();
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    await openSession('Update the readme');
    await openSession('Paginate the catalog search');
    await page.waitForTimeout(1000);
    expect(lookupsOf('feat/search-pagination')).toBe(1);
    expect(lookupsOf('docs/readme')).toBe(1);
  });

  test('a found pull request stops counting when the branch changes', async () => {
    // Both panels at once, which needs a wide window.
    await roomForBothPanels(app, page);
    await openSession('Paginate the catalog search');
    await expect(prTitle()).toBeVisible();

    // The agent moves to a branch of its own. Main's lookup for it is held,
    // so what the section says meanwhile can be seen.
    const hold = env.STUB_GH_PULLS_HOLD;
    fs.writeFileSync(hold, '');
    git(repo, 'switch', '-q', '-c', 'spike/other');
    await page.getByRole('button', { name: 'Refresh git status', exact: true }).click();
    await expect(
      prSection().getByText('Looking for this branch’s pull request…', { exact: true }),
    ).toBeVisible();
    await expect(prSection()).not.toContainText('#51');
    await sidePanelToggle().click();
    await expect(newTabOption('Pull request')).toHaveAttribute('aria-disabled', 'true');

    // GitHub has no answer for the new branch: a 404.
    fs.rmSync(hold);
    await expect(
      prSection().getByText(/^Couldn’t look for this branch’s pull request: /),
    ).toBeVisible();
    await expect(prSection().getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(prSection()).not.toContainText('#51');
    await expect(newTabOption('Pull request')).toHaveAttribute('aria-disabled', 'true');
  });

  test("Link makes the found pull request the session's own", async () => {
    await openSession('Paginate the catalog search');
    await expect(prSection().getByText(FOUND, { exact: true })).toBeVisible();
    await prSection().getByRole('button', { name: 'Link', exact: true }).click();

    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    const linkedNumber = () => {
      const state = JSON.parse(fs.readFileSync(path.join(userData, 'workspaces.json'), 'utf8')) as {
        workspaces: Array<{ sessions: Array<{ name: string; workItem?: { number: number } }> }>;
      };
      return state.workspaces[0].sessions.find(
        (session) => session.name === 'Paginate the catalog search',
      )?.workItem?.number;
    };
    await expect.poll(linkedNumber).toBe(51);
    await expect(prSection().getByText(FOUND, { exact: true })).toHaveCount(0);
    await expect(
      prActions().getByRole('button', {
        name: 'Run an action in Paginate the catalog search',
        exact: true,
      }),
    ).toBeVisible();
    await expect(prTitle()).toBeVisible();
  });

  test('a pull request line opens the tab where the pane has it', async () => {
    // Both panels at once, which needs a wide window.
    await roomForBothPanels(app, page);
    await openSession(FIX_CI);
    const section = prSection();
    await expect(page.getByTestId('side-panel')).toHaveCount(0);

    // Checks: the merge card, in the Conversation tab, scrolled to.
    await section.getByRole('button', { name: /^1 check failing/ }).click();
    await expect(sidePanelTab('Pull request #51')).toHaveAttribute('aria-selected', 'true');
    const merge = remote().getByRole('region', { name: 'Merge' });
    await expect(merge).toBeInViewport();
    await expect
      .poll(() => page.getByTestId('work-item-panel').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    // Threads: Files changed.
    const files = remote().getByRole('tab', { name: /^Files changed/ });
    await section.getByRole('button', { name: /^2 unresolved threads/ }).click();
    await expect(files).toHaveAttribute('aria-selected', 'true');

    // The title only opens the tab, which is already open: nothing moves.
    await prTitle().click();
    await expect(sidePanelTab('Pull request #51')).toHaveAttribute('aria-selected', 'true');
    await expect(files).toHaveAttribute('aria-selected', 'true');

    // The same place asked for again is a new ask, acted on again.
    await section.getByRole('button', { name: /^1 check failing/ }).click();
    await expect(remote().getByRole('tab', { name: /^Conversation/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(merge).toBeInViewport();

    // An ask is acted on once, across a remount too. Files changed asked
    // for, then A and back: the tab is keyed by session, so D's pane mounts
    // afresh, on its Conversation tab, and does not go to Files changed again.
    await section.getByRole('button', { name: /^2 unresolved threads/ }).click();
    await expect(files).toHaveAttribute('aria-selected', 'true');
    await openSession('Paginate the catalog search');
    await expect(prSection().getByText(FOUND, { exact: true })).toBeVisible();
    await openSession(FIX_CI);
    await expect(prSection().getByText(FOUND, { exact: true })).toHaveCount(0);
    await expect(remote().getByRole('tab', { name: /^Conversation/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(files).toHaveAttribute('aria-selected', 'false');
  });

  test('one read for the section and the tab together, and none while folded or hidden', async () => {
    // Both panels at once, which needs a wide window.
    await roomForBothPanels(app, page);
    const section = prSection();
    const heading = section.getByRole('button', { name: 'Pull request', exact: true });
    const header = page.locator('.workspace-view-header');

    // Hidden before #51 is first read: D reads nothing, as a read while
    // hidden would be the first in the log.
    await openSession('Update the readme');
    await page.getByRole('button', { name: 'Hide info panel', exact: true }).click();
    await expect(infoPanel(page)).toHaveCount(0);
    await openSession(FIX_CI);
    await expect(header).toContainText('Fix CI for billing');
    await page.waitForTimeout(1000);
    expect(detailReadsOf51()).toBe(0);

    // Folded before it is first read: the same. Folded on B, so D is never
    // on screen with the section open.
    await openSession('Update the readme');
    await page.getByRole('button', { name: 'Show info panel', exact: true }).click();
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await openSession(FIX_CI);
    await expect(header).toContainText('Fix CI for billing');
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(1000);
    expect(detailReadsOf51()).toBe(0);

    // Opened, the section reads it, once.
    await heading.click();
    await expect(section.getByText('2 unresolved threads', { exact: true })).toBeVisible();
    expect(detailReadsOf51()).toBe(1);

    // The tab shows the section's read.
    await prTitle().click();
    await expect(remote().getByRole('region', { name: 'Merge' })).toBeAttached();
    expect(detailReadsOf51()).toBe(1);

    // Folded, with the tab behind Changes: neither reads, on the way back either.
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
    await openSession('Paginate the catalog search');
    await openSession(FIX_CI);
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(1000);
    expect(detailReadsOf51()).toBe(1);

    // Hidden: the same.
    await page.getByRole('button', { name: 'Hide info panel', exact: true }).click();
    await expect(infoPanel(page)).toHaveCount(0);
    await openSession('Paginate the catalog search');
    await openSession(FIX_CI);
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(1000);
    expect(detailReadsOf51()).toBe(1);

    // Shown and unfolded, the read is still fresh: nothing is asked.
    await page.getByRole('button', { name: 'Show info panel', exact: true }).click();
    await heading.click();
    await expect(section.getByText('2 unresolved threads', { exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(detailReadsOf51()).toBe(1);

    // The person's Refresh always reads.
    await prActions().getByRole('button', { name: 'Refresh pull request', exact: true }).click();
    await expect.poll(detailReadsOf51).toBe(2);
  });

  test('with no account, the Pull request section says so, and reads nothing', async () => {
    await page.evaluate(async () => {
      const [workspace] = (await window.workspaceAPI.getSnapshot()).workspaces;
      await window.workspaceAPI.setProviderBinding(workspace.id, null);
    });
    const noAccount = () =>
      prSection().getByText('This workspace has no account to read pull requests with.', {
        exact: true,
      });
    const onGitHub = () => prSection().getByRole('link', { name: 'Open on GitHub', exact: true });

    // D, linked to #51: the sentence, and the item on GitHub, with nothing to refresh.
    await openSession(FIX_CI);
    await expect(noAccount()).toBeVisible();
    await expect(onGitHub()).toHaveAttribute(
      'href',
      'https://github.com/sprocket/catalog-portal/pull/51',
    );
    await expect(prSection().getByRole('button', { name: 'Refresh pull request' })).toHaveCount(0);

    // A, on a branch: the same sentence, and no item to open.
    await openSession('Paginate the catalog search');
    await expect(noAccount()).toBeVisible();
    await expect(onGitHub()).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(detailReadsOf51()).toBe(0);
    expect(lookupsOf('feat/search-pagination')).toBe(0);

    // Its action opens Settings where the workspace gets one.
    await prSection().getByRole('button', { name: 'Workspace settings', exact: true }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Settings', exact: true })
        .getByRole('button', { name: 'Provider', exact: true }),
    ).toHaveAttribute('aria-current', 'true');
  });

  test('a pull request that could not be read says why, and Retry reads it again', async () => {
    failReads();
    await openSession(FIX_CI);
    const failed = () => prSection().getByText(/^Couldn’t read the pull request: /);
    await expect(failed()).toBeVisible();
    await expect.poll(detailReadsOf51).toBe(1);

    answerReads();
    await prSection().getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(prSection().getByText('2 unresolved threads', { exact: true })).toBeVisible();
    await expect(failed()).toHaveCount(0);
    expect(detailReadsOf51()).toBe(2);
  });

  test('a Pull request tab behind another tab reads nothing, its mergeability polls included', async () => {
    // GitHub still working out whether #51 can merge: while the item is on
    // screen, a quiet read follows every few seconds.
    const fixture = pullRequestFixture();
    fs.writeFileSync(
      fixture,
      fs
        .readFileSync(fixture, 'utf8')
        .replace('"mergeStateStatus": "BLOCKED"', '"mergeStateStatus": "UNKNOWN"'),
    );
    test.setTimeout(60_000);
    // Only the tab looks at #51: the info panel's section would too.
    await openSession(FIX_CI);
    await page.getByRole('button', { name: 'Hide info panel', exact: true }).click();
    await expect(infoPanel(page)).toHaveCount(0);
    await openTabFromList('p');
    // Named for its mark too while it is behind.
    const tabOf51 = page
      .getByRole('tablist', { name: 'Side panel tabs' })
      .getByRole('tab', { name: /^Pull request #51/ });
    await expect(tabOf51).toHaveAttribute('aria-selected', 'true');
    await expect(remote().getByRole('region', { name: 'Merge' })).toBeAttached();
    await expect.poll(detailReadsOf51, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // Behind Changes, the polls stop: a read already under way when the tab
    // went behind is given a moment to be counted, then two polls' time.
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(1000);
    const behind = detailReadsOf51();
    await page.waitForTimeout(7000);
    expect(detailReadsOf51()).toBe(behind);

    // In front again, they go on.
    await tabOf51.click();
    await expect.poll(detailReadsOf51, { timeout: 10_000 }).toBeGreaterThan(behind);
  });

  test("the pane's head says a read it did not start failed, and takes that back once a read succeeds", async () => {
    // The info panel's Refresh beside the tab's pane: a wide window.
    await roomForBothPanels(app, page);
    await openSession(FIX_CI);
    await prTitle().click();
    await expect(remote().getByRole('region', { name: 'Merge' })).toBeAttached();
    const head = page.getByTestId('work-item-panel').locator('.inbox-detail-head');
    const said = head.getByRole('alert');
    const refresh = prActions().getByRole('button', { name: 'Refresh pull request', exact: true });
    const refreshed = async (reads: number) => {
      await expect.poll(detailReadsOf51).toBe(reads);
      await expect(refresh).toHaveAttribute('aria-busy', 'false');
    };

    // The info panel's Refresh fails: a read the pane did not start, which
    // its head says all the same.
    failReads();
    await refresh.click();
    await expect(said).toHaveText(/^Could not refresh details: /);

    // The next one succeeds: the head takes it back, with no Dismiss.
    answerReads();
    await refresh.click();
    await expect(said).toHaveCount(0);

    // A write's own error is not a read's to take back.
    fs.writeFileSync(env.STUB_GH_MUTATION_FAILURE_FILE, '');
    await head.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Convert to draft' }).click();
    await expect(said).toHaveText(/repository rules are not satisfied/);
    fs.rmSync(env.STUB_GH_MUTATION_FAILURE_FILE);
    const reads = detailReadsOf51();
    await refresh.click();
    await refreshed(reads + 1);
    await expect(said).toHaveText(/repository rules are not satisfied/);
  });

  test('a pane opened again on a pull request whose first read failed says so, and reads nothing more until asked', async () => {
    // The info panel beside the tab's pane: a wide window.
    await roomForBothPanels(app, page);
    failReads();
    await openSession(FIX_CI);
    await openTabFromList('p');
    await expect(sidePanelTab('Pull request #51')).toHaveAttribute('aria-selected', 'true');
    const head = page.getByTestId('work-item-panel').locator('.inbox-detail-head');
    const said = head.getByRole('alert');
    await expect(said).toHaveText(/^Could not refresh details: /);
    await expect(prSection().getByText(/^Couldn’t read the pull request: /)).toBeVisible();
    // One read, for the section and the tab together.
    await expect.poll(detailReadsOf51).toBe(1);

    // Away to a session whose tab has no item, so the pane goes, and back
    // within the interval: the pane, mounted afresh with no details to
    // show, says the failure again rather than drawing blank, and nothing
    // reads #51 again, a failed read being as fresh as an answer.
    await openSession('Review notes');
    await expect(page.getByTestId('side-panel')).toContainText(
      'This session is not linked to a pull request or issue.',
    );
    await expect(page.getByTestId('work-item-panel')).toHaveCount(0);
    await openSession(FIX_CI);
    await expect(said).toHaveText(/^Could not refresh details: /);
    await page.waitForTimeout(1000);
    expect(detailReadsOf51()).toBe(1);

    // Asked by the pane's own Refresh, with the read answering again: the
    // details draw, and the head takes the failure back.
    answerReads();
    await head.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await expect(remote().getByRole('region', { name: 'Merge' })).toBeAttached();
    await expect(said).toHaveCount(0);
    expect(detailReadsOf51()).toBe(2);
  });

  test("the Branch section compares with the pull request's base", async () => {
    // origin's default branch is A's own upstream, which no session compares
    // with. #51's base is main, so a line against origin/main can only come
    // from the pull request.
    git(
      repo,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/feat/search-pagination',
    );

    // A, whose branch #51 was found from, once #51's details are read.
    await openSession('Paginate the catalog search');
    await expect(prSection().getByText(FOUND, { exact: true })).toBeVisible();
    await expect(prSection().getByText('into main', { exact: true })).toBeVisible();
    await expect(baseRow('origin/main')).toContainText('3 files');
    const againstMain = await baseRow('origin/main').textContent();

    // D, linked to #51, in the same checkout: the same line.
    await openSession(FIX_CI);
    await expect(prSection().getByText('into main', { exact: true })).toBeVisible();
    await expect(baseRow('origin/main')).toContainText('3 files');
    expect(await baseRow('origin/main').textContent()).toBe(againstMain);

    // B's branch has no pull request: it compares with origin's default branch.
    await openSession('Update the readme');
    await expect(
      prSection().getByText('No pull request for this branch.', { exact: true }),
    ).toBeVisible();
    await expect(baseRow('origin/feat/search-pagination')).toContainText('No changes');
  });

  /**
   * When main last read the Inbox, 0 before it has. The Inbox's #51 has a
   * failing check and no review yet, so a read of it landing after #51's
   * details would speak over them: the newer source decides.
   */
  const inboxReadAt = () =>
    page.evaluate(async () => {
      const workspace = (await window.workspaceAPI.getSnapshot()).workspaces[0];
      return (await window.inboxAPI.getInbox(workspace.id))?.fetchedAt ?? 0;
    });

  test("the pull request's red mark goes on its shortcut, else its tab, else the side panel toggle", async () => {
    // Three launches.
    test.setTimeout(60_000);
    // Both panels at once, which needs a wide window.
    await roomForBothPanels(app, page);
    const checksFailing = () => prSection().getByRole('button', { name: /^1 check failing/ });
    const onKind = 'Pull request #51, a check is failing and changes are requested';

    // The toggle: Pull request is none of the header's three, and the side
    // panel is hidden.
    await expect.poll(inboxReadAt).toBeGreaterThan(0);
    await openSession(FIX_CI);
    await expect(checksFailing()).toBeVisible();
    await expect(
      page.locator('.side-panel-controls').getByRole('button', { name: /^Pull request/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await expect(sidePanelToggle()).toHaveAttribute('data-alert-dot', 'true');
    await expect(sidePanelToggle()).not.toHaveAttribute('data-agent-dot');
    await expect(sidePanelToggle()).toHaveAccessibleName(
      'Show side panel, where the pull request has a failing check and changes requested',
    );

    // The tab, once it sits behind Changes on screen. In front, it shows
    // what its mark is about.
    await prTitle().click();
    await expect(sidePanelTab('Pull request #51')).toHaveAttribute('aria-selected', 'true');
    await expect(sidePanelTab('Pull request #51')).not.toHaveAttribute('data-alert-dot');
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(sidePanelTab('Changes')).toHaveAttribute('aria-selected', 'true');
    const tabOf51 = page
      .getByRole('tablist', { name: 'Side panel tabs' })
      .getByRole('tab', { name: /^Pull request #51/ });
    await expect(tabOf51).toHaveAttribute('data-alert-dot', 'true');
    await expect(tabOf51).toHaveAccessibleName(onKind);
    await expect(sidePanelToggle()).not.toHaveAttribute('data-alert-dot');
    await expect(sidePanelToggle()).toHaveAccessibleName('Hide side panel');

    // The shortcut: Pull request opened five times today is one of the
    // header's three at the next launch, which keeps the layout. Left on a
    // session with no pull request, which the next launch returns to, so
    // nothing reads #51 there before the Inbox has been read.
    await openSession('Review notes');
    await expect(prSection()).toHaveCount(0);
    await page.evaluate((key) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
      const now = Date.now();
      stored.state = { ...stored.state, uses: { 'pull-request': [now, now, now, now, now] } };
      localStorage.setItem(key, JSON.stringify(stored));
    }, 'consola-side-panel');
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir, env }));
    await roomForBothPanels(app, page);
    await expect.poll(inboxReadAt).toBeGreaterThan(0);
    await openSession(FIX_CI);
    await expect(checksFailing()).toBeVisible();
    const shortcut = page
      .locator('.side-panel-controls')
      .getByRole('button', { name: onKind, exact: true });
    await expect(shortcut).toHaveAttribute('data-alert-dot', 'true');
    await expect(page.getByTestId('side-panel')).toBeVisible();
    await sidePanelToggle().click();
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    // The shortcut already carries the mark.
    await expect(sidePanelToggle()).toHaveAccessibleName('Show side panel');
    await expect(sidePanelToggle()).not.toHaveAttribute('data-alert-dot');

    // With nothing on screen to show #51, the mark stays on what was read.
    await page.getByRole('button', { name: 'Hide info panel', exact: true }).click();
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(shortcut).toHaveAttribute('data-alert-dot', 'true');

    // No reads. At the next launch both panels are still hidden and nothing
    // is cached, so nothing on screen shows #51: the mark says only what the
    // Inbox says, a failing check with no review yet, and #51's details are
    // never read. A mark that watched or loaded would read them at once.
    const reads = detailReadsOf51();
    await app.close();
    ({ app, page } = await launchElectron({ userDataDir, env }));
    await expect.poll(inboxReadAt).toBeGreaterThan(0);
    await openSession(FIX_CI);
    await expect(infoPanel(page)).toHaveCount(0);
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    const inboxOnly = 'Pull request #51, a check is failing';
    const prShortcut = page
      .locator('.side-panel-controls')
      .getByRole('button', { name: /^Pull request #51/ });
    await expect(prShortcut).toHaveAccessibleName(inboxOnly);
    await expect(prShortcut).toHaveAttribute('data-alert-dot', 'true');
    await page.waitForTimeout(2000);
    await expect(prShortcut).toHaveAccessibleName(inboxOnly);
    expect(detailReadsOf51()).toBe(reads);
  });
});
