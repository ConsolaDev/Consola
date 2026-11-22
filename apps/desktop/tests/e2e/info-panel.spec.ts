import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NewSessionFields } from '../../src/shared/workspace';
import { commandPaletteChord, launchElectron } from './helpers/electron';
import { infoPanel, infoPanelChord, infoSection } from './helpers/infoPanel';

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

    const stub = path.join(root, 'agent.sh');
    fs.writeFileSync(stub, '#!/bin/sh\nprintf "Agent ready\\n"\nexec sleep 300\n', {
      mode: 0o755,
    });

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
    env = {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      STUB_GH_LOG: path.join(root, 'gh.log'),
      STUB_GH_PULLS: pulls,
      STUB_GH_PULLS_HOLD: path.join(root, 'pulls.hold'),
    };

    ({ app, page, userDataDir } = await launchElectron({ env }));
    await page.evaluate(
      async ({ repo, docs, notes, stub }) => {
        await window.harnessStateAPI.addHarness({
          id: 'info-panel-stub',
          driverId: 'claude',
          name: 'Stub',
          binaryPath: stub,
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
      { repo, docs, notes, stub },
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
  /** The Branch section's first row: the checkout's branch, and what waits to be pushed. */
  const branchRow = (branch: string) =>
    infoSection(page, 'Branch').locator('.info-row').filter({ hasText: branch });
  /** Uncommitted, a button that opens Changes: named `Uncommitted, <value>. Open Changes`. */
  const uncommitted = () =>
    infoSection(page, 'Branch').getByRole('button', { name: /^Uncommitted, .+\. Open Changes$/ });
  /**
   * The session header's buttons that something else is drawn over at their
   * centre, by name: none, when each takes its own click.
   */
  const coveredHeaderControls = () =>
    page.locator('.workspace-view-header').evaluate((row) =>
      [...row.querySelectorAll('button')]
        .filter((button) => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return !hit || !button.contains(hit);
        })
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    );
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
  const sidePanelToggle = () => page.getByRole('button', { name: /^(Show|Hide) side panel/ });
  /** The side panel's list of kinds, which an empty side panel shows when it is shown. */
  const newTabOption = (name: string) =>
    page
      .getByRole('listbox', { name: 'Open in this tab' })
      .getByRole('option', { name, exact: true });
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
        const sidePanel = controls?.querySelector('[aria-label="Show side panel"]');
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

  test('Environment says where each session runs', async () => {
    await openSession('Paginate the catalog search');
    const environment = infoSection(page, 'Environment');
    // The driver's label, as the sidebar's harness mark words it.
    await expect(environment).toContainText('Claude Code · Stub');
    await expect(folderRow('Main checkout')).toBeVisible();
    // The computer's name, or "This Mac": never an empty row.
    await expect(environment.locator('.info-row').first()).toHaveText(/\S/);

    await openSession('Update the readme');
    await expect(folderRow('Worktree')).toBeVisible();
    await folderRow('Worktree').click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(docs);
    await expect(folderRow('Worktree')).toHaveAttribute('title', /Copied the folder path/);

    await openSession('Review notes');
    await expect(folderRow('Folder')).toBeVisible();
  });

  test('a folded section stays folded after a relaunch, as does a hidden panel', async () => {
    await openSession('Paginate the catalog search');
    const heading = () =>
      infoSection(page, 'Environment').getByRole('button', { name: 'Environment', exact: true });
    await expect(heading()).toHaveAttribute('aria-expanded', 'true');
    await expect(folderRow('Main checkout')).toBeVisible();

    await heading().click();
    await expect(heading()).toHaveAttribute('aria-expanded', 'false');
    await expect(infoSection(page, 'Environment').locator('.info-row')).toHaveCount(0);

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

  test("a snoozed session's header keeps every control in reach at the default window", async () => {
    await openSession('Paginate the catalog search');
    await expect(uncommitted()).toContainText('1 file');
    await page
      .locator('.session-nav-item')
      .filter({ hasText: 'Paginate the catalog search' })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Snooze', exact: true }).hover();
    await page.getByRole('menuitem', { name: /^In 3 hours/ }).click();

    // The fullest header: name, checkout chip, snooze chip and Wake, counts,
    // refresh, three shortcuts and both toggles. The name and then the chips'
    // words give way; no control is drawn over another.
    const header = page.locator('.workspace-view-header');
    await expect(header.getByRole('button', { name: 'Wake', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: /^(Show|Hide) side panel/ })).toBeVisible();
    expect(await coveredHeaderControls()).toEqual([]);
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
  });

  test('one read for the section and the tab together, and none while folded or hidden', async () => {
    await openSession(FIX_CI);
    const section = prSection();
    await expect(section.getByText('2 unresolved threads', { exact: true })).toBeVisible();
    expect(detailReadsOf51()).toBe(1);

    // The tab shows the section's read.
    await prTitle().click();
    await expect(remote().getByRole('region', { name: 'Merge' })).toBeAttached();
    expect(detailReadsOf51()).toBe(1);

    // Folded, with the tab behind Changes: neither reads, on the way back either.
    const heading = section.getByRole('button', { name: 'Pull request', exact: true });
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

  test("the Branch section compares with the pull request's base", async () => {
    // Against origin's default branch, as for any session.
    await openSession('Paginate the catalog search');
    await expect(baseRow('origin/main')).toContainText('3 files');
    const againstMain = await baseRow('origin/main').textContent();

    // origin's default branch is now the branch's own upstream, which an
    // unlinked session does not compare with. The pull request's base is
    // still main, which D compares with.
    git(
      repo,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/feat/search-pagination',
    );
    await openSession(FIX_CI);
    await expect(prSection().getByText('into main', { exact: true })).toBeVisible();
    await expect(baseRow('origin/main')).toContainText('3 files');
    expect(await baseRow('origin/main').textContent()).toBe(againstMain);

    await openSession('Paginate the catalog search');
    await expect(branchRow('feat/search-pagination')).toContainText('↑2');
    await expect(baseRow('origin/')).toHaveCount(0);
  });
});
