import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { assignedReviewsEntry } from '@consola/automation-engine';
import { parseAutomationEntry, type RunRecord, type StepRun } from '@consola/factory-spec';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';

/**
 * Automations with steps, end to end: the shipped `review-assigned-prs`
 * template on `sprocket/catalog-portal#51`, run by the real engine against a
 * stub `claude` and the stub `gh`.
 *
 * Nothing here reaches GitHub or a model. The stub `claude`
 * (`tests/fixtures/claude-steps.cjs`) speaks MCP to Consola's real session
 * endpoint, so a step's outputs and handover arrive the way a real CLI's
 * would. The `run:` steps find the stub `gh` through the real login
 * environment: `SHELL` is a fixture login shell (`tests/fixtures/login-shell.sh`)
 * that puts the stub's folder first on `PATH`. The app's own `PATH` has it
 * first too, so a login probe that fails falls back to the stub, never to a
 * real `gh`.
 *
 * Each scenario launches its own app on its own temp base (environment knobs
 * are fixed per launch), and `close()` removes all of it, profile included.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const STUB_GH_DIR = path.join(FIXTURES, 'stub-gh');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const REPO = 'sprocket/catalog-portal';
const PR_URL = `https://github.com/${REPO}/pull/51`;
const PR_TITLE = 'Add catalog search';
/** The Inbox fixture's one date, so nothing here reads the clock. */
const UPDATED_AT = '2026-11-14T09:30:00Z';

/** What the stub agent writes as its handover unless a test says otherwise: Markdown over several lines. */
const HANDOVER = `## Review of #51

\`src/catalog.ts:1\`: the catalog is exported empty, so search has nothing to find. Seed it before merging.
`;

/** Task 26's note, word for word: the card says whose logins the commands use. */
const COMMANDS_RUN_AS_YOU = 'Its commands run as you (your logins, the bound GitHub account).';

/** The one reminder turn's prompt, as the spec fixes it, for a step that ended without its verdict. */
const REMINDER = 'You ended without: verdict (consola_set_outputs). Set it now; do nothing else.';

/** A command Consola quit on, failed after the restart: the spec's words. */
const INTERRUPTED = 'Interrupted: Consola quit while this command was running. It may or may not have finished; check, then retry.';

/** What Retry says first about such a command: the spec's words. */
const INTERRUPTED_RETRY_WARNING = 'Consola quit while this command ran; check the pull request first — it may already be posted.';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
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

/** The shipped template's steps, as the engine parses them: what the approval card must show. */
function templateSteps() {
  const parsed = parseAutomationEntry(assignedReviewsEntry());
  if (!parsed.ok) throw new Error(`The shipped template does not parse: ${JSON.stringify(parsed.issues)}`);
  const { steps } = parsed.automation;
  if (!steps) throw new Error('The shipped template has no steps.');
  return steps;
}

/** A command step's text in the shipped template. */
function templateCommand(id: string): string {
  const step = templateSteps().find((candidate) => candidate.id === id);
  if (step?.kind !== 'run') throw new Error(`The shipped template has no command step ${id}.`);
  return step.run;
}

/** One open PR in the Inbox's GraphQL shape, by alice, asking the person directly for a review. */
function requestedPull(number: number) {
  return {
    __typename: 'PullRequest',
    title: PR_TITLE,
    number,
    state: 'OPEN',
    url: `https://github.com/${REPO}/pull/${number}`,
    updatedAt: UPDATED_AT,
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

/** The Inbox payload: these PRs requested of the person, these assigned to them, nothing else. */
function writeInbox(file: string, direct: number[], assigned: number[] = []): void {
  const none = { nodes: [] };
  fs.writeFileSync(
    file,
    JSON.stringify({
      data: {
        direct: { nodes: direct.map(requestedPull) },
        team: none,
        authored: none,
        assigned: { nodes: assigned.map(requestedPull) },
        involved: none,
      },
    })
  );
}

/**
 * The stub harness's binary: `node` is not on PATH, so a shell wrapper
 * execs the test runner's own Node on the checked-in fixture.
 */
function writeStubClaude(base: string): string {
  const wrapper = path.join(base, 'claude.sh');
  fs.writeFileSync(
    wrapper,
    ['#!/bin/sh', `exec '${process.execPath}' '${path.join(FIXTURES, 'claude-steps.cjs')}' "$@"`, ''].join('\n'),
    { mode: 0o755 }
  );
  return wrapper;
}

interface StepsOptions {
  /**
   * Launch environment for this test, over the fixtures' own (`STUB_GH_REVIEWED`, `STUB_GH_SLEEP`, …),
   * or a function of what the setup made: the temp base, and #51's head.
   */
  env?: Record<string, string> | ((made: { base: string; head: string }) => Record<string, string>);
  /**
   * What `STUB_CLAUDE_OUTPUTS` holds: an object is written as JSON, a string
   * as it is (`''` is a file that holds no JSON), null writes no file.
   * Default `{ verdict: 'request-changes' }`.
   */
  outputs?: Record<string, unknown> | string | null;
  /** What `STUB_CLAUDE_HANDOVER` holds; null writes no file. Default `HANDOVER`. */
  handover?: string | null;
}

interface Steps {
  app: ElectronApplication;
  page: Page;
  base: string;
  /** The profile, under `base`; main keeps its data in `${userDataDir} Test`, also under `base`. */
  userDataDir: string;
  /** The whole launch environment, for relaunching on the same profile. */
  env: Record<string, string>;
  /** The `catalog-portal` clone, the workspace's one scope. */
  clone: string;
  worktreesDir: string;
  /** #51's automation checkout, beside the Inbox's worktree: where its steps run. */
  checkoutDir: string;
  factoryDir: string;
  workspaceId: string;
  /** The tip of `pr-51`, one commit ahead of `main`: #51's head, where `pr checkout --detach` lands. */
  head: string;
  files: {
    inbox: string;
    claudeLog: string;
    ghLog: string;
    ghPosted: string;
    outputs: string;
    handover: string;
  };
  /** Every line the stub `claude` logged: its launches, a `TOOL …` line per step tool it called, and `END …` as each turn ends. */
  claudeLog(): string[];
  /** Only the launches: `<cwd> :: <argv>`. */
  launches(): string[];
  /** Every `gh` call: its argv, then the `GH_TOKEN` it saw. */
  ghLog(): string[];
  /** Every review the stub `gh` finished posting: its argv, then `BODY=` the body file's text. */
  posted(): string[];
  writeInbox(direct: number[], assigned?: number[]): void;
  close(): Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, its default harness the stub `claude` with its own config dir, and
 * held in this window. The clone's origin is #51's repository, and `pr-51` is
 * one commit ahead of `main`. The Inbox starts empty.
 */
async function setUpSteps(options: StepsOptions = {}): Promise<Steps> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automation-steps-')));
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
    fs.writeFileSync(path.join(clone, 'src', 'search.ts'), 'export const search = (q: string) => q;\n');
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
    };
    writeInbox(files.inbox, []);
    const outputs = options.outputs === undefined ? { verdict: 'request-changes' } : options.outputs;
    if (outputs !== null) fs.writeFileSync(files.outputs, typeof outputs === 'string' ? outputs : JSON.stringify(outputs));
    const handover = options.handover === undefined ? HANDOVER : options.handover;
    if (handover !== null) fs.writeFileSync(files.handover, handover);
    const binaryPath = writeStubClaude(base);

    const env: Record<string, string> = {
      // The stub first on the app's own PATH too: should the login probe fail,
      // its fallback is this environment, and `run:` steps still find the stub,
      // never a real gh.
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      GRAPHQL_INBOX_FIXTURE: files.inbox,
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_DIR: factoryDir,
      SHELL: path.join(FIXTURES, 'login-shell.sh'),
      STUB_LOGIN_PATH: STUB_GH_DIR,
      STUB_GH_PR_HEAD: head,
      STUB_GH_LOG: files.ghLog,
      STUB_GH_POSTED: files.ghPosted,
      STUB_CLAUDE_LOG: files.claudeLog,
      STUB_CLAUDE_OUTPUTS: files.outputs,
      STUB_CLAUDE_HANDOVER: files.handover,
      ...(typeof options.env === 'function' ? options.env({ base, head }) : (options.env ?? {})),
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
        const workspace = await window.workspaceAPI.createWorkspace('Sprocket', folder, true, 'stub');
        // The first scope takes the workspace's name; entries name it by the repo's.
        await window.workspaceAPI.updateScope(workspace.id, workspace.scopes[0].id, { name: 'catalog-portal' });
        await window.workspaceAPI.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'JaviDev' });
        return workspace.id;
      },
      [clone, binaryPath, configDir] as const
    );
    const railButton = page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Sprocket', exact: true });
    await railButton.click();
    await expect(railButton).toHaveAttribute('aria-current', 'true');

    const steps: Steps = {
      app,
      page,
      base,
      userDataDir,
      env,
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
      writeInbox: (direct, assigned) => writeInbox(files.inbox, direct, assigned),
      // The current app, so a test that relaunches can hand its own back.
      close: async () => {
        app = steps.app;
        await close();
      },
    };
    return steps;
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
  await page.locator('.home-navigation').getByRole('button', { name: /^Automations/ }).click();
  const dashboard = dashboardOf(page);
  await expect(dashboard.getByRole('heading', { name: 'Automations · Sprocket' })).toBeVisible();
  return dashboard;
}

/** The side panel, over the dashboard. */
function sidePanel(page: Page): Locator {
  return page.locator('.automations-side-panel');
}

/** The banner's Add: the shipped template, written to factory.yml, listed once main has loaded it. */
async function addReviewTemplate(steps: Steps): Promise<void> {
  const dashboard = dashboardOf(steps.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const banner = dashboard.getByRole('region', { name: 'Review PRs assigned to me automatically' });
  await banner.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dashboard.locator('.automations-row', { hasText: 'review-assigned-prs' })).toHaveCount(1, { timeout: 15_000 });
  await expect(banner).toHaveCount(0);
}

/**
 * #51 asks for a review: the first check is the baseline, over an empty
 * Inbox, and the second finds #51 new. Each waits for its check to end
 * (the button reads "Checking…" until it does).
 */
async function fireOn51(steps: Steps): Promise<void> {
  const dashboard = dashboardOf(steps.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const checkNow = dashboard
    .locator('.automations-row', { hasText: 'review-assigned-prs' })
    .getByRole('button', { name: 'Check now' });
  steps.writeInbox([]);
  await checkNow.click();
  await expect(checkNow).toBeEnabled();
  steps.writeInbox([51]);
  await checkNow.click();
  await expect(checkNow).toBeEnabled();
}

/** The workspace's runs in Activity's list. */
function runItems(page: Page): Locator {
  return dashboardOf(page).locator('.automations-run-item');
}

/**
 * Open #51's run (the only one) from Activity, into the side panel. A panel
 * already open is closed first, so the run's page mounts afresh and reads
 * everything it shows again.
 */
async function openRun(steps: Steps): Promise<Locator> {
  const panel = sidePanel(steps.page);
  if ((await panel.count()) > 0) {
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toHaveCount(0);
  }
  await dashboardOf(steps.page).getByRole('tab', { name: 'Activity' }).click();
  await expect(runItems(steps.page)).toHaveCount(1);
  await runItems(steps.page).click();
  await expect(panel.getByRole('list', { name: 'Stages of this run' })).toBeVisible();
  return panel;
}

/** A step's node on the run's graph: a button named `<id>: <outcome>`. */
function stepNode(panel: Locator, id: string): Locator {
  return panel.getByRole('list', { name: 'Stages of this run' }).getByRole('button', { name: new RegExp(`^${id}: `) });
}

/** How the stub `gh` logs `publish`'s post: the reviews endpoint, first. */
const REVIEWS_CALL = `api repos/${REPO}/pulls/51/reviews `;

/** `publish`'s calls to the reviews endpoint, in `lines` (default: the whole gh log). */
function reviewCalls(steps: Steps, lines = steps.ghLog()): string[] {
  return lines.filter((line) => line.startsWith(REVIEWS_CALL));
}

/** `fresh`'s call: which commit the account last reviewed. Only the stub can log it. */
function freshCalls(steps: Steps): string[] {
  return steps.ghLog().filter((line) => line.startsWith(`api graphql -f url=${PR_URL} `));
}

/**
 * The run waiting for approval, started: it asks once, Review… opens the
 * card, Start runs it, and Activity lists it.
 */
async function startTheRun(steps: Steps): Promise<void> {
  const dashboard = dashboardOf(steps.page);
  const waiting = dashboard.locator('.automations-waiting-card');
  await expect(waiting).toHaveCount(1, { timeout: 30_000 });
  await waiting.getByRole('button', { name: 'Review…' }).click();
  const approval = sidePanel(steps.page).getByRole('region', { name: 'Waiting for your approval' });
  await approval.getByRole('button', { name: 'Start', exact: true }).click();
  await dashboard.getByRole('tab', { name: 'Activity' }).click();
  await expect(runItems(steps.page)).toHaveCount(1);
}

/** The workspace's one run, read whole from main: its status, summary and steps. */
async function theRun(steps: Steps): Promise<RunRecord> {
  const run = await steps.page.evaluate(async (workspaceId) => {
    const { runs } = await window.automationsAPI.getSnapshot(workspaceId);
    if (runs.length !== 1) throw new Error(`Expected one run, found ${runs.length}.`);
    return window.automationsAPI.getRun(runs[0].id);
  }, steps.workspaceId);
  if (!run) throw new Error('The run is gone.');
  return run;
}

/** A run's steps by id: each one's record. */
function stepsOf(run: RunRecord): Record<string, StepRun> {
  return Object.fromEntries((run.steps ?? []).map((step) => [step.id, step]));
}

/** Each step's status, by id. */
function statuses(run: RunRecord): Record<string, string> {
  return Object.fromEntries((run.steps ?? []).map((step) => [step.id, step.status]));
}

/** The conversation a launch started (`--session-id`) or resumed (`--resume`). */
function conversationOf(launch: string): string {
  const id = /(?:--session-id|--resume) ([0-9a-f-]{36}) /.exec(launch)?.[1];
  if (!id) throw new Error(`No conversation in: ${launch}`);
  return id;
}

/** The stub `gh` still posting a review for this test's run: none once Consola has stopped it. */
function stubGhStillPosting(base: string): string[] {
  return execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(`stub-gh/gh ${REVIEWS_CALL}`) && line.includes(base));
}

/** The workspace's factory.yml holding exactly this entry. */
function writeFactory(steps: Steps, entry: string): void {
  const dir = path.join(steps.factoryDir, steps.workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'factory.yml'), `version: 1\nautomations:\n${entry.replace(/^/gm, '  ')}\n`);
}

test('the template reviews #51 read-only and posts through gh, pinned to the commit it read', async () => {
  test.setTimeout(180_000);
  const steps = await setUpSteps();
  const { page } = steps;
  try {
    const dashboard = await openAutomations(page);
    await addReviewTemplate(steps);
    await fireOn51(steps);

    // A new `auto` automation asks once: its run waits, with every step it would run.
    const waiting = dashboard.locator('.automations-waiting-card');
    await expect(waiting).toHaveCount(1, { timeout: 30_000 });
    await expect(waiting).toContainText(`${REPO}#51 “${PR_TITLE}” by @alice`);
    await waiting.getByRole('button', { name: 'Review…' }).click();
    const panel = sidePanel(page);
    const approval = panel.getByRole('region', { name: 'Waiting for your approval' });
    const listed = approval.getByRole('listitem');
    const expected = templateSteps();
    expect(expected.map((step) => step.id)).toEqual(['fresh', 'review', 'publish']);
    await expect(listed).toHaveCount(expected.length);
    for (const [index, step] of expected.entries()) {
      const item = listed.nth(index);
      await expect(item.getByText(step.id, { exact: true })).toBeVisible();
      if (step.kind === 'run') {
        await expect(item.getByText('Command', { exact: true })).toBeVisible();
        // The command exactly as the file has it, as text.
        await expect(item.getByText(step.run, { exact: true })).toBeVisible();
      } else {
        await expect(item.getByText('Agent, read-only', { exact: true })).toBeVisible();
      }
    }
    await expect(approval.getByText(COMMANDS_RUN_AS_YOU, { exact: true })).toBeVisible();
    // Asking starts nothing: no command, no session, no post.
    expect(steps.launches()).toEqual([]);
    expect(steps.ghLog().filter((line) => line.startsWith('pr checkout') || line.includes(' url=') || line.includes('/reviews'))).toEqual([]);
    expect(fs.existsSync(steps.files.ghPosted)).toBe(false);

    await approval.getByRole('button', { name: 'Start', exact: true }).click();
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(page)).toHaveCount(1);
    await expect(runItems(page)).toContainText('Completed', { timeout: 60_000 });

    // The `gh` the commands found on PATH is the stub: its log has `fresh`'s call.
    // First, so no check below can pass against a run that reached a real gh.
    const fresh = steps.ghLog().filter((line) => line.startsWith(`api graphql -f url=${PR_URL} `));
    expect(fresh, "fresh's gh call is in the stub's log").toHaveLength(1);

    // The run reviewed the commit its checkout holds: #51's head, detached in its own folder.
    const checkoutHead = git(steps.checkoutDir, 'rev-parse', 'HEAD');
    expect(checkoutHead).toBe(steps.head);

    // `fresh` asked GitHub, as the bound account, which commit it last reviewed: none.
    expect(fresh[0]).toMatch(/ GH_TOKEN=gho_stub_token_for_JaviDev$/);

    // `review`: one read-only, unattended turn in the automation checkout, its step tools allowed.
    const launches = steps.launches();
    expect(launches).toHaveLength(1);
    const [review] = launches;
    expect(review.startsWith(`${steps.checkoutDir} :: -p --session-id `)).toBe(true);
    expect(review).toContain(' --restricted');
    const allowed = review.split(' --allowedTools ')[1]?.split(' --restricted')[0]?.split(' ') ?? [];
    expect(allowed).toContain('mcp__consola__consola_set_outputs');
    expect(allowed).toContain('mcp__consola__consola_write_artifact');
    // Its handover and verdict went through Consola's MCP endpoint, and were taken.
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL '))).toEqual([
      expect.stringMatching(/^TOOL consola_write_artifact Wrote handover \(/),
      'TOOL consola_set_outputs Set: verdict. Every output is set.',
    ]);

    // `publish`: one review, REQUEST_CHANGES, pinned to the checkout's head, its body the handover.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    const [post] = posted;
    expect(post.startsWith(`api repos/${REPO}/pulls/51/reviews `)).toBe(true);
    expect(post).toContain(`-f commit_id=${checkoutHead} -f event=REQUEST_CHANGES -F body=@`);
    expect(post.slice(post.indexOf(' BODY=') + ' BODY='.length)).toBe(flatten(HANDOVER));
    // Posted as the bound account.
    const publish = steps.ghLog().filter((line) => line.startsWith(`api repos/${REPO}/pulls/51/reviews `));
    expect(publish).toHaveLength(1);
    expect(publish[0]).toMatch(/ GH_TOKEN=gho_stub_token_for_JaviDev$/);

    // Opening the run, every step and the handover reads; it starts nothing.
    const counts = () => ({ claude: steps.claudeLog().length, gh: steps.ghLog().length, posted: steps.posted().length });
    const before = counts();
    const run = await openRun(steps);
    await expect(run.locator('.automations-run-status')).toHaveText('Completed');
    for (const id of ['fresh', 'review', 'publish']) {
      await expect(stepNode(run, id)).toHaveAccessibleName(new RegExp(`^${id}: Completed`));
    }

    await stepNode(run, 'fresh').click();
    const freshDetail = run.getByRole('region', { name: 'Step fresh' });
    await expect(freshDetail).toContainText('needed: true');
    await expect(freshDetail.getByText(templateCommand('fresh'), { exact: true })).toBeVisible();

    await stepNode(run, 'review').click();
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(reviewDetail).toContainText('verdict: request-changes');
    // Its transcript, read from the stub's config dir: the turn's prompt.
    await expect(reviewDetail).toContainText('From the session’s transcript.');
    await expect(reviewDetail).toContainText('Review this pull request. Read it with Consola');
    await reviewDetail.getByRole('button', { name: 'handover', exact: true }).click();
    await expect(reviewDetail.getByText('material from the run', { exact: true })).toBeVisible();
    await expect(reviewDetail).toContainText('the catalog is exported empty, so search has nothing to find.');

    await stepNode(run, 'publish').click();
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    await expect(publishDetail).toContainText('VERDICT = {{steps.review.verdict}} → request-changes');
    await expect(publishDetail).toContainText(`REPO = {{item.repo}} → ${REPO}`);
    await expect(publishDetail).toContainText('NUMBER = {{item.number}} → 51');
    await expect(publishDetail).toContainText('{"id":1}');

    expect(counts()).toEqual(before);
  } finally {
    await steps.close();
  }
});

test('an approve verdict is posted as a comment', async () => {
  test.setTimeout(180_000);
  const steps = await setUpSteps({ outputs: { verdict: 'approve' } });
  try {
    await openAutomations(steps.page);
    await addReviewTemplate(steps);
    await fireOn51(steps);
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 60_000 });
    expect(freshCalls(steps), "fresh's gh call is in the stub's log").toHaveLength(1);

    const run = await theRun(steps);
    expect(statuses(run)).toEqual({ fresh: 'completed', review: 'completed', publish: 'completed' });
    expect(stepsOf(run).review.outputs).toEqual({ verdict: 'approve' });
    expect(run.summary).toBe('fresh → review → publish (approve)');

    // A shipped review never approves: `approve` is posted as a comment, once, pinned to the checkout's head.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0].startsWith(REVIEWS_CALL)).toBe(true);
    expect(posted[0]).toContain(`-f commit_id=${git(steps.checkoutDir, 'rev-parse', 'HEAD')} -f event=COMMENT -F body=@`);
    expect(posted[0].slice(posted[0].indexOf(' BODY=') + ' BODY='.length)).toBe(flatten(HANDOVER));
    expect(reviewCalls(steps)).toHaveLength(1);
  } finally {
    await steps.close();
  }
});

test('a commit already reviewed is skipped', async () => {
  test.setTimeout(180_000);
  // The account's latest review is on #51's head: the commit the run checks out.
  const steps = await setUpSteps({ env: ({ head }) => ({ STUB_GH_REVIEWED: head }) });
  try {
    await openAutomations(steps.page);
    await addReviewTemplate(steps);
    await fireOn51(steps);
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 60_000 });
    expect(freshCalls(steps), "fresh's gh call is in the stub's log").toHaveLength(1);

    const record = await theRun(steps);
    expect(record.status).toBe('completed');
    expect(record.summary).toBe('fresh; review and publish skipped');
    expect(statuses(record)).toEqual({ fresh: 'completed', review: 'skipped', publish: 'skipped' });
    expect(stepsOf(record).fresh.outputs).toEqual({ needed: false });

    const run = await openRun(steps);
    await expect(run.locator('.automations-run-status')).toHaveText('Completed');
    await expect(stepNode(run, 'fresh')).toHaveAccessibleName(/^fresh: Completed/);
    await expect(stepNode(run, 'review')).toHaveAccessibleName('review: Skipped');
    await expect(stepNode(run, 'publish')).toHaveAccessibleName('publish: Skipped');

    await stepNode(run, 'fresh').click();
    await expect(run.getByRole('region', { name: 'Step fresh' })).toContainText('needed: false');
    await stepNode(run, 'review').click();
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(reviewDetail).toContainText('Agent step · skipped');
    await expect(reviewDetail.getByText('if: steps.fresh.needed is false', { exact: true })).toBeVisible();
    await stepNode(run, 'publish').click();
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    await expect(publishDetail).toContainText('Command · skipped · publish');
    await expect(publishDetail.getByText('if: steps.fresh.needed is false', { exact: true })).toBeVisible();

    // The run has settled: no session was launched (`-p` or any other), and nothing was posted.
    expect(steps.launches()).toEqual([]);
    expect(reviewCalls(steps)).toEqual([]);
    expect(fs.existsSync(steps.files.ghPosted)).toBe(false);
  } finally {
    await steps.close();
  }
});

test('a review that sets no outputs gets one reminder, then fails', async () => {
  test.setTimeout(180_000);
  // An empty outputs file: every turn writes the handover and sets nothing.
  const steps = await setUpSteps({ outputs: '' });
  try {
    await openAutomations(steps.page);
    await addReviewTemplate(steps);
    await fireOn51(steps);
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('failed at review', { timeout: 60_000 });

    // Two launches of one conversation: the turn, then the reminder, resumed in place.
    const launches = steps.launches();
    expect(launches).toHaveLength(2);
    const [turn, reminder] = launches;
    const id = conversationOf(turn);
    expect(turn.startsWith(`${steps.checkoutDir} :: -p --session-id ${id} `)).toBe(true);
    expect(reminder.startsWith(`${steps.checkoutDir} :: -p --resume ${id} `)).toBe(true);
    expect(reminder).toContain(' --restricted');
    expect(reminder.endsWith(` -- ${REMINDER}`)).toBe(true);
    // Each turn ended cleanly, and neither set an output.
    expect(steps.claudeLog().filter((line) => line.startsWith('END '))).toEqual([`END ${id} exit 0`, `END ${id} exit 0`]);
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL consola_set_outputs'))).toEqual([]);

    const record = await theRun(steps);
    expect(record.status).toBe('failed');
    expect(statuses(record)).toEqual({ fresh: 'completed', review: 'failed', publish: 'not-run' });
    expect(stepsOf(record).review.error).toBe('ended without setting verdict');
    expect(stepsOf(record).review.reminded).toBe(true);

    const run = await openRun(steps);
    await expect(run.locator('.automations-run-status')).toHaveText('Failed');
    await expect(stepNode(run, 'review')).toHaveAccessibleName(/^review: Failed/);
    // A step the run never reached draws as skipped, and says why on hover.
    await expect(stepNode(run, 'publish')).toHaveAccessibleName('publish: Skipped');
    await expect(stepNode(run, 'publish')).toHaveAttribute('title', 'It did not run: the run ended first.');
    // The failed step is the one the page opens on.
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(reviewDetail.getByText('ended without setting verdict', { exact: true })).toBeVisible();
    await expect(reviewDetail.getByText('Reminded once', { exact: true })).toBeVisible();
    await stepNode(run, 'publish').click();
    await expect(run.getByRole('region', { name: 'Step publish' })).toContainText('Command · not-run · publish');

    // The run has settled: nothing was posted.
    expect(reviewCalls(steps)).toEqual([]);
    expect(fs.existsSync(steps.files.ghPosted)).toBe(false);
  } finally {
    await steps.close();
  }
});

test('a review that sets its outputs on the reminder completes', async () => {
  test.setTimeout(180_000);
  // The first turn sets nothing. The reminder turn, resumed, waits at the gate
  // before it reads its knobs, so the verdict written between the two turns
  // is what it sets, however soon Consola relaunches it.
  const steps = await setUpSteps({
    outputs: '',
    env: ({ base }) => ({ STUB_CLAUDE_RESUME_GATE: path.join(base, 'resume-gate') }),
  });
  const gate = steps.env.STUB_CLAUDE_RESUME_GATE;
  try {
    await openAutomations(steps.page);
    await addReviewTemplate(steps);
    await fireOn51(steps);
    await startTheRun(steps);

    // The first turn is over, having set nothing.
    await expect.poll(() => steps.claudeLog().filter((line) => line.startsWith('END ')).length, { timeout: 60_000 }).toBe(1);
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL consola_set_outputs'))).toEqual([]);
    // Now the agent knows its verdict, and does nothing else: no second handover.
    fs.writeFileSync(steps.files.outputs, JSON.stringify({ verdict: 'request-changes' }));
    fs.rmSync(steps.files.handover);
    fs.writeFileSync(gate, '');

    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 60_000 });
    const launches = steps.launches();
    expect(launches).toHaveLength(2);
    const id = conversationOf(launches[0]);
    // The reminder reached Consola's step tools through the real endpoint, and its verdict was taken.
    expect(steps.claudeLog()).toEqual([
      launches[0],
      expect.stringMatching(/^TOOL consola_write_artifact Wrote handover \(/),
      `END ${id} exit 0`,
      launches[1],
      'GATE open',
      'TOOL consola_set_outputs Set: verdict. Every output is set.',
      `END ${id} exit 0`,
    ]);
    expect(launches[0].startsWith(`${steps.checkoutDir} :: -p --session-id ${id} `)).toBe(true);
    expect(launches[1].startsWith(`${steps.checkoutDir} :: -p --resume ${id} `)).toBe(true);
    expect(launches[1]).toContain(' --mcp-config ');
    expect(launches[1].endsWith(` -- ${REMINDER}`)).toBe(true);

    const record = await theRun(steps);
    expect(statuses(record)).toEqual({ fresh: 'completed', review: 'completed', publish: 'completed' });
    expect(stepsOf(record).review.outputs).toEqual({ verdict: 'request-changes' });
    expect(stepsOf(record).review.reminded).toBe(true);

    // Posted exactly once, with the first turn's handover.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`-f commit_id=${git(steps.checkoutDir, 'rev-parse', 'HEAD')} -f event=REQUEST_CHANGES -F body=@`);
    expect(posted[0].slice(posted[0].indexOf(' BODY=') + ' BODY='.length)).toBe(flatten(HANDOVER));
    expect(reviewCalls(steps)).toHaveLength(1);

    const run = await openRun(steps);
    await stepNode(run, 'review').click();
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(reviewDetail.getByText('Reminded once', { exact: true })).toBeVisible();
    await expect(reviewDetail).toContainText('verdict: request-changes');
  } finally {
    await steps.close();
  }
});

test('a restart mid-publish fails the run and never posts twice', async () => {
  test.setTimeout(240_000);
  // `publish`'s gh sleeps before it posts: long enough to quit inside it.
  const steps = await setUpSteps({ env: { STUB_GH_SLEEP: '30' } });
  try {
    await openAutomations(steps.page);
    await addReviewTemplate(steps);
    await fireOn51(steps);
    await startTheRun(steps);

    // `publish` is posting: its call is logged, and the stub sleeps before the post.
    await expect.poll(() => reviewCalls(steps).length, { timeout: 60_000 }).toBe(1);
    expect(steps.posted()).toEqual([]);
    // It is alive, inside its sleep: the check below would see it.
    expect(stubGhStillPosting(steps.base)).toHaveLength(1);
    await steps.app.close();
    // Quitting stopped the command: no gh of this run is left to finish the post.
    await expect.poll(() => stubGhStillPosting(steps.base), { timeout: 10_000 }).toEqual([]);
    expect(fs.existsSync(steps.files.ghPosted)).toBe(false);

    // The same profile, and a gh that posts at once.
    const ghBefore = steps.ghLog().length;
    const since = () => steps.ghLog().slice(ghBefore);
    const relaunched = await launchElectron({ userDataDir: steps.userDataDir, env: { ...steps.env, STUB_GH_SLEEP: '0' } });
    steps.app = relaunched.app;
    steps.page = relaunched.page;
    const dashboard = dashboardOf(steps.page);
    await expect(dashboard.getByRole('heading', { name: 'Automations · Sprocket' })).toBeVisible({ timeout: 30_000 });
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(steps.page)).toContainText('failed at publish', { timeout: 30_000 });

    const record = await theRun(steps);
    expect(record.status).toBe('failed');
    expect(statuses(record)).toEqual({ fresh: 'completed', review: 'completed', publish: 'failed' });
    expect(stepsOf(record).publish.error).toBe(INTERRUPTED);

    const run = await openRun(steps);
    await expect(run.locator('.automations-run-status')).toHaveText('Failed');
    await expect(stepNode(run, 'publish')).toHaveAccessibleName(/^publish: Failed/);
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    await expect(publishDetail.getByText(INTERRUPTED, { exact: true })).toBeVisible();

    // Retry asks first, and says why.
    await run.getByRole('button', { name: 'Retry from publish', exact: true }).click();
    const warning = run.getByRole('group', { name: 'Retry from publish' });
    await expect(warning.getByText(INTERRUPTED_RETRY_WARNING, { exact: true })).toBeVisible();
    await expect(warning.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    // Nothing re-ran by itself since the restart: no post, no call to post.
    expect(reviewCalls(steps, since())).toEqual([]);
    expect(fs.existsSync(steps.files.ghPosted)).toBe(false);

    await warning.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(run.locator('.automations-run-status')).toHaveText('Completed', { timeout: 60_000 });
    await expect(publishDetail.getByText('Attempt 2 · earlier: 1 failed', { exact: true })).toBeVisible();

    // Exactly one review on GitHub, from exactly one call since the restart.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`-f commit_id=${git(steps.checkoutDir, 'rev-parse', 'HEAD')} -f event=REQUEST_CHANGES -F body=@`);
    expect(reviewCalls(steps, since())).toHaveLength(1);
    // The agent was not asked again: one review turn, before the restart.
    expect(steps.launches()).toHaveLength(1);
  } finally {
    await steps.close();
  }
});

test('notify runs the agents and only reports the post', async () => {
  test.setTimeout(180_000);
  const steps = await setUpSteps();
  try {
    const dashboard = await openAutomations(steps.page);
    const notify = assignedReviewsEntry().replace(/^ {2}mode: auto$/m, '  mode: notify');
    expect(notify).toContain('\n  mode: notify\n');
    writeFactory(steps, notify);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await expect(dashboard.locator('.automations-row', { hasText: 'review-assigned-prs' })).toHaveCount(1, { timeout: 15_000 });
    await fireOn51(steps);
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 60_000 });

    // `fresh` ran (it is marked `dry_run: run`), and the review ran read-only.
    expect(freshCalls(steps), "fresh's gh call is in the stub's log").toHaveLength(1);
    const launches = steps.launches();
    expect(launches).toHaveLength(1);
    expect(launches[0].startsWith(`${steps.checkoutDir} :: -p --session-id `)).toBe(true);
    expect(launches[0]).toContain(' --restricted');
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL '))).toEqual([
      expect.stringMatching(/^TOOL consola_write_artifact Wrote handover \(/),
      'TOOL consola_set_outputs Set: verdict. Every output is set.',
    ]);

    const record = await theRun(steps);
    expect(record.dryRun).toBe(true);
    expect(statuses(record)).toEqual({ fresh: 'completed', review: 'completed', publish: 'reported' });

    const run = await openRun(steps);
    await expect(stepNode(run, 'publish')).toHaveAccessibleName('publish: Would have run');
    await stepNode(run, 'publish').click();
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    await expect(publishDetail.getByRole('heading', { name: 'Would have run' })).toBeVisible();
    await expect(publishDetail).toContainText('VERDICT = {{steps.review.verdict}} → request-changes');

    // The run has settled: nothing was posted, and the post was never called.
    expect(reviewCalls(steps)).toEqual([]);
    expect(fs.existsSync(steps.files.ghPosted)).toBe(false);
  } finally {
    await steps.close();
  }
});
