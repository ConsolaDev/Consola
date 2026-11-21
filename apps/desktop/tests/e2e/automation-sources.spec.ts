import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { reReviewEntry } from '@consola/automation-engine';
import { parseAutomationEntry, type RunRecord } from '@consola/factory-spec';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MOVED_ROW_PRESS_MS } from '../../src/renderer/sidebar/shiftGuard';
import { launchElectron } from './helpers/electron';

/**
 * Automations with a source, end to end: the shipped
 * `re-review-on-new-commits` template, a poll whose check command asks GitHub
 * which pull requests the person reviewed have new commits, run by the real
 * engine against a stub `claude` and the stub `gh`.
 *
 * Nothing here reaches GitHub or a model. The check command, `fresh` and
 * `publish` find the stub `gh` through the real login environment, as PR A's
 * spec (`automation-steps.spec.ts`) sets it up; its helpers are copied here,
 * not imported, so each spec runs only its own tests. The stub answers the
 * poll with the file `STUB_GH_POLL_FILE`, detaches #51's checkout at the
 * commit in `STUB_GH_PR_HEAD_FILE`, and the stub `claude` reads the documents
 * `STUB_CLAUDE_READS` names before it writes its own. The engine ticks every
 * two seconds (`CONSOLA_AUTOMATIONS_TICK_MS`), so "across ticks" is seconds.
 *
 * Each scenario launches its own app on its own temp base, and `close()`
 * removes all of it, profile included.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const STUB_GH_DIR = path.join(FIXTURES, 'stub-gh');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

const REPO = 'sprocket/catalog-portal';
const PR_URL = `https://github.com/${REPO}/pull/51`;
const PR_TITLE = 'Add catalog search';

/** The engine's tick in these tests, in milliseconds. */
const TICK_MS = 2000;

const RE_REVIEW = 're-review-on-new-commits';
const RE_REVIEW_TITLE = 'Re-review pull requests with new commits';

/** What the stub agent writes as its handover unless a test says otherwise. */
const HANDOVER = `## Review of #51

\`src/catalog.ts:1\`: the catalog is exported empty, so search has nothing to find. Seed it before merging.
`;

/** A second review, so a test can tell which run's handover a later run read. */
const SECOND_HANDOVER = `## Second review of #51

\`src/catalog.ts:1\` is seeded now. \`src/search.ts:1\` still ignores case.
`;

/** The spec's words for a `previous` document when there is no earlier run. */
const NO_EARLIER_RUN = 'There is no earlier run of this automation on this item.';

/** The banner over a poll that is not allowed yet: the spec's words, with the template's interval. */
const NOT_CHECKING_YET =
  'Not checking yet. Allowing it lets Consola run this command every 30 minutes, as you.';

/** The status line after the first check: the spec's words, for one item and `changed: .head`. */
const WATCHING_ONE = 'Watching 1 item. It runs for new ones, and when `.head` changes.';

/** The template's check command, exactly as its entry has it. */
function templateCommand(): string {
  const parsed = parseAutomationEntry(reReviewEntry());
  if (!parsed.ok)
    throw new Error(`The shipped template does not parse: ${JSON.stringify(parsed.issues)}`);
  const { trigger } = parsed.automation;
  if (trigger.kind !== 'poll') throw new Error('The shipped template is not a poll.');
  return trigger.run;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** `git` with text on its stdin: the plumbing a push is made of. */
function gitWithInput(cwd: string, input: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    input,
  }).trim();
}

/** A file's lines, none when it does not exist. */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** Text as the stubs log it: every newline a space. */
function flatten(text: string): string {
  return text.replace(/\n/g, ' ');
}

/**
 * The stub harness's binary: `node` is not on PATH, so a shell wrapper
 * execs the test runner's own Node on the checked-in fixture.
 */
function writeStubClaude(base: string): string {
  const wrapper = path.join(base, 'claude.sh');
  fs.writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      `exec '${process.execPath}' '${path.join(FIXTURES, 'claude-steps.cjs')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return wrapper;
}

/** One pull request as the template's `--jq` prints it. */
interface PolledPull {
  url: string;
  title: string;
  head: string;
}

/** One open PR in the Inbox's GraphQL shape, by alice, asking the person directly for a review. */
function requestedPull(number: number) {
  return {
    __typename: 'PullRequest',
    title: PR_TITLE,
    number,
    state: 'OPEN',
    url: `https://github.com/${REPO}/pull/${number}`,
    updatedAt: '2026-11-14T09:30:00Z',
    repository: { nameWithOwner: REPO },
    author: { login: 'alice' },
    comments: { totalCount: 0 },
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    additions: 3,
    deletions: 1,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  };
}

/** The Inbox payload: these PRs requested of the person, nothing else. */
function writeInbox(file: string, direct: number[]): void {
  const none = { nodes: [] };
  fs.writeFileSync(
    file,
    JSON.stringify({
      data: {
        direct: { nodes: direct.map(requestedPull) },
        team: none,
        authored: none,
        assigned: none,
        involved: none,
      },
    }),
  );
}

interface SourcesOptions {
  /** Launch environment for this test, over the fixtures' own, or a function of the temp base. */
  env?: Record<string, string> | ((made: { base: string }) => Record<string, string>);
  /** What `STUB_CLAUDE_HANDOVER` holds. Default `HANDOVER`. */
  handover?: string;
}

interface Sources {
  app: ElectronApplication;
  page: Page;
  base: string;
  /** The `catalog-portal` clone, the workspace's one scope. */
  clone: string;
  worktreesDir: string;
  /** #51's automation checkout: where its steps run. */
  checkoutDir: string;
  factoryDir: string;
  workspaceId: string;
  /** #51's first head: the tip of `pr-51`, one commit ahead of `main`. */
  head: string;
  files: {
    inbox: string;
    claudeLog: string;
    ghLog: string;
    ghPosted: string;
    outputs: string;
    handover: string;
    poll: string;
    prHead: string;
  };
  /** Every line the stub `claude` logged: launches, `READ …`, `TOOL …` and `END …`. */
  claudeLog(): string[];
  /** Only the launches: `<cwd> :: <argv>`. */
  launches(): string[];
  /** Every `gh` call: its argv, then the `GH_TOKEN` it saw. */
  ghLog(): string[];
  /** Every review the stub `gh` finished posting: its argv, then `BODY=` the body file's text. */
  posted(): string[];
  /** What the check command finds next: the poll file, as the template's `--jq` would print it. */
  poll(items: PolledPull[]): void;
  /** #51 at `head` in the poll file, under its title. */
  poll51(head: string): void;
  /** One more commit on #51 (the clone's `pr-51`), made #51's head for `pr checkout`; its SHA. */
  pushTo51(): string;
  writeInbox(direct: number[]): void;
  close(): Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, its default harness the stub `claude` with its own config dir, and
 * held in this window. The clone's origin is #51's repository, `pr-51` is one
 * commit ahead of `main`, and the poll file names #51 at that head. The Inbox
 * starts empty.
 */
async function setUpSources(options: SourcesOptions = {}): Promise<Sources> {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automation-sources-')),
  );
  let app: ElectronApplication | undefined;
  const close = async () => {
    try {
      await app?.close();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
  // A setup that fails part-way still closes the app and removes what it made.
  try {
    const clone = path.join(base, 'catalog-portal');
    execFileSync('git', ['init', '-q', '-b', 'main', clone]);
    fs.mkdirSync(path.join(clone, 'src'));
    fs.writeFileSync(path.join(clone, 'src', 'catalog.ts'), 'export const catalog = [];\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'init');
    // Never contacted: the stub gh checks #51 out from this clone's own objects.
    git(clone, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
    git(clone, 'checkout', '-q', '-b', 'pr-51');
    fs.writeFileSync(
      path.join(clone, 'src', 'search.ts'),
      'export const search = (q: string) => q;\n',
    );
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'Add catalog search');
    const head = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'checkout', '-q', 'main');

    const worktreesDir = path.join(base, 'worktrees');
    fs.mkdirSync(worktreesDir);
    const factoryDir = path.join(base, 'factories');
    fs.mkdirSync(factoryDir);
    const configDir = path.join(base, 'claude-config');
    fs.mkdirSync(configDir);
    const files = {
      inbox: path.join(base, 'inbox.json'),
      claudeLog: path.join(base, 'claude.log'),
      ghLog: path.join(base, 'gh.log'),
      ghPosted: path.join(base, 'gh-posted.log'),
      outputs: path.join(base, 'outputs.json'),
      handover: path.join(base, 'handover.md'),
      poll: path.join(base, 'poll.json'),
      prHead: path.join(base, 'pr-51-head'),
    };
    writeInbox(files.inbox, []);
    fs.writeFileSync(files.outputs, JSON.stringify({ verdict: 'request-changes' }));
    fs.writeFileSync(files.handover, options.handover ?? HANDOVER);
    const poll = (items: PolledPull[]) => fs.writeFileSync(files.poll, JSON.stringify(items));
    const poll51 = (sha: string) => poll([{ url: PR_URL, title: PR_TITLE, head: sha }]);
    poll51(head);
    fs.writeFileSync(files.prHead, `${head}\n`);
    let pushes = 0;
    // A push, made with plumbing so no working tree (the scope's included) is touched.
    const pushTo51 = () => {
      pushes += 1;
      const parent = git(clone, 'rev-parse', 'pr-51');
      const blob = gitWithInput(clone, `push ${pushes}\n`, 'hash-object', '-w', '--stdin');
      const entries = git(clone, 'ls-tree', parent)
        .split('\n')
        .filter((entry) => !entry.endsWith('\tpushes.txt'));
      entries.push(`100644 blob ${blob}\tpushes.txt`);
      const tree = gitWithInput(clone, `${entries.join('\n')}\n`, 'mktree');
      const commit = git(clone, 'commit-tree', tree, '-p', parent, '-m', `Push ${pushes}`);
      git(clone, 'update-ref', 'refs/heads/pr-51', commit, parent);
      fs.writeFileSync(files.prHead, `${commit}\n`);
      return commit;
    };
    const binaryPath = writeStubClaude(base);

    const env: Record<string, string> = {
      // The stub first on the app's own PATH too: should the login probe fail,
      // its fallback is this environment, and commands still find the stub,
      // never a real gh.
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      GRAPHQL_INBOX_FIXTURE: files.inbox,
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_DIR: factoryDir,
      CONSOLA_AUTOMATIONS_TICK_MS: String(TICK_MS),
      SHELL: path.join(FIXTURES, 'login-shell.sh'),
      STUB_LOGIN_PATH: STUB_GH_DIR,
      STUB_GH_PR_HEAD: head,
      STUB_GH_PR_HEAD_FILE: files.prHead,
      STUB_GH_POLL_FILE: files.poll,
      STUB_GH_LOG: files.ghLog,
      STUB_GH_POSTED: files.ghPosted,
      STUB_CLAUDE_LOG: files.claudeLog,
      STUB_CLAUDE_OUTPUTS: files.outputs,
      STUB_CLAUDE_HANDOVER: files.handover,
      STUB_CLAUDE_READS: 'previous.review.handover',
      ...(typeof options.env === 'function' ? options.env({ base }) : (options.env ?? {})),
    };
    const userDataDir = path.join(base, 'profile');
    const launched = await launchElectron({ userDataDir, env });
    app = launched.app;
    const { page } = launched;
    const workspaceId = await page.evaluate(
      async ([folder, binary, harnessConfigDir]) => {
        await window.harnessStateAPI.addHarness({
          id: 'stub',
          driverId: 'claude',
          name: 'Stub',
          accentColor: '#555555',
          binaryPath: binary,
          configDir: harnessConfigDir,
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Sprocket',
          folder,
          true,
          'stub',
        );
        // The first scope takes the workspace's name; entries name it by the repo's.
        await window.workspaceAPI.updateScope(workspace.id, workspace.scopes[0].id, {
          name: 'catalog-portal',
        });
        await window.workspaceAPI.setProviderBinding(workspace.id, {
          id: 'github',
          accountLogin: 'JaviDev',
        });
        return workspace.id;
      },
      [clone, binaryPath, configDir] as const,
    );
    const railButton = page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Sprocket', exact: true });
    await railButton.click();
    await expect(railButton).toHaveAttribute('aria-current', 'true');

    const sources: Sources = {
      app,
      page,
      base,
      clone,
      worktreesDir,
      checkoutDir: path.join(worktreesDir, 'catalog-portal-pr-51-automation'),
      factoryDir,
      workspaceId,
      head,
      files,
      claudeLog: () => lines(files.claudeLog),
      launches: () => lines(files.claudeLog).filter((line) => line.includes(' :: ')),
      ghLog: () => lines(files.ghLog),
      posted: () => lines(files.ghPosted),
      poll,
      poll51,
      pushTo51,
      writeInbox: (direct) => writeInbox(files.inbox, direct),
      close,
    };
    return sources;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** The Automations dashboard. */
function dashboardOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Automations', exact: true });
}

/** Open the dashboard from the sidebar row. */
async function openAutomations(page: Page): Promise<Locator> {
  await page
    .locator('.home-navigation')
    .getByRole('button', { name: /^Automations/ })
    .click();
  const dashboard = dashboardOf(page);
  await expect(dashboard.getByRole('heading', { name: 'Automations · Sprocket' })).toBeVisible();
  return dashboard;
}

/** The side panel, over the dashboard. */
function sidePanel(page: Page): Locator {
  return page.locator('.automations-side-panel');
}

/** Close the side panel when one is open: it lies over the dashboard's rows. */
async function closePanel(page: Page): Promise<void> {
  const panel = sidePanel(page);
  if ((await panel.count()) === 0) return;
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

/** An automation's row in the Automations tab. */
function rowOf(page: Page, name: string): Locator {
  return dashboardOf(page).locator('.automations-row', { hasText: name });
}

/** A template's Add, from the Templates tab: written to factory.yml, listed once main has loaded it. */
async function addTemplate(sources: Sources, title: string, name: string): Promise<void> {
  const dashboard = dashboardOf(sources.page);
  await dashboard.getByRole('tab', { name: 'Templates' }).click();
  await dashboard
    .locator('.automations-template', { hasText: title })
    .getByRole('button', { name: 'Add', exact: true })
    .click();
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  await expect(rowOf(sources.page, name)).toHaveCount(1, { timeout: 15_000 });
}

/** An automation's page, opened from its row into the side panel. */
async function openAutomation(sources: Sources, name: string): Promise<Locator> {
  await closePanel(sources.page);
  const dashboard = dashboardOf(sources.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  await rowOf(sources.page, name).getByRole('button', { name, exact: true }).click();
  const panel = sidePanel(sources.page);
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  return panel;
}

/** The workspace's automations and runs, as main has them now. */
async function snapshotOf(sources: Sources) {
  return sources.page.evaluate(
    (workspaceId) => window.automationsAPI.getSnapshot(workspaceId),
    sources.workspaceId,
  );
}

/** An automation's check, as main has it now. */
async function checkOf(sources: Sources, name: string) {
  return (await snapshotOf(sources)).automations.find((automation) => automation.name === name)
    ?.check;
}

/** An automation's runs, oldest first, each one's status. */
async function runStatuses(sources: Sources, name: string): Promise<string[]> {
  return (await snapshotOf(sources)).runs
    .filter((run) => run.automationId === name)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((run) => run.status);
}

/** An automation's runs, read whole from main, oldest first. */
async function runsOf(sources: Sources, name: string): Promise<RunRecord[]> {
  const runs = await sources.page.evaluate(
    async ([workspaceId, automation]) => {
      const { runs } = await window.automationsAPI.getSnapshot(workspaceId);
      const records = await Promise.all(
        runs
          .filter((run) => run.automationId === automation)
          .map((run) => window.automationsAPI.getRun(run.id)),
      );
      return records.filter((record) => record !== null);
    },
    [sources.workspaceId, name] as const,
  );
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The check command's calls in the gh log: a `--jq` and no `url=` (which is `fresh`'s). */
function pollCalls(sources: Sources): string[] {
  return sources
    .ghLog()
    .filter(
      (line) =>
        line.startsWith('api graphql ') && line.includes(' --jq ') && !line.includes(' url='),
    );
}

/**
 * Check now on a poll's row, waiting until that check has ended: its
 * `lastAt` moves. The button only asks for the check; it does not wait for it.
 */
async function checkNow(sources: Sources, name = RE_REVIEW): Promise<void> {
  const before = (await checkOf(sources, name))?.lastAt;
  await closePanel(sources.page);
  const dashboard = dashboardOf(sources.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  await rowOf(sources.page, name).getByRole('button', { name: 'Check now' }).click();
  await expect
    .poll(async () => (await checkOf(sources, name))?.lastAt, { timeout: 15_000 })
    .not.toBe(before);
}

/**
 * Allow on the automation's page, then its first check: it records what is
 * there and fires nothing. Leaves the page open.
 */
async function allow(sources: Sources, name = RE_REVIEW): Promise<Locator> {
  const panel = await openAutomation(sources, name);
  const polls = pollCalls(sources).length;
  await panel
    .getByRole('region', { name: `Allow ${name}` })
    .getByRole('button', { name: 'Allow', exact: true })
    .click();
  await expect.poll(() => pollCalls(sources).length, { timeout: 10_000 }).toBe(polls + 1);
  await expect.poll(async () => (await checkOf(sources, name))?.lastAt).toBeTruthy();
  return panel;
}

/** The workspace's runs in Activity's list. */
function runItems(page: Page): Locator {
  return dashboardOf(page).locator('.automations-run-item');
}

/** How the stub `gh` logs `publish`'s post: the reviews endpoint, first. */
const REVIEWS_CALL = `api repos/${REPO}/pulls/51/reviews `;

/** The `READ …` lines the stub `claude` logged for the earlier review. */
function previousReads(sources: Sources): string[] {
  return sources.claudeLog().filter((line) => line.startsWith('READ previous.review.handover '));
}

/** The template added, allowed, and baselined on #51 at its first head. */
async function allowedAndBaselined(sources: Sources): Promise<void> {
  await openAutomations(sources.page);
  await addTemplate(sources, RE_REVIEW_TITLE, RE_REVIEW);
  await allow(sources);
  expect(await checkOf(sources, RE_REVIEW)).toMatchObject({ baseline: true, items: 1 });
}

/** A push to #51 that the next check finds: the new head, in the poll file. */
function pushAndPoll(sources: Sources): string {
  const sha = sources.pushTo51();
  sources.poll51(sha);
  return sha;
}

/** A push, Check now, and the one run it starts, waited on until it completes. */
async function pushAndReview(sources: Sources, runsBefore: number): Promise<string> {
  const sha = pushAndPoll(sources);
  await checkNow(sources);
  await expect
    .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
    .toEqual([...Array(runsBefore).fill('completed'), 'completed']);
  return sha;
}

test('not allowed: the template is added and nothing checks', async () => {
  test.setTimeout(120_000);
  const sources = await setUpSources();
  const { page } = sources;
  try {
    const dashboard = await openAutomations(page);
    await addTemplate(sources, RE_REVIEW_TITLE, RE_REVIEW);
    // The Automations tab's row says it waits for the person.
    await expect(rowOf(page, RE_REVIEW).locator('.automations-allow-pill')).toHaveText(
      'Needs your OK',
    );

    // Its page: why it is not checking, the command in full, and Allow.
    const panel = await openAutomation(sources, RE_REVIEW);
    const command = templateCommand();
    await expect(panel.locator('.automations-allow-banner')).toContainText('Needs your OK');
    await expect(panel.locator('.automations-allow-banner')).toContainText(NOT_CHECKING_YET);
    const card = panel.getByRole('region', { name: `Allow ${RE_REVIEW}` });
    expect(await card.locator('.automations-allow-command').textContent()).toBe(command);
    // The pipeline's trigger shows it too, in full.
    expect(await panel.locator('.automations-node-code').first().textContent()).toBe(command);
    await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeEnabled();
    // Check now is not offered before Allow.
    await expect(rowOf(page, RE_REVIEW).getByRole('button', { name: 'Check now' })).toBeDisabled();

    // Three ticks later: the check command never ran, nor anything a run would.
    await page.waitForTimeout(3 * TICK_MS + 500);
    expect(
      sources.ghLog().filter((line) => line.includes(' --jq ') || line.includes(' url=')),
    ).toEqual([]);
    expect(sources.launches()).toEqual([]);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(0);
    expect(await checkOf(sources, RE_REVIEW)).not.toHaveProperty('lastAt');
  } finally {
    await sources.close();
  }
});

test('allowed: the first check records what is there and creates no run', async () => {
  test.setTimeout(120_000);
  const sources = await setUpSources();
  const { page } = sources;
  try {
    const dashboard = await openAutomations(page);
    await addTemplate(sources, RE_REVIEW_TITLE, RE_REVIEW);
    const panel = await allow(sources);

    // One check, as the person and their bound account.
    const polls = pollCalls(sources);
    expect(polls).toHaveLength(1);
    expect(polls[0]).toMatch(/ GH_TOKEN=gho_stub_token_for_JaviDev$/);
    // What it ran is the template's command: its query and its --jq, word for word.
    const quoted = flatten(templateCommand()).split("'");
    expect(polls[0]).toContain(`api graphql -f query=${quoted[1]} --jq ${quoted[3]} GH_TOKEN=`);

    // The page now says what it watches, and the command is still in full on it.
    await expect(panel.locator('.automations-allow-banner')).toHaveCount(0);
    await expect(panel.locator('.automations-lead-meta', { hasText: 'Watching' })).toHaveText(
      WATCHING_ONE,
    );
    expect(await panel.locator('.automations-node-code').first().textContent()).toBe(
      templateCommand(),
    );
    await expect(rowOf(page, RE_REVIEW).locator('.automations-allow-pill')).toHaveCount(0);

    // What was there fires nothing, and the next check is 30 minutes away.
    await page.waitForTimeout(2 * TICK_MS + 500);
    expect(pollCalls(sources)).toHaveLength(1);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(0);
    expect(await runStatuses(sources, RE_REVIEW)).toEqual([]);
    expect(sources.launches()).toEqual([]);
  } finally {
    await sources.close();
  }
});

test('a push creates one run, told there is no earlier one, posted at the new head', async () => {
  test.setTimeout(180_000);
  const sources = await setUpSources();
  const { page } = sources;
  try {
    await allowedAndBaselined(sources);
    const sha = await pushAndReview(sources, 0);
    expect(sha).not.toBe(sources.head);

    // Activity lists the one run, completed.
    const dashboard = dashboardOf(page);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(1);
    await expect(runItems(page)).toContainText('Completed');

    // Its review was told there is no earlier run, by Consola's tool.
    expect(previousReads(sources)).toEqual([
      `READ previous.review.handover ERROR ${NO_EARLIER_RUN}`,
    ]);

    // It reviewed the new head, in the automation checkout, and posted there.
    const checkoutHead = git(sources.checkoutDir, 'rev-parse', 'HEAD');
    expect(checkoutHead).toBe(sha);
    const posted = sources.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0].startsWith(REVIEWS_CALL)).toBe(true);
    expect(posted[0]).toContain(`-f commit_id=${checkoutHead} -f event=REQUEST_CHANGES -F body=@`);
    expect(posted[0].slice(posted[0].indexOf(' BODY=') + ' BODY='.length)).toBe(flatten(HANDOVER));

    // The run was found by its check, on #51 at that head.
    const [run] = await runsOf(sources, RE_REVIEW);
    expect(run.trigger).toMatchObject({ kind: 'poll' });
    expect(run.trigger.item).toMatchObject({ url: PR_URL, title: PR_TITLE });
    expect(run.checkout).toMatchObject({ cwd: sources.checkoutDir, head: sha });
    expect(run.previous).toBeUndefined();
  } finally {
    await sources.close();
  }
});

test('a second push reads the first review', async () => {
  test.setTimeout(240_000);
  const sources = await setUpSources();
  const { page } = sources;
  try {
    await allowedAndBaselined(sources);
    const first = await pushAndReview(sources, 0);
    // The second review writes other words, so what it read is known to be the first's.
    fs.writeFileSync(sources.files.handover, SECOND_HANDOVER);
    const second = await pushAndReview(sources, 1);
    expect(second).not.toBe(first);

    // The second run's review read the first run's handover, fenced as material.
    const reads = previousReads(sources);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(`READ previous.review.handover ERROR ${NO_EARLIER_RUN}`);
    expect(reads[1]).not.toContain(' ERROR ');
    expect(reads[1]).toContain('Material from step "review" (handover)');
    expect(reads[1]).toContain(`<material> ${flatten(HANDOVER)} </material>`);
    expect(reads[1]).not.toContain('Second review');

    // Two posts, one per head, each with its own run's review.
    const posted = sources.posted();
    expect(posted).toHaveLength(2);
    expect(posted[0]).toContain(`-f commit_id=${first} `);
    expect(posted[1]).toContain(`-f commit_id=${second} `);
    expect(posted[1].slice(posted[1].indexOf(' BODY=') + ' BODY='.length)).toBe(
      flatten(SECOND_HANDOVER),
    );

    // The second run names the first as its earlier run on this item.
    const [one, two] = await runsOf(sources, RE_REVIEW);
    expect(one.previous).toBeUndefined();
    expect(two.previous).toMatchObject({ runId: one.id });

    // Its page links there; the first run's page has no such link.
    const dashboard = dashboardOf(page);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(2);
    const panel = sidePanel(page);
    // A steps run's page lists its steps as a trace (#62).
    const stages = panel.getByRole('list', { name: 'Steps of this run' });
    const earlier = panel.getByRole('button', { name: 'Earlier run on this item' });
    // Whichever order Activity lists them in: the one with the link is the second.
    for (const index of [0, 1]) {
      await closePanel(page);
      await runItems(page).nth(index).click();
      await expect(stages).toBeVisible();
      if ((await earlier.count()) > 0) break;
    }
    await expect(earlier).toHaveCount(1);
    await earlier.click();
    // The first run's page, which has no earlier run to link to.
    await expect(earlier).toHaveCount(0);
    await expect(stages).toBeVisible();
  } finally {
    await sources.close();
  }
});

const ASSIGNED_REVIEWS = 'review-assigned-prs';
const ASSIGNED_REVIEWS_TITLE = 'Review pull requests assigned to you';

/** The words a run's summary and Activity give a run queued behind another on its item. */
const CHECKOUT_WAIT = "waiting for this item's checkout";

/** A pull request in a repository no scope of the workspace holds. */
const NOT_CLONED_URL = 'https://github.com/sprocket/inventory/pull/7';

/** `publish`'s calls to #51's reviews endpoint in the gh log: one per post begun, logged before it sleeps. */
function reviewCalls(sources: Sources): string[] {
  return sources.ghLog().filter((line) => line.startsWith(REVIEWS_CALL));
}

/** The workspace's factory.yml holding exactly these entries. */
function writeFactory(sources: Sources, ...entries: string[]): void {
  const dir = path.join(sources.factoryDir, sources.workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'factory.yml'),
    `version: 1\nautomations:\n${entries.map((entry) => entry.replace(/^/gm, '  ')).join('\n')}\n`,
  );
}

/**
 * Check now, asked of main the way the button asks it. The button is
 * disabled while a run of the automation works (`RunNowButton`), so this is
 * how a test checks then; it waits until that check has ended.
 */
async function checkNowFromMain(sources: Sources, name = RE_REVIEW): Promise<void> {
  const before = (await checkOf(sources, name))?.lastAt;
  await sources.page.evaluate(
    async ([workspaceId, automation]) => {
      await window.automationsAPI.runNow(workspaceId, automation);
    },
    [sources.workspaceId, name] as const,
  );
  await expect
    .poll(async () => (await checkOf(sources, name))?.lastAt, { timeout: 15_000 })
    .not.toBe(before);
}

/**
 * Click `target` in a sidebar row once the list has left the row where it is
 * for longer than the sidebar's shift guard holds a row it moved
 * (`MOVED_ROW_PRESS_MS`): a press on a row that just moved, or just arrived,
 * is dropped by design, so a click cannot land on a row that slid under it.
 * Playwright's own "stable" is two frames, too short for that rule.
 */
async function clickWhenRowSettles(row: Locator, target: Locator): Promise<void> {
  let last = '';
  let since = Date.now();
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await row.boundingBox());
        if (box !== last) {
          last = box;
          since = Date.now();
        }
        return Date.now() - since;
      },
      { intervals: [100], timeout: 15_000 },
    )
    .toBeGreaterThan(MOVED_ROW_PRESS_MS + 100);
  await target.click();
}

/** The one run waiting for approval, approved from the dashboard: Review…, then Start. */
async function approveWaiting(sources: Sources): Promise<void> {
  await closePanel(sources.page);
  const dashboard = dashboardOf(sources.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const waiting = dashboard.locator('.automations-waiting-card');
  await expect(waiting).toHaveCount(1, { timeout: 30_000 });
  await waiting.getByRole('button', { name: 'Review…' }).click();
  await sidePanel(sources.page)
    .getByRole('region', { name: 'Waiting for your approval' })
    .getByRole('button', { name: 'Start', exact: true })
    .click();
}

test('a push during a run is held, then runs once', async () => {
  test.setTimeout(240_000);
  // `publish` sleeps, so the run is still working when the next push is checked.
  const sources = await setUpSources({ env: { STUB_GH_SLEEP: '8' } });
  const { page } = sources;
  try {
    await allowedAndBaselined(sources);
    const first = pushAndPoll(sources);
    await checkNow(sources);
    // Its publish has begun and is sleeping: the run is working.
    await expect.poll(() => reviewCalls(sources).length, { timeout: 60_000 }).toBe(1);
    expect(sources.posted()).toEqual([]);
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['running']);

    // A push while it works: the check finds #51 changed, and holds it.
    const second = pushAndPoll(sources);
    await checkNowFromMain(sources);
    expect(await checkOf(sources, RE_REVIEW)).toMatchObject({ items: 1, fired: 0 });
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['running']);
    const dashboard = dashboardOf(page);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(1);

    // The first run ends, having posted at the head it checked out.
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
      .toEqual(['completed']);
    expect(sources.posted()).toHaveLength(1);
    expect(sources.posted()[0]).toContain(`-f commit_id=${first} `);
    // Ending fired nothing by itself.
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['completed']);

    // The check after it ends: exactly one more run, at the newest head.
    await checkNow(sources);
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
      .toEqual(['completed', 'completed']);
    expect(sources.posted()).toHaveLength(2);
    expect(sources.posted()[1]).toContain(`-f commit_id=${second} `);
    const [, rerun] = await runsOf(sources, RE_REVIEW);
    expect(rerun.trigger).toMatchObject({ kind: 'poll' });
    expect(rerun.checkout).toMatchObject({ head: second });

    // And the check after that has nothing new.
    await checkNow(sources);
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['completed', 'completed']);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(2);
  } finally {
    await sources.close();
  }
});

test('a push while a run waits for approval is absorbed', async () => {
  test.setTimeout(240_000);
  const sources = await setUpSources();
  const { page } = sources;
  try {
    await openAutomations(page);
    // The template as a file entry that asks before each run.
    const confirm = reReviewEntry().replace('\n  mode: auto\n', '\n  mode: confirm\n');
    expect(confirm).not.toBe(reReviewEntry());
    writeFactory(sources, confirm);
    await expect(rowOf(page, RE_REVIEW)).toHaveCount(1, { timeout: 15_000 });
    await expect(rowOf(page, RE_REVIEW).locator('.automations-allow-pill')).toHaveText(
      'Needs your OK',
    );
    await allow(sources);
    expect(await checkOf(sources, RE_REVIEW)).toMatchObject({ baseline: true, items: 1 });

    // A push: one run, waiting for the person.
    pushAndPoll(sources);
    await checkNow(sources);
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 15_000 })
      .toEqual(['needs-approval']);

    // Another push while it waits: absorbed into that run, no second one.
    const newest = pushAndPoll(sources);
    await checkNow(sources);
    expect(await checkOf(sources, RE_REVIEW)).toMatchObject({ items: 1, fired: 0 });
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['needs-approval']);
    expect(sources.launches()).toEqual([]);

    // Approved, it reviews the newest head.
    await approveWaiting(sources);
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
      .toEqual(['completed']);
    const posted = sources.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`-f commit_id=${newest} `);
    const [run] = await runsOf(sources, RE_REVIEW);
    expect(run.checkout).toMatchObject({ head: newest });

    // The next check finds nothing new: the newest head was this run's.
    await checkNow(sources);
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['completed']);
    expect(sources.posted()).toHaveLength(1);
  } finally {
    await sources.close();
  }
});

test('both templates on one pull request post once', async () => {
  test.setTimeout(240_000);
  const sources = await setUpSources({
    env: {
      // `fresh` asks what the account last reviewed: whatever was posted.
      STUB_GH_REVIEWED_FROM_POSTED: '1',
      // The first run is still posting when the second is created.
      STUB_GH_SLEEP: '8',
    },
  });
  const { page } = sources;
  try {
    // (a) Both templates; the event one baselines on an empty Inbox.
    const dashboard = await openAutomations(page);
    await addTemplate(sources, ASSIGNED_REVIEWS_TITLE, ASSIGNED_REVIEWS);
    await addTemplate(sources, RE_REVIEW_TITLE, RE_REVIEW);
    const inboxCheck = rowOf(page, ASSIGNED_REVIEWS).getByRole('button', { name: 'Check now' });
    await inboxCheck.click();
    await expect(inboxCheck).toBeEnabled();

    // (b) The poll baselines on #51 at its first head.
    await allow(sources);
    expect(await checkOf(sources, RE_REVIEW)).toMatchObject({ baseline: true, items: 1 });

    // (c) The author pushes and re-requests the review: #51 is new to both.
    const pushed = pushAndPoll(sources);
    sources.writeInbox([51]);

    // (d) The Inbox's run asks once, and is approved; then the poll's check.
    await closePanel(page);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await inboxCheck.click();
    await expect(inboxCheck).toBeEnabled();
    await expect
      .poll(() => runStatuses(sources, ASSIGNED_REVIEWS), { timeout: 30_000 })
      .toEqual(['needs-approval']);
    await approveWaiting(sources);
    await expect.poll(() => reviewCalls(sources).length, { timeout: 60_000 }).toBe(1);
    expect(await runStatuses(sources, ASSIGNED_REVIEWS)).toEqual(['running']);
    await checkNow(sources);

    // Two runs on #51; the second waits for the item's checkout while the first works.
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 15_000 })
      .toEqual(['queued']);
    const [waiting] = await runsOf(sources, RE_REVIEW);
    expect(waiting.trigger.item).toMatchObject({ url: PR_URL });
    await expect
      .poll(async () => (await runsOf(sources, RE_REVIEW))[0].summary)
      .toBe(CHECKOUT_WAIT);
    await closePanel(page);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(2);
    await expect(runItems(page).filter({ hasText: CHECKOUT_WAIT })).toHaveCount(1);

    // The first posts at the pushed head; the second then finds it reviewed and posts nothing.
    await expect
      .poll(() => runStatuses(sources, ASSIGNED_REVIEWS), { timeout: 60_000 })
      .toEqual(['completed']);
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
      .toEqual(['completed']);
    const [second] = await runsOf(sources, RE_REVIEW);
    expect(second.checkout).toMatchObject({ head: pushed });
    expect(Object.fromEntries((second.steps ?? []).map((step) => [step.id, step.status]))).toEqual({
      fresh: 'completed',
      review: 'skipped',
      publish: 'skipped',
    });
    const posted = sources.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`-f commit_id=${pushed} `);
    expect(reviewCalls(sources)).toHaveLength(1);
  } finally {
    await sources.close();
  }
});

test('a repository that is not cloned fires nothing', async () => {
  test.setTimeout(120_000);
  const sources = await setUpSources();
  try {
    await allowedAndBaselined(sources);
    // #51 as it was, and a pull request whose repository no scope holds.
    sources.poll([
      { url: PR_URL, title: PR_TITLE, head: sources.head },
      { url: NOT_CLONED_URL, title: 'Track stock levels', head: 'f00d' },
    ]);
    await checkNow(sources);
    expect(await checkOf(sources, RE_REVIEW)).toMatchObject({ fired: 0, skipped: 1 });
    expect(await runStatuses(sources, RE_REVIEW)).toEqual([]);
    const panel = await openAutomation(sources, RE_REVIEW);
    await expect(panel.locator('.automations-lead-meta', { hasText: 'skipped' })).toContainText(
      '1 skipped: their repositories are not in this workspace',
    );
    // Run on… lists it, but disabled, saying why; #51 can still be picked.
    await panel.getByRole('button', { name: 'Run on…' }).click();
    const picker = sources.page.getByRole('dialog', { name: 'Run on an item' });
    const inCheck = picker.getByRole('region', { name: 'In its last check' });
    const uncloned = inCheck.getByRole('button', { name: /sprocket\/inventory#7/ });
    await expect(uncloned).toBeDisabled();
    await expect(uncloned).toContainText('sprocket/inventory is not cloned in this workspace.');
    await expect(inCheck.getByRole('button', { name: /#51/ })).toBeEnabled();
    await sources.page.keyboard.press('Escape');
    // Nothing tried to check it out or review it.
    expect(sources.launches()).toEqual([]);
    expect(sources.ghLog().filter((line) => line.startsWith('pr checkout'))).toEqual([]);
    expect(await runStatuses(sources, RE_REVIEW)).toEqual([]);
  } finally {
    await sources.close();
  }
});

test('Run on… runs a chosen pull request, and the next check does not run it again', async () => {
  test.setTimeout(180_000);
  const sources = await setUpSources();
  const { page } = sources;
  try {
    await allowedAndBaselined(sources);
    // Already waiting for a re-review before it was allowed: nothing ran for it.
    expect(await runStatuses(sources, RE_REVIEW)).toEqual([]);
    // A push no check has seen yet: the run reads it, so the mark must be at it.
    const pushed = pushAndPoll(sources);
    const polls = pollCalls(sources).length;

    const panel = await openAutomation(sources, RE_REVIEW);
    await panel.getByRole('button', { name: 'Run on…' }).click();
    const picker = page.getByRole('dialog', { name: 'Run on an item' });
    const inCheck = picker.getByRole('region', { name: 'In its last check' });
    const row = inCheck.getByRole('button', { name: /#51/ });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('never run');
    await row.click();

    // A run on #51 starts, opens in the panel, and completes.
    await expect(picker).toHaveCount(0);
    await expect(sidePanel(page).getByRole('list', { name: 'Steps of this run' })).toBeVisible();
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
      .toEqual(['completed']);
    // Run on… checked first, and the run read what that check found: the pushed head.
    expect(pollCalls(sources)).toHaveLength(polls + 1);
    const [run] = await runsOf(sources, RE_REVIEW);
    expect(run.trigger).toMatchObject({ kind: 'manual', by: 'person' });
    expect(run.trigger.item).toMatchObject({ url: PR_URL });
    expect(run.checkout).toMatchObject({ head: pushed });
    expect(sources.posted()).toHaveLength(1);
    expect(sources.posted()[0]).toContain(`-f commit_id=${pushed} `);

    // The next check, at that head: it was run, so nothing new.
    await checkNow(sources);
    expect(await checkOf(sources, RE_REVIEW)).toMatchObject({ items: 1, fired: 0 });
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['completed']);
    expect(sources.posted()).toHaveLength(1);

    // A later push runs it again.
    pushAndPoll(sources);
    await checkNow(sources);
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
      .toEqual(['completed', 'completed']);
  } finally {
    await sources.close();
  }
});

test('an agent saves a poll entry and asks for a run; approving runs that run and no check', async () => {
  test.setTimeout(180_000);
  const sources = await setUpSources({
    env: ({ base }) => ({ STUB_CLAUDE_CALLS: path.join(base, 'claude-calls.json') }),
  });
  const { page } = sources;
  try {
    // What the agent in the session will do: save the template's entry, then ask for a run on #51.
    fs.writeFileSync(
      path.join(sources.base, 'claude-calls.json'),
      JSON.stringify([
        ['consola_save_automation', { entry: reReviewEntry() }],
        [
          'consola_run_automation',
          { name: RE_REVIEW, work_item: { repo: REPO, number: 51, type: 'pr' } },
        ],
      ]),
    );
    // An ordinary session, made as a window makes one: full tools, in the scope's folder.
    const sessionName = 'Set up re-reviews';
    const created = await page.evaluate(
      async ([workspaceId, cwd, name]) => {
        const { workspaces } = await window.workspaceAPI.getSnapshot();
        const scopeId = workspaces.find((workspace) => workspace.id === workspaceId)!.scopes[0].id;
        return window.workspaceAPI.createSession(workspaceId, {
          name,
          workspaceId,
          instanceId: 'agent-sets-up-re-reviews',
          harnessId: 'stub',
          scopeId,
          cwd,
        });
      },
      [sources.workspaceId, sources.clone, sessionName] as const,
    );
    if (!created) throw new Error('The session was not created.');
    expect(created.toolPolicy).toBeUndefined();
    // Just arrived in the sidebar, so it takes a press only once it stays put.
    const sessionRow = page.locator('.session-nav-item', { hasText: sessionName });
    await clickWhenRowSettles(sessionRow, sessionRow);

    // Its agent made both calls: the entry saved, waiting for Allow; the run asked for, waiting.
    const toolLines = () => sources.claudeLog().filter((line) => line.startsWith('TOOL '));
    await expect.poll(() => toolLines().length, { timeout: 30_000 }).toBe(2);
    // Each answer is the tool's JSON, on one line.
    const answer = (line: string, tool: string) => {
      expect(line.startsWith(`TOOL ${tool} {`)).toBe(true);
      return JSON.parse(line.slice(`TOOL ${tool} `.length));
    };
    expect(answer(toolLines()[0], 'consola_save_automation')).toMatchObject({
      name: RE_REVIEW,
      needsAllow: true,
      summary: `Added ${RE_REVIEW} in factory.yml. It does not check until the person allows it in Consola.`,
    });
    const ran = answer(toolLines()[1], 'consola_run_automation');
    expect(ran).toMatchObject({ status: 'needs-approval' });
    expect(await runStatuses(sources, RE_REVIEW)).toEqual(['needs-approval']);
    const [asked] = await runsOf(sources, RE_REVIEW);
    expect(asked.trigger).toMatchObject({ kind: 'manual', by: 'agent' });
    expect(asked.trigger.item).toMatchObject({ url: PR_URL });

    // It waits where a run waits for the person: the sidebar's queue and the Automations page.
    const queued = page.locator('.run-nav-item', { hasText: RE_REVIEW });
    await expect(queued).toHaveCount(1);
    const dashboard = await openAutomations(page);
    await expect(dashboard.locator('.automations-waiting-card')).toContainText(RE_REVIEW);
    await expect(rowOf(page, RE_REVIEW).locator('.automations-allow-pill')).toHaveText(
      'Needs your OK',
    );

    // Approved from its sidebar row's run page, it runs.
    await clickWhenRowSettles(
      queued,
      queued.getByRole('button', { name: /waiting for your approval/ }),
    );
    await sidePanel(page)
      .getByRole('region', { name: 'Waiting for your approval' })
      .getByRole('button', { name: 'Start', exact: true })
      .click();
    await expect
      .poll(() => runStatuses(sources, RE_REVIEW), { timeout: 60_000 })
      .toEqual(['completed']);
    expect(sources.posted()).toHaveLength(1);
    expect(sources.posted()[0]).toContain(`-f commit_id=${sources.head} `);

    // Approving that run allowed no check: the command never ran, and still waits for Allow.
    await page.waitForTimeout(2 * TICK_MS + 500);
    expect(pollCalls(sources)).toEqual([]);
    expect(await checkOf(sources, RE_REVIEW)).not.toHaveProperty('lastAt');
    const automation = (await snapshotOf(sources)).automations.find(
      (candidate) => candidate.name === RE_REVIEW,
    );
    expect(automation?.needsAllow).toBe(true);
    await closePanel(page);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await expect(rowOf(page, RE_REVIEW).locator('.automations-allow-pill')).toHaveText(
      'Needs your OK',
    );
  } finally {
    await sources.close();
  }
});
