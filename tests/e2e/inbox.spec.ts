import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');
const PR51_KEY = 'github:sympower/controller-app:pr:51';
const SECTIONS = [
  'needs-your-review',
  'needs-team-review',
  'your-drafts',
  'waiting',
  'needs-action',
  'ready-to-merge',
  'issues',
];

/** A local clone whose origin matches the fixture's sympower/controller-app. */
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
    'https://github.com/sympower/controller-app.git',
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
    url: `https://github.com/sympower/${repo}/pull/${number}`,
    updatedAt: ago(ageDays),
    repository: { nameWithOwner: `sympower/${repo}` },
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
    url: `https://github.com/sympower/${repo}/issues/${number}`,
    updatedAt: ago(ageDays),
    repository: { nameWithOwner: `sympower/${repo}` },
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
  const pr51 = pr('controller-app', 51, 'Extract billing client', 'steve-sympower', 3, {
    comments: { totalCount: 1 },
    additions: 210,
    deletions: 88,
    ...rollup('FAILURE', [checkRun('SUCCESS'), checkRun('FAILURE'), statusContext('SUCCESS')]),
  });
  const pr60 = pr('flex-portal', 60, 'Migrate flex-portal to the shared auth client', 'maria-sympower', 3);
  const pr70 = pr('flex-portal', 70, 'WIP: auto-scale the operating envelope axis', 'SymJavi', 3, {
    isDraft: true,
    reviewDecision: null,
    ...rollup(null, []),
  });
  const pr80 = pr('flex-portal', 80, 'Explain the one year cap on custom revenue date ranges', 'SymJavi', 3, {
    reviewDecision: 'CHANGES_REQUESTED',
    comments: { totalCount: 2 },
  });
  const pr90 = pr('flex-portal', 90, 'Add release notes generator', 'SymJavi', 3, {
    reviewDecision: 'APPROVED',
    ...rollup('SUCCESS', [checkRun('SUCCESS'), checkRun('SUCCESS'), checkRun('SUCCESS'), checkRun('SUCCESS')]),
  });
  const pr100 = pr('flex-portal', 100, 'Filter ActivationScheduleUpdated by activationProvider', 'SymJavi', 3, {
    ...rollup('PENDING', [statusContext('PENDING'), checkRun(null, 'IN_PROGRESS')]),
  });
  const issue12 = issue('msa-resource-bff', 12, 'Rate limit returns 500', 'erkki-sympower', 3, 3);
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
            name: 'Sympower',
            defaultHarnessId: 'default',
            scopes: [
              {
                id: 'scope-controller',
                name: 'controller-app',
                path: repoDir,
                isGitRepo: true,
                createdAt: now,
              },
            ],
            groups: [],
            provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
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
  await page.locator('.sidebar-inbox-row').click();
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
  const repoDir = path.join(cloneRoot, 'controller-app');
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
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: /Sympower/ }).click();

    const inboxRow = page.locator('.sidebar-inbox-row');
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
    await expect(page.locator('[data-work-item-key="github:sympower/other-repo:pr:200"]')).toHaveCount(0);
    // The sidebar badge is the sectioned count too.
    await expect(page.locator('.sidebar-inbox-count')).toHaveText('7');

    // Collapsed by default: the team-review section shows its count, not its row.
    await expect(page.locator('[data-work-item-key="github:sympower/flex-portal:pr:60"]')).toHaveCount(0);
    await page.locator('[data-testid="inbox-section-needs-team-review"] .inbox-section-toggle').click();
    await expect(page.locator('[data-work-item-key="github:sympower/flex-portal:pr:60"]')).toBeVisible();
    await page.locator('[data-testid="inbox-section-needs-team-review"] .inbox-section-toggle').click();
    await expect(page.locator('[data-work-item-key="github:sympower/flex-portal:pr:60"]')).toHaveCount(0);

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
    const settingsFromGear = page.getByRole('dialog', { name: 'Sympower' });
    await expect(settingsFromGear).toBeVisible();
    await settingsFromGear.getByRole('button', { name: 'Close' }).click();
    await expect(settingsFromGear).toBeHidden();
    await expect(inboxRow).toHaveClass(/active/);

    // --- Views: Involves me is everything in the window, sections or not.
    await page.locator('[data-testid="inbox-tab-involved"]').click();
    await expect(tabCount('involved')).toHaveText('8');
    await expect(page.locator('[data-work-item-key="github:sympower/other-repo:pr:200"]')).toBeVisible();
    await expect(page.locator('[data-work-item-key="github:sympower/old-repo:issue:300"]')).toHaveCount(0);

    // --- Updated filter: "Any time" lets the six-month-old issue through.
    await page.locator('.inbox-updated-filter-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Any time' }).click();
    await expect(page.locator('.inbox-updated-filter-trigger')).toContainText('Any time');
    await expect(tabCount('involved')).toHaveText('9');
    await expect(page.locator('[data-work-item-key="github:sympower/old-repo:issue:300"]')).toBeVisible();
    // The old issue has no section, so the Inbox tab is unchanged by it.
    await page.locator('[data-testid="inbox-tab-inbox"]').click();
    await expect(tabCount('inbox')).toHaveText('7');

    // --- Repository filter: one repo ticked leaves one row; unticking restores
    // the four rows the expanded sections show (three sections stay folded).
    await page.locator('.inbox-repo-filter-trigger').click();
    const controllerApp = page.getByRole('menuitemcheckbox', { name: 'sympower/controller-app' });
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

    const worktree = path.join(worktreesDir, 'controller-app-pr-51');
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
      repo: 'sympower/controller-app',
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

    // --- Link a hand-made session from the sidebar. The `+` on the scope row
    // creates "New Session" and activates it; its row's menu offers the link.
    await page.getByRole('button', { name: 'New session in controller-app' }).click();
    const plainRow = page.locator('.session-nav-item', { hasText: 'New Session' });
    await expect(plainRow).toBeVisible({ timeout: 10_000 });
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
    expect(linked?.cwd).toBeUndefined(); // linking never moves a session
    await expect(linkDialog).toBeHidden({ timeout: 10_000 });

    const paneAfterLink = await openPaneFor51(page);
    await expect(paneAfterLink.locator('.inbox-pane-session-row')).toHaveCount(3);
    await expect(paneAfterLink.locator('.inbox-pane-session-row', { hasText: 'New Session' })).toHaveCount(1);

    // --- Ruling 1 (Phase C preserved): the sidebar row now reads the linked
    // glyph, and Unlink is metadata-only -- the record loses the relation.
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
    await page.getByRole('button', { name: /^Switch workspace/ }).click();
    await page.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    const settings = page.getByRole('dialog', { name: 'Sympower' });
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
