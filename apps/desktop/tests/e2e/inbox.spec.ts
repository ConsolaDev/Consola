import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');
const PR51_KEY = 'github:sprocket/catalog-portal:pr:51';
const SECTIONS = [
  'needs-your-review',
  'needs-team-review',
  'your-drafts',
  'waiting',
  'needs-action',
  'ready-to-merge',
  'issues',
];

/** A local clone whose origin matches the fixture's sprocket/catalog-portal. */
function initClone(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'e2e@consola.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Consola E2E']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  execFileSync('git', [
    '-C', dir, 'remote', 'add', 'origin',
    'https://github.com/sprocket/catalog-portal.git',
  ]);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const checkRun = (conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  status,
  conclusion,
});
const statusContext = (state: string) => ({ __typename: 'StatusContext', state });

/** A `commits` field whose rollup carries `state` and the given contexts; null means no rollup. */
function rollup(state: string | null, contexts: unknown[]) {
  if (state === null) return { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } };
  return {
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state,
              contexts: { totalCount: contexts.length, nodes: contexts },
            },
          },
        },
      ],
    },
  };
}

function pr(
  repo: string,
  number: number,
  title: string,
  author: string,
  ageDays: number,
  extra: Record<string, unknown> = {}
) {
  return {
    __typename: 'PullRequest',
    title,
    number,
    state: 'OPEN',
    url: `https://github.com/sprocket/${repo}/pull/${number}`,
    updatedAt: ago(ageDays),
    repository: { nameWithOwner: `sprocket/${repo}` },
    author: { login: author },
    comments: { totalCount: 0 },
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    additions: 10,
    deletions: 2,
    ...rollup('SUCCESS', [checkRun('SUCCESS')]),
    ...extra,
  };
}

function issue(repo: string, number: number, title: string, author: string, ageDays: number, comments: number) {
  return {
    __typename: 'Issue',
    title,
    number,
    state: 'OPEN',
    url: `https://github.com/sprocket/${repo}/issues/${number}`,
    updatedAt: ago(ageDays),
    repository: { nameWithOwner: `sprocket/${repo}` },
    author: { login: author },
    comments: { totalCount: comments },
  };
}

/**
 * The nine-item, five-alias payload of tests/fixtures/stub-gh/graphql-inbox.json
 * with live timestamps: eight items inside the default "Last month" window,
 * one (issue #300) well outside it, one (PR #200) that no section wants.
 */
function buildInboxFixture(): unknown {
  const pr51 = pr('catalog-portal', 51, 'Extract billing client', 'simon-sprocket', 3, {
    comments: { totalCount: 1 },
    additions: 210,
    deletions: 88,
    ...rollup('FAILURE', [checkRun('SUCCESS'), checkRun('FAILURE'), statusContext('SUCCESS')]),
  });
  const pr60 = pr('forum-admin', 60, 'Migrate forum-admin to the shared auth client', 'mateo-sprocket', 3);
  const pr70 = pr('forum-admin', 70, 'WIP: auto-scale the operating capacity axis', 'JaviDev', 3, {
    isDraft: true,
    reviewDecision: null,
    ...rollup(null, []),
  });
  const pr80 = pr('forum-admin', 80, 'Explain the one year cap on custom invoice date ranges', 'JaviDev', 3, {
    reviewDecision: 'CHANGES_REQUESTED',
    comments: { totalCount: 2 },
  });
  const pr90 = pr('forum-admin', 90, 'Add release notes generator', 'JaviDev', 3, {
    reviewDecision: 'APPROVED',
    ...rollup('SUCCESS', [checkRun('SUCCESS'), checkRun('SUCCESS'), checkRun('SUCCESS'), checkRun('SUCCESS')]),
  });
  const pr100 = pr('forum-admin', 100, 'Filter AllocationScheduleUpdated by allocationProvider', 'JaviDev', 3, {
    ...rollup('PENDING', [statusContext('PENDING'), checkRun(null, 'IN_PROGRESS')]),
  });
  const issue12 = issue('media-upload-api', 12, 'Rate limit returns 500', 'ellen-sprocket', 3, 3);
  const pr200 = pr('other-repo', 200, 'Bump shared tooling to node 22', 'renovate[bot]', 1);
  const issue300 = issue('old-repo', 300, 'Legacy exporter drops trailing rows', 'someone-else', 200, 7);
  return {
    data: {
      direct: { nodes: [pr51] },
      team: { nodes: [pr51, pr60] },
      authored: { nodes: [pr70, pr80, pr90, pr100] },
      assigned: { nodes: [issue12] },
      involved: { nodes: [pr70, issue12, pr200, issue300] },
    },
  };
}

/** The spec's five default actions, with readable ids so the test can name them. */
const DEFAULT_ACTIONS = [
  {
    id: 'review',
    name: 'Review',
    appliesTo: ['pr'],
    prompt: 'Review the changes and summarise your findings before writing any review comments.',
  },
  {
    id: 'address-review',
    name: 'Address review',
    appliesTo: ['pr'],
    prompt:
      'Read every unresolved review thread with `gh pr view {{number}} --comments`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread.',
  },
  {
    id: 'fix-ci',
    name: 'Fix CI',
    appliesTo: ['pr'],
    prompt: 'Find the failing checks with `gh pr checks {{number}}`, reproduce locally, fix, push.',
  },
  {
    id: 'implement',
    name: 'Implement',
    appliesTo: ['issue'],
    prompt: 'Investigate it and propose a plan before changing anything.',
  },
  {
    id: 'triage',
    name: 'Triage',
    appliesTo: ['issue'],
    prompt: 'Reproduce, label the severity, and comment your findings. Do not change code.',
  },
];

const SECTION_DEFAULTS = {
  'needs-your-review': 'review',
  'needs-team-review': 'review',
  'needs-action': 'address-review',
  waiting: 'fix-ci',
  issues: 'implement',
};

/**
 * Seed a provider-bound v7 workspace directly into the profile. main/index.ts
 * appends ' Test' to the profile dir under NODE_ENV=test (PROFILE_SUFFIX), so
 * the file must land there. Shape per B's v7 contract -- if the on-disk field
 * names drifted, fix this seed against src/shared/workspace.ts.
 */
function seedWorkspaceState(userDataDir: string, repoDir: string): string {
  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const workspaceId = 'ws-inbox-e2e';
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify(
      {
        version: 7,
        workspaces: [
          {
            id: workspaceId,
            name: 'Sprocket',
            defaultHarnessId: 'default',
            scopes: [
              {
                id: 'scope-controller',
                name: 'catalog-portal',
                path: repoDir,
                isGitRepo: true,
                createdAt: now,
              },
            ],
            groups: [],
            provider: { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' },
            actions: DEFAULT_ACTIONS,
            sectionDefaults: SECTION_DEFAULTS,
            sessions: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2
    )
  );
  return workspaceId;
}

interface SeededSession {
  id?: string;
  name?: string;
  workItem?: { provider: string; repo: string; type: string; number: number };
  workItemAction?: string;
  cwd?: string;
  scopeId?: string;
  kind?: string;
}

interface SeededAction {
  id: string;
  name: string;
}

function readState(stateFile: string): { sessions: SeededSession[]; actions: SeededAction[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      sessions: parsed.workspaces?.[0]?.sessions ?? [],
      actions: parsed.workspaces?.[0]?.actions ?? [],
    };
  } catch {
    return { sessions: [], actions: [] }; // mid-write; the poll comes back
  }
}

const sessionsIn = (stateFile: string) => readState(stateFile).sessions;
const sessionsOn51 = (stateFile: string) =>
  sessionsIn(stateFile).filter((session) => session.workItem?.number === 51);

/** Open the Inbox from the sidebar, select PR #51's row, and hand back the pane. */
async function openPaneFor51(page: Page): Promise<Locator> {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Inbox/ }).click();
  const row = page.locator(`[data-work-item-key="${PR51_KEY}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const pane = page.locator('.inbox-pane-slot');
  await expect(pane).toBeVisible();
  return pane;
}

/**
 * Click a pane action and, if the pane asks first because another session on
 * the item is busy, say "Start anyway". Whether it asks depends on what the
 * earlier session's terminal is doing on this machine, so both answers are
 * correct here; the assertion that matters is the record that follows.
 */
async function startAction(pane: Locator, actionId: string): Promise<void> {
  await pane.locator(`[data-action-id="${actionId}"]`).click();
  const confirm = pane.getByRole('button', { name: /Start anyway/ });
  const asked = await confirm.waitFor({ state: 'visible', timeout: 1_500 }).then(
    () => true,
    () => false
  );
  if (asked) await confirm.click();
}

test('sections, views and filters render; actions, links and renames flow through the pane', async () => {
  test.setTimeout(240_000);

  const userDataDir = createProfileDir();
  const cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-inbox-'));
  const repoDir = path.join(cloneRoot, 'catalog-portal');
  initClone(repoDir);
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-worktrees-'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-inbox-fixture-'));
  const fixturePath = path.join(fixtureDir, 'graphql-inbox.json');
  fs.writeFileSync(fixturePath, JSON.stringify(buildInboxFixture(), null, 2));
  seedWorkspaceState(userDataDir, repoDir);
  const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');

  let app: ElectronApplication | undefined;
  try {
    const launched = await launchElectron({
      userDataDir,
      env: {
        CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
        CONSOLA_WORKTREES_DIR: worktreesDir,
        GRAPHQL_INBOX_FIXTURE: fixturePath,
        PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    app = launched.app;
    const { page } = launched;

    // "Bind" is a seeded bound workspace, held through the real switcher UI
    // (windows.spec.ts precedent: a raw IPC call would not update what the
    // window renders).
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Sprocket/ }).click();

    const inboxRow = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Inbox/ });
    await expect(inboxRow).toBeVisible({ timeout: 10_000 });
    await inboxRow.click();

    // --- Sections, with the default "Last month" filter: seven sectioned
    // items, one per section; PR #200 has no section, issue #300 is too old.
    const tabCount = (id: string) => page.locator(`[data-testid="inbox-tab-${id}"] .inbox-view-tab-count`);
    await expect(tabCount('inbox')).toHaveText('7', { timeout: 15_000 });
    for (const section of SECTIONS) {
      await expect(
        page.locator(`[data-testid="inbox-section-${section}"] .inbox-section-count`)
      ).toHaveText('1');
    }
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"]`)).toBeVisible();
    await expect(page.locator('[data-work-item-key="github:sprocket/other-repo:pr:200"]')).toHaveCount(0);
    // The sidebar badge is the sectioned count too.
    await expect(page.locator('.app-navigation-badge')).toHaveText('7');

    // Collapsed by default: the team-review section shows its count, not its row.
    await expect(page.locator('[data-work-item-key="github:sprocket/forum-admin:pr:60"]')).toHaveCount(0);
    await page.locator('[data-testid="inbox-section-needs-team-review"] .inbox-section-toggle').click();
    await expect(page.locator('[data-work-item-key="github:sprocket/forum-admin:pr:60"]')).toBeVisible();
    await page.locator('[data-testid="inbox-section-needs-team-review"] .inbox-section-toggle').click();
    await expect(page.locator('[data-work-item-key="github:sprocket/forum-admin:pr:60"]')).toHaveCount(0);

    // --- Ruling 1 (Phase C preserved): the un-cloned repo's issue offers
    // only the clone path in the pane -- no [data-action-id] at all. The
    // Issues section is expanded by default, so the row needs no toggle.
    const uncloned = page.locator('.inbox-row', { hasText: 'Rate limit returns 500' });
    await uncloned.click();
    const unclonedPane = page.locator('.inbox-pane-slot');
    await expect(unclonedPane.locator('.inbox-pane-clone', { hasText: 'Clone into scope' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(unclonedPane.locator('[data-action-id]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(unclonedPane).toHaveCount(0);

    // The gear opens Workspace Settings for this workspace (Phase A's door),
    // and closing it leaves the Inbox exactly where it was (Phase A: the
    // sidebar row stays the active one).
    await page.locator('.inbox-settings-button').click();
    const settingsFromGear = page.getByRole('dialog', { name: 'Sprocket' });
    await expect(settingsFromGear).toBeVisible();
    await settingsFromGear.getByRole('button', { name: 'Close' }).click();
    await expect(settingsFromGear).toBeHidden();
    await expect(inboxRow).toHaveClass(/active/);

    // --- Views: Involves me is everything in the window, sections or not.
    await page.locator('[data-testid="inbox-tab-involved"]').click();
    await expect(tabCount('involved')).toHaveText('8');
    await expect(page.locator('[data-work-item-key="github:sprocket/other-repo:pr:200"]')).toBeVisible();
    await expect(page.locator('[data-work-item-key="github:sprocket/old-repo:issue:300"]')).toHaveCount(0);

    // --- Updated filter: "Any time" lets the six-month-old issue through.
    await page.locator('.inbox-updated-filter-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Any time' }).click();
    await expect(page.locator('.inbox-updated-filter-trigger')).toContainText('Any time');
    await expect(tabCount('involved')).toHaveText('9');
    await expect(page.locator('[data-work-item-key="github:sprocket/old-repo:issue:300"]')).toBeVisible();
    // The old issue has no section, so the Inbox tab is unchanged by it.
    await page.locator('[data-testid="inbox-tab-inbox"]').click();
    await expect(tabCount('inbox')).toHaveText('7');

    // --- Repository filter: one repo ticked leaves one row; unticking restores
    // the four rows the expanded sections show (three sections stay folded).
    await page.locator('.inbox-repo-filter-trigger').click();
    const controllerApp = page.getByRole('menuitemcheckbox', { name: 'sprocket/catalog-portal' });
    await controllerApp.click();
    await expect(page.locator('.inbox-row')).toHaveCount(1);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"]`)).toBeVisible();
    await expect(tabCount('inbox')).toHaveText('1');
    // The menu stayed open across the tick; untick and dismiss it.
    await controllerApp.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.inbox-row')).toHaveCount(4);
    await expect(tabCount('inbox')).toHaveText('7');

    // --- Start "Review" from the pane: worktree first, record second, spawn third.
    const row51 = page.locator(`[data-work-item-key="${PR51_KEY}"]`);
    await row51.click();
    const pane = page.locator('.inbox-pane-slot');
    await expect(pane).toBeVisible();
    await expect(pane.locator('[data-action-id="review"]')).toBeVisible();
    await expect(pane.locator('.inbox-pane-session-row')).toHaveCount(0);
    await startAction(pane, 'review');

    const worktree = path.join(worktreesDir, 'catalog-portal-pr-51');
    await expect
      .poll(() => fs.existsSync(path.join(worktree, '.git')), { timeout: 20_000 })
      .toBe(true);
    expect(
      execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe('stub-pr-51'); // the stub's `gh pr checkout` branch

    await expect.poll(() => sessionsIn(stateFile).length, { timeout: 20_000 }).toBe(1);
    const [first] = sessionsIn(stateFile);
    expect(first.workItem).toMatchObject({
      provider: 'github',
      repo: 'sprocket/catalog-portal',
      type: 'pr',
      number: 51,
    });
    expect(first.workItemAction).toBe('Review');
    expect(first.cwd).toBe(worktree);
    expect(first.scopeId).toBe('scope-controller');
    expect(first.kind).toBe('interactive');

    // The launch activated the session and closed the Inbox; back in, the
    // pane lists the one session and the row hints at it.
    const paneAfterFirst = await openPaneFor51(page);
    await expect(paneAfterFirst.locator('.inbox-pane-session-row')).toHaveCount(1);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"] .inbox-row-sessions`)).toContainText(
      '1 session'
    );

    // --- A second action on the same item mints a second session in the
    // same worktree -- one worktree per item, shared (ruling 1: same cwd,
    // persisted).
    await startAction(paneAfterFirst, 'fix-ci');
    await expect.poll(() => sessionsIn(stateFile).length, { timeout: 20_000 }).toBe(2);
    const [a, b] = sessionsIn(stateFile);
    expect(a.id).not.toBe(b.id);
    expect(a.cwd).toBe(worktree);
    expect(b.cwd).toBe(worktree);
    expect(sessionsIn(stateFile).map((session) => session.workItemAction).sort()).toEqual([
      'Fix CI',
      'Review',
    ]);

    const paneAfterSecond = await openPaneFor51(page);
    await expect(paneAfterSecond.locator('.inbox-pane-session-row')).toHaveCount(2);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"] .inbox-row-sessions`)).toContainText(
      '2 sessions'
    );

    // Home owns the scoped quick-session controls; Inbox hides that sidebar.
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: 'New ungrouped session' }).click();
    const plainRow = page.locator('.session-nav-item', { hasText: 'New Session' });
    await expect(plainRow).toBeVisible({ timeout: 10_000 });
    const plainCwd = sessionsIn(stateFile).find(session => !session.workItem)?.cwd;
    await plainRow.hover();
    await plainRow.getByRole('button', { name: 'Session actions' }).click();
    // Ruling 1: the menu item renders three literal dots, not an ellipsis.
    await page.getByRole('menuitem', { name: 'Link to work item...' }).click();
    const linkDialog = page.getByRole('dialog');
    await expect(linkDialog).toBeVisible();
    // SearchableList's activation gesture: Enter on the highlighted row.
    // The search input is role="combobox" (SearchableList.tsx), not "textbox".
    await linkDialog.getByRole('combobox').fill('Extract billing client');
    await linkDialog.getByRole('combobox').press('Enter');
    await expect.poll(() => sessionsOn51(stateFile).length, { timeout: 15_000 }).toBe(3);
    const linked = sessionsOn51(stateFile).find((session) => session.workItemAction === undefined);
    expect(linked?.name).toBe('New Session');
    expect(linked?.cwd).toBe(plainCwd); // linking never moves a session
    await expect(linkDialog).toBeHidden({ timeout: 10_000 });

    const paneAfterLink = await openPaneFor51(page);
    await expect(paneAfterLink.locator('.inbox-pane-session-row')).toHaveCount(3);
    await expect(paneAfterLink.locator('.inbox-pane-session-row', { hasText: 'New Session' })).toHaveCount(1);

    // --- Ruling 1 (Phase C preserved): the sidebar row now reads the linked
    // glyph, and Unlink is metadata-only -- the record loses the relation.
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
    await expect(plainRow.locator('.session-nav-item-name')).toHaveText(/^⑂ /);
    await plainRow.hover();
    await plainRow.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Unlink' }).click();
    await expect
      .poll(() => sessionsOn51(stateFile).length, { timeout: 10_000 })
      .toBe(2);
    const unlinked = sessionsIn(stateFile).find((session) => session.name === 'New Session');
    expect(unlinked?.workItem).toBeUndefined();
    expect(unlinked?.workItemAction).toBeUndefined();

    // --- Rename an action in Workspace Settings (top-bar menu door). The
    // pane's button follows the record; the launched session keeps the name
    // it was started under, because workItemAction is a snapshot.
    await page.getByRole('button', { name: / workspace menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    const settings = page.getByRole('dialog', { name: 'Sprocket' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Actions' }).click();
    // Ruling 1: the shipped master/detail editor -- Edit opens the row,
    // "Action name" is the field, Save commits it. Not input[value=…]+Enter.
    await settings.getByRole('button', { name: 'Edit Review' }).click();
    const reviewNameField = settings.getByRole('textbox', { name: 'Action name' });
    await expect(reviewNameField).toHaveValue('Review');
    await reviewNameField.fill('Deep review');
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => readState(stateFile).actions.find((action) => action.id === 'review')?.name, {
        timeout: 10_000,
      })
      .toBe('Deep review');
    await settings.getByRole('button', { name: 'Close' }).click();
    await expect(settings).toBeHidden();

    const paneAfterRename = await openPaneFor51(page);
    await expect(paneAfterRename.locator('[data-action-id="review"]')).toContainText('Deep review');
    // The contrast: the live list says Deep review, the first session still says Review.
    await expect(
      paneAfterRename.locator('.inbox-pane-session-row', { hasText: 'PR #51 · Review' })
    ).toHaveCount(1);
    await expect(
      paneAfterRename.locator('.inbox-pane-session-row', { hasText: 'PR #51 · Fix CI' })
    ).toHaveCount(1);
    await expect(
      paneAfterRename.locator('.inbox-pane-session-row', { hasText: 'Deep review' })
    ).toHaveCount(0);
    // The linked session was unlinked above, so only the two launched
    // sessions still carry a workItem on #51.
    expect(sessionsOn51(stateFile).map((session) => session.workItemAction).sort()).toEqual([
      'Fix CI',
      'Review',
    ]);

    // Escape closes the pane and nothing else.
    await page.keyboard.press('Escape');
    await expect(page.locator('.inbox-pane-slot')).toHaveCount(0);
    await expect(page.locator(`[data-work-item-key="${PR51_KEY}"]`)).toBeVisible();
  } finally {
    // Guaranteed even if an assertion above throws: a mid-test failure must
    // not leave a real Electron process running for the rest of the worker,
    // nor leave its profile/clone/worktree/fixture directories behind in the
    // OS temp dir forever.
    await app?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(cloneRoot, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('an item reads as one stream, and a review is written and sent without leaving the pane', async () => {
  test.setTimeout(150_000);
  const userDataDir = createProfileDir();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-remote-details-'));
  const fixturePath = path.join(fixtureDir, 'inbox.json');
  const logPath = path.join(fixtureDir, 'calls.log');
  const failurePath = path.join(fixtureDir, 'reject-writes');
  // The stub's details, behind their base so the merge card offers Update branch.
  const detailsDir = path.join(fixtureDir, 'details');
  fs.cpSync(path.join(STUB_GH_DIR, 'details'), detailsDir, { recursive: true });
  for (const name of ['ConsolaPullRequest.json', 'ConsolaPullRequest.pending.json']) {
    const file = path.join(detailsDir, name);
    const reply = JSON.parse(fs.readFileSync(file, 'utf8'));
    reply.data.repository.pullRequest.mergeStateStatus = 'BEHIND';
    fs.writeFileSync(file, JSON.stringify(reply));
  }
  // Where the stub keeps whether a review is pending: starting one creates it.
  const stateDir = path.join(fixtureDir, 'state');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(fixturePath, JSON.stringify(buildInboxFixture()));
  seedWorkspaceState(userDataDir, fixtureDir);
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchElectron({ userDataDir, env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'), GRAPHQL_INBOX_FIXTURE: fixturePath,
      STUB_GH_LOG: logPath, STUB_GH_MUTATION_FAILURE_FILE: failurePath,
      STUB_GH_DETAILS_DIR: detailsDir, STUB_GH_STATE_DIR: stateDir,
    } });
    app = launched.app;
    const { page } = launched;
    const calls = () => fs.readFileSync(logPath, 'utf8');
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Sprocket/ }).click();
    const pane = await openPaneFor51(page);
    const remote = pane.getByRole('region', { name: 'Remote item details' });
    await expect(remote.getByText('regression coverage', { exact: true })).toBeVisible();
    // The status strip sits with the item's name, above the sessions dock.
    const strip = pane.locator('.inbox-pane-detail-head');
    await expect(strip.getByText(/as JaviDev/)).toHaveCount(0);
    await expect(pane.locator('.inbox-pane-meta')).not.toContainText('simon-sprocket');
    await expect(strip.locator('.inbox-detail-branches code')).toHaveText(['main', 'extract-billing-client-and-add-regression-coverage']);
    await expect(pane.getByText('No sessions on this item yet.')).toBeVisible();
    await expect(pane.locator('.inbox-pane-meta .inbox-detail-state')).toHaveText('Open');
    // In a pane wide enough for both names and more, the branches stay
    // together: the spare width goes past the head branch, not between them.
    const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    await page.setViewportSize({ width: 2400, height });
    const branchLayout = () => strip.locator('.inbox-detail-branches').evaluate((row) => {
      const [base, head] = [...row.querySelectorAll('code')].map((chip) => chip.getBoundingClientRect());
      return { spare: row.getBoundingClientRect().right - head.right, gap: head.left - base.right };
    });
    await expect.poll(async () => (await branchLayout()).spare).toBeGreaterThan(100);
    expect((await branchLayout()).gap).toBeLessThan(30);
    // A branch cut short by a narrow pane names itself in full on hover; one that fits stays quiet.
    await page.setViewportSize({ width: 880, height });
    const branches = pane.locator('.inbox-detail-branches');
    await expect(branches.locator('[title]')).toHaveCount(0); // a native tooltip would show beside this one
    await branches.locator('code', { hasText: 'extract-billing' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('extract-billing-client-and-add-regression-coverage');
    // In steps, like a real pointer: Radix keeps a tooltip open while the
    // pointer may be heading for it, and closes on the next move that is not.
    await page.mouse.move(450, height - 40, { steps: 10 });
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    const base = branches.locator('code', { hasText: 'main' });
    await expect(base).toHaveJSProperty('scrollWidth', await base.evaluate((el) => el.clientWidth)); // "main" stays whole
    await base.hover();
    await page.waitForTimeout(600); // past the 300ms open delay
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // Nothing scrolls the pane sideways at its narrowest.
    const slot = page.locator('.inbox-pane-slot');
    await expect.poll(() => slot.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width, height });

    // --- One stream: description, the whole history, the merge card, the comment box.
    await expect(remote.getByRole('tablist', { name: 'Item details' }).getByRole('tab')).toHaveText([/^Conversation\s*5$/, /^Files changed\s*2$/]);
    await expect(remote.locator('.inbox-detail-tabs-stat')).toHaveText('+10−4');
    const stream = remote.locator('.inbox-detail-stream');
    const description = stream.getByRole('article', { name: 'simon-sprocket opened this' });
    await expect(description).toContainText('regression coverage');
    await expect(remote.getByRole('list', { name: 'Labels' })).toContainText('enhancement');
    await expect(remote.getByRole('list', { name: 'Reviewers' })).toContainText('ellen-sprocket');
    await expect(stream).toContainText('changed the title Billing client Extract billing client');
    await expect(stream).toContainText('force-pushed extract-billing-client-and-add-regression-coverage from 1e50c34 to f978427');
    await expect(stream.getByRole('list', { name: 'Commits' }).first()).toContainText('Add regression coverage');
    await expect(stream.getByText('This comment was marked as outdated.')).toBeVisible();
    const review = stream.getByRole('article', { name: 'ellen-sprocket requested changes' });
    await expect(review).toContainText('Needs validation.');
    const thread = review.getByRole('region', { name: 'Thread on billing.ts:7' });
    await expect(thread.getByRole('group', { name: 'Code for src/billing.ts' })).toContainText('Number.isFinite');
    await expect(thread).toContainText('Handle empty input here.');
    // A review that only replied has no card: its reply is in the thread.
    await expect(thread).toContainText('Agreed');
    await expect(stream.getByRole('article', { name: /^mateo-sprocket/ })).toHaveCount(0);
    await expect(review.getByRole('button', { name: /ellen-sprocket’s thread on billing\.ts:4 — resolved/ })).toBeVisible();
    await expect(review.getByRole('region', { name: 'Thread on legacy.ts:7' })).toContainText('Outdated');
    const merge = remote.getByRole('region', { name: 'Merge' });
    await expect(merge).toContainText('Changes requested');
    await expect(merge).toContainText('Some checks were not successful');
    await expect(merge.getByRole('link', { name: 'Unit tests' })).toBeVisible(); // a failure opens the list
    await expect(merge.getByRole('button', { name: 'Fix failing checks in a session' })).toBeVisible();
    await expect(merge).toContainText('This branch is behind main');
    const composer = remote.getByRole('region', { name: 'Add a comment' });
    await expect(composer).toBeVisible();

    // --- Reply to a thread, then resolve it.
    await thread.getByRole('button', { name: 'Reply…' }).click();
    await thread.getByRole('textbox', { name: 'Reply' }).fill('Added a guard.');
    await thread.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(thread.getByText('Reply posted.', { exact: true })).toBeVisible();
    await thread.getByRole('button', { name: 'Resolve conversation' }).click();
    await expect(thread.getByText('Conversation resolved.', { exact: true })).toBeVisible();
    expect(calls()).toContain('-f threadId=PRRT_1 -f body=Added a guard. GH_TOKEN=gho_stub_token_for_JaviDev');
    expect(calls()).toMatch(/mutation ConsolaResolveThread.* -f threadId=PRRT_1 /);

    // --- The comment box: a refusal keeps the text; typed text rides along on Close.
    const commentField = composer.getByRole('textbox', { name: 'Comment' });
    await commentField.fill('Test comment from Consola');
    await expect(composer.getByRole('button', { name: 'Close with comment' })).toBeVisible();
    fs.writeFileSync(failurePath, 'reject');
    await composer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(composer.getByRole('alert')).toContainText('repository rules');
    await expect(commentField).toHaveValue('Test comment from Consola');
    fs.rmSync(failurePath);
    await composer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(composer.getByText('Comment posted.', { exact: true })).toBeVisible();
    await expect(commentField).toHaveValue('');
    await expect(composer.getByRole('button', { name: 'Close pull request' })).toBeVisible();

    // --- Update branch, from the merge card.
    await merge.getByRole('button', { name: 'Update branch' }).click();
    await expect(merge.getByText('Branch updated.', { exact: true })).toBeVisible();

    // --- The description's ⋯ edits it in place; the strip's ⋯ keeps Convert to draft.
    await description.getByRole('button', { name: /More actions for simon-sprocket/ }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(pane.getByLabel('Title', { exact: true })).toBeFocused();
    await pane.getByLabel('Title', { exact: true }).fill('Updated billing title');
    await pane.getByRole('button', { name: 'Save changes' }).click();
    await expect(pane.getByText('Changes saved.', { exact: true })).toBeVisible();
    await strip.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Convert to draft' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Close|Edit/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // --- Behind its base: no merge, and the rows in its way describe the
    // disabled button. Auto-merge is offered in its place, as on GitHub,
    // with the method chosen from the button's menu.
    const mergeButton = merge.getByRole('button', { name: 'Squash and merge' });
    await expect(mergeButton).toBeDisabled();
    await expect(mergeButton).not.toHaveClass(/inbox-detail-btn--success/);
    await expect(mergeButton).toHaveAccessibleDescription(/This branch is behind main/);
    await merge.getByRole('button', { name: 'Merge method' }).click();
    await page.getByRole('menuitemradio', { name: 'Rebase and merge' }).click();
    await expect(merge.getByRole('button', { name: 'Rebase and merge' })).toBeDisabled();
    await merge.getByRole('button', { name: 'Enable auto-merge…', exact: true }).click();
    await merge.getByRole('button', { name: 'Enable auto-merge', exact: true }).click();
    await expect(merge.getByText('Auto-merge requested.', { exact: true })).toBeVisible();

    // --- Files changed: a comment on one line, posted at once.
    await remote.getByRole('tab', { name: /Files changed/ }).click();
    await remote.locator('summary[title="Modified · src/billing.ts"]').click();
    const diff = remote.getByRole('group', { name: 'Diff for src/billing.ts' });
    await expect(diff).toContainText('createClient');
    await expect(diff.getByRole('region', { name: 'Thread on billing.ts:7' })).toContainText('Handle empty input here.');
    await diff.getByRole('button', { name: 'Comment on line +8' }).click();
    const single = diff.getByRole('group', { name: 'Commenting on line +8' });
    await single.getByRole('textbox', { name: 'Line comment' }).fill('Guard the refund too.');
    await single.getByRole('button', { name: 'Add single comment' }).click();
    await expect(diff.getByText('Comment posted.', { exact: true })).toBeVisible();
    expect(calls()).toContain('pulls/51/comments --method POST -f body=Guard the refund too. -f commit_id=1234567890123456789012345678901234567890 -f path=src/billing.ts -F line=8 -f side=RIGHT GH_TOKEN');

    // --- A range (Shift-click), held in a review that this starts.
    await diff.getByRole('button', { name: 'Comment on line +11' }).click();
    await diff.getByRole('button', { name: 'Comment on line +12' }).click({ modifiers: ['Shift'] });
    const ranged = diff.getByRole('group', { name: 'Commenting on lines +11 to +12' });
    await ranged.getByRole('textbox', { name: 'Line comment' }).fill('Refunds need the same check.');
    await ranged.getByRole('button', { name: 'Start a review' }).click();
    await expect(diff.getByText(/^Review started/)).toBeVisible();
    expect(calls()).toContain('-f commit=1234567890123456789012345678901234567890');
    expect(calls()).toContain('-f reviewId=PRR_pending1 -f body=Refunds need the same check. -f path=src/billing.ts -F line=12 -f side=RIGHT -F startLine=11 -f startSide=RIGHT');
    // Pending from here on: marked in the diff, counted on the button, and
    // the next line comment can only join the review.
    const submit = remote.getByRole('button', { name: /^Submit review/ });
    await expect(submit).toContainText('1');
    await expect(diff.locator('.inbox-detail-thread-comment[data-pending]')).toContainText('Pending');
    await diff.getByRole('button', { name: 'Comment on line +4' }).click();
    await expect(diff.getByRole('button', { name: 'Add review comment' })).toBeVisible();
    await expect(diff.getByRole('button', { name: 'Add single comment' })).toHaveCount(0);
    await diff.getByRole('group', { name: 'Commenting on line +4' }).getByRole('button', { name: 'Cancel' }).click();
    // From the keyboard the diff is one tab stop: arrows pick a line (from
    // the one last commented on, +4), Enter comments on it, Esc gives focus
    // back to the diff.
    await diff.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const keyed = diff.getByRole('group', { name: 'Commenting on line +5' });
    await expect(keyed.getByRole('textbox', { name: 'Line comment' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(keyed).toHaveCount(0);
    await expect(diff).toBeFocused();
    await expect(page.locator('.inbox-pane-slot')).toBeVisible(); // Esc closed the form, not the pane

    // --- Submit it with Request changes.
    await submit.click();
    const popover = page.getByRole('dialog', { name: 'Finish your review' });
    await expect(popover).toContainText('Sends 1 pending comment');
    await popover.getByRole('radio', { name: /Request changes/ }).check();
    await popover.getByRole('textbox', { name: 'Review summary' }).fill('Please guard refunds.');
    await popover.getByRole('button', { name: 'Submit review' }).click();
    await expect(popover).toHaveCount(0);
    await expect(remote.getByText('Review submitted.', { exact: true })).toBeVisible();
    expect(calls()).toContain('-f id=PRR_pending1 -f event=REQUEST_CHANGES -f body=Please guard refunds.');
    await expect(submit).not.toContainText('1');

    await expect(pane.getByRole('button', { name: 'Refresh details' })).toBeEnabled();
    expect(calls()).toContain('pr comment 51 --repo github.com/sprocket/catalog-portal --body Test comment from Consola GH_TOKEN=gho_stub_token_for_JaviDev');
    expect(calls()).toContain('pr update-branch 51 --repo github.com/sprocket/catalog-portal GH_TOKEN=gho_stub_token_for_JaviDev');
    expect(calls()).toContain('--rebase --match-head-commit 1234567890123456789012345678901234567890 --auto');
    await remote.getByRole('tab', { name: /Conversation/ }).click();
    await page.screenshot({ path: path.join(test.info().outputDir, 'github-details.png') });
  } finally {
    await app?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('a linked session shows its item pane beside the terminal, and Fix pastes into that session', async () => {
  test.setTimeout(90_000);
  const userDataDir = createProfileDir();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-session-details-'));
  const fixturePath = path.join(fixtureDir, 'inbox.json');
  const pastedPath = path.join(fixtureDir, 'pasted.txt');
  const agent = path.join(fixtureDir, 'agent.sh');
  // Raw mode hands the agent every byte as it arrives: a paste has no newline
  // to wait for. Appending, because a health or capability probe runs this
  // stub too, and must not wipe what the session received.
  fs.writeFileSync(
    agent,
    [
      '#!/bin/sh',
      'case "$*" in *--version*) echo "2.1.0 (Claude Code)"; exit 0;; esac',
      'printf "Agent ready\\n"',
      'stty raw -echo 2>/dev/null',
      `exec cat >> "${pastedPath}"`,
    ].join('\n'),
    { mode: 0o755 }
  );
  fs.writeFileSync(fixturePath, JSON.stringify(buildInboxFixture()));
  // A real clone, so the pane offers actions rather than "Clone into scope".
  const repoDir = path.join(fixtureDir, 'catalog-portal');
  initClone(repoDir);
  const workspaceId = seedWorkspaceState(userDataDir, repoDir);
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchElectron({ userDataDir, env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'), GRAPHQL_INBOX_FIXTURE: fixturePath,
    } });
    app = launched.app;
    const { page } = launched;
    await page.evaluate(
      async ({ workspaceId, binaryPath }) => {
        await window.harnessStateAPI.addHarness({ id: 'stub', driverId: 'claude', name: 'Stub', accentColor: '#555555', binaryPath });
        const link = (number: number, workItemAction: string, instanceId: string) =>
          window.workspaceAPI.createSession(workspaceId, {
            name: 'New Session', workspaceId, instanceId, harnessId: 'stub', scopeId: 'scope-controller',
            workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number },
            workItemAction,
          });
        await link(51, 'Fix CI', 'details-e2e');
        // #52 is not in the Inbox: merged, closed, or out of its window.
        await link(52, 'Review', 'details-e2e-unlisted');
      },
      { workspaceId, binaryPath: agent }
    );
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Sprocket/ }).click();
    await page.locator('.session-nav-item', { hasText: 'PR #51 · Fix CI' }).click();
    // The agent is up, in raw mode, and listening.
    await expect.poll(() => fs.existsSync(pastedPath), { timeout: 15_000 }).toBe(true);

    // Facts about the session are text; only the toggle is a button.
    const strip = page.locator('.work-item-strip');
    await expect(strip.getByText('Fix CI', { exact: true })).toBeVisible();
    await expect(strip.getByRole('button', { name: 'Fix CI' })).toHaveCount(0);
    const toggle = strip.getByRole('button', { name: 'Details' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const panel = page.getByTestId('work-item-panel');
    await expect(panel).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // The whole Inbox pane: header, remote details, sessions, ways to start one.
    const pane = panel.getByRole('complementary', { name: 'Work item details' });
    await expect(pane.getByRole('heading', { name: 'Extract billing client' })).toBeVisible();
    const remote = pane.getByRole('region', { name: 'Remote item details' });
    await expect(remote.getByText('regression coverage', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(pane.locator('.inbox-pane-detail-head').getByRole('button', { name: 'Refresh details' })).toBeVisible();
    await expect(pane.locator('.inbox-pane-count')).toHaveText('1');
    const thisRow = pane.locator('.inbox-pane-session-row', { hasText: 'PR #51 · Fix CI' });
    await expect(thisRow).toContainText('This session');
    await expect(thisRow.getByRole('button', { name: /^Open / })).toHaveCount(0);
    await expect(pane.locator('[data-action-id="review"]')).toBeVisible();

    // A Fix goes to the session on screen, not to a new one: pasted into its
    // composer and left for the person to send.
    const merge = remote.getByRole('region', { name: 'Merge' });
    await expect(merge.getByRole('button', { name: 'Fix failing checks in a session' })).toHaveCount(0);
    await merge.getByRole('button', { name: 'Fix failing checks in this session' }).click();
    await expect
      .poll(() => fs.readFileSync(pastedPath, 'utf8'), { timeout: 10_000 })
      .toContain('\x1b[200~Investigate and fix the failing CI checks for https://github.com/sprocket/catalog-portal/pull/51.');
    await expect(page.locator('.terminal-panel .terminal-surface textarea')).toBeFocused();
    await expect(pane.getByRole('textbox', { name: 'Custom prompt' })).toHaveCount(0);
    await page.screenshot({ path: path.join(test.info().outputDir, 'session-work-item-panel.png') });

    // The panel is a preference: the next linked session shows it too. Its
    // item is not in the Inbox, so the pane names it from a fresh read.
    await page.locator('.session-nav-item', { hasText: 'PR #52 · Review' }).click();
    await expect(pane.locator('.inbox-pane-meta')).toContainText('sprocket/catalog-portal#52');
    await expect(pane.getByRole('heading', { name: 'Extract billing client' })).toBeVisible({ timeout: 15_000 });
    await expect(pane.locator('.inbox-pane-meta .inbox-detail-state')).toHaveText('Open');

    await pane.getByRole('button', { name: 'Close details' }).click();
    await expect(panel).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('an action runs again in its own session: Continue types into it, Fresh starts its conversation over in the same tab', async () => {
  test.setTimeout(120_000);
  const userDataDir = createProfileDir();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-run-in-session-'));
  const fixturePath = path.join(fixtureDir, 'inbox.json');
  const argsPath = path.join(fixtureDir, 'args.log');
  const inputPath = path.join(fixtureDir, 'input.log');
  const agent = path.join(fixtureDir, 'agent.sh');
  // Each launch logs its argv, paints an empty composer — what prompt
  // delivery waits for — and appends every byte it is sent. Appending,
  // because a probe and both conversations write to the same files.
  fs.writeFileSync(
    agent,
    [
      '#!/bin/sh',
      'case "$*" in *--version*) echo "2.1.0 (Claude Code)"; exit 0;; esac',
      `printf '%s\\n' "$*" >> "${argsPath}"`,
      'printf "Agent ready\\r\\n❯ "',
      'stty raw -echo 2>/dev/null',
      `exec cat >> "${inputPath}"`,
    ].join('\n'),
    { mode: 0o755 }
  );
  fs.writeFileSync(fixturePath, JSON.stringify(buildInboxFixture()));
  const repoDir = path.join(fixtureDir, 'catalog-portal');
  initClone(repoDir);
  const workspaceId = seedWorkspaceState(userDataDir, repoDir);
  const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');
  const record = () =>
    (JSON.parse(fs.readFileSync(stateFile, 'utf8')).workspaces[0].sessions as Array<{
      id: string;
      claudeSessionId: string;
      workItem?: { number: number };
    }>).filter((session) => session.workItem?.number === 51);
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

  let app: ElectronApplication | undefined;
  try {
    const launched = await launchElectron({ userDataDir, env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'), GRAPHQL_INBOX_FIXTURE: fixturePath,
    } });
    app = launched.app;
    const { page } = launched;
    await page.evaluate(
      async ({ workspaceId, binaryPath }) => {
        await window.harnessStateAPI.addHarness({ id: 'stub', driverId: 'claude', name: 'Stub', accentColor: '#555555', binaryPath });
        await window.workspaceAPI.createSession(workspaceId, {
          name: 'New Session', workspaceId, instanceId: 'run-in-session-e2e', harnessId: 'stub', scopeId: 'scope-controller',
          workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 },
          workItemAction: 'Review',
        });
      },
      { workspaceId, binaryPath: agent }
    );
    await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: /Sprocket/ }).click();

    // A follow-up action that starts fresh, made in the action editor.
    await page.getByRole('button', { name: / workspace menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('button', { name: 'Actions', exact: true }).click();
    const actionsPanel = modal.getByTestId('actions-panel');
    await actionsPanel.getByRole('button', { name: 'Add action' }).click();
    await actionsPanel.getByLabel('Action name').fill('Re-review');
    await actionsPanel
      .getByLabel('What running this action in an existing session does to its conversation')
      .selectOption('fresh');
    await actionsPanel.getByLabel('Action prompt').fill('Pull the latest and check #{{number}} again.');
    await actionsPanel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(actionsPanel.locator('.ws-action-row', { hasText: 'Re-review' })).toContainText('Fresh');
    await expect
      .poll(() => readState(stateFile).actions.find((action) => action.name === 'Re-review'), { timeout: 10_000 })
      .toMatchObject({ conversation: 'fresh', appliesTo: ['pr'] });
    // An action left on the default stores no setting at all.
    expect(readState(stateFile).actions.find((action) => action.name === 'Review')).not.toHaveProperty('conversation');
    await modal.getByRole('button', { name: 'Close', exact: true }).click();

    // Open the session: its first launch creates the recorded conversation.
    await page.locator('.session-nav-item', { hasText: 'PR #51 · Review' }).click();
    const [{ id: sessionId, claudeSessionId: first }] = record();
    await expect.poll(() => read(argsPath), { timeout: 15_000 }).toContain(`--session-id ${first}`);

    // Continue: the body alone goes into the running conversation.
    const strip = page.locator('.work-item-strip');
    await strip.getByRole('button', { name: /^Run an action in / }).click();
    const menu = page.getByTestId('run-action-menu');
    await expect(menu.getByText('Run in this session')).toBeVisible();
    await expect(menu.locator('[data-action-id="review"]')).toContainText('Continues this conversation');
    await expect(menu.locator('[data-action-id="implement"]')).toHaveCount(0);
    const reReview = menu.locator('.run-action-item', { hasText: 'Re-review' });
    await expect(reReview).toContainText('Starts a fresh conversation');
    // Settled past the menu's fade-in, so the screenshot shows what is read.
    await expect(menu).toHaveCSS('opacity', '1');
    await page.screenshot({ path: path.join(test.info().outputDir, 'run-action-menu.png') });
    await menu.locator('[data-action-id="review"]').click();
    await expect(menu).toHaveCount(0);
    await expect
      .poll(() => read(inputPath), { timeout: 10_000 })
      .toContain('\x1b[200~Review the changes and summarise your findings before writing any review comments.\x1b[201~\r');
    expect(read(inputPath)).not.toContain('This session is for pull request #51');
    expect(record()).toEqual([expect.objectContaining({ id: sessionId, claudeSessionId: first })]);

    // Fresh: the same tab moves onto a new conversation, created rather than
    // resumed, and it opens with the item's header and the action's body.
    await strip.getByRole('button', { name: /^Run an action in / }).click();
    await menu.locator('.run-action-item', { hasText: 'Re-review' }).click();
    await expect.poll(() => record()[0]?.claudeSessionId, { timeout: 10_000 }).not.toBe(first);
    const [{ id: sameId, claudeSessionId: second }] = record();
    expect(sameId).toBe(sessionId);
    expect(record()).toHaveLength(1);
    await expect.poll(() => read(argsPath), { timeout: 15_000 }).toContain(`--session-id ${second}`);
    expect(read(argsPath)).not.toContain(`--resume ${second}`);
    await expect
      .poll(() => read(inputPath), { timeout: 10_000 })
      .toMatch(/\x1b\[200~This session is for pull request #51 \("Extract billing client"\)[^\x1b]*\n\nPull the latest and check #51 again\.\x1b\[201~/);
    // The pane is live on the new conversation, not offering a restart.
    await expect(page.locator('.terminal-restart-button')).toHaveCount(0);

    // The same menu sits on the session's row in the Inbox, and running from
    // there opens the session it ran in.
    const pane = await openPaneFor51(page);
    const row = pane.locator('.inbox-pane-session-row', { hasText: 'PR #51 · Review' });
    await row.hover();
    await page.screenshot({ path: path.join(test.info().outputDir, 'run-action-inbox-row.png') });
    await row.getByRole('button', { name: /^Run an action in / }).click();
    await expect(menu.locator('.run-action-item', { hasText: 'Re-review' })).toBeVisible();
    await menu.locator('[data-action-id="fix-ci"]').click();
    await expect(page.locator('.work-item-strip')).toBeVisible();
    await expect
      .poll(() => read(inputPath), { timeout: 10_000 })
      .toContain('Find the failing checks with `gh pr checks 51`, reproduce locally, fix, push.');
    expect(record()).toEqual([expect.objectContaining({ id: sessionId, claudeSessionId: second })]);
  } finally {
    await app?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
