import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { assignedReviewsEntry } from '@consola/automation-engine';
import { parseAutomationEntry, type RunRecord, type StepRun } from '@consola/factory-spec';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const INTERRUPTED =
  'Interrupted: Consola quit while this command was running. It may or may not have finished; check, then retry.';

/** What Retry says first about such a command: the spec's words. */
const INTERRUPTED_RETRY_WARNING =
  'Consola quit while this command ran; check the pull request first — it may already be posted.';

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
  if (!parsed.ok)
    throw new Error(`The shipped template does not parse: ${JSON.stringify(parsed.issues)}`);
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
    }),
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
    [
      '#!/bin/sh',
      `exec '${process.execPath}' '${path.join(FIXTURES, 'claude-steps.cjs')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
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
    };
    writeInbox(files.inbox, []);
    const outputs =
      options.outputs === undefined ? { verdict: 'request-changes' } : options.outputs;
    if (outputs !== null)
      fs.writeFileSync(
        files.outputs,
        typeof outputs === 'string' ? outputs : JSON.stringify(outputs),
      );
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

/** The banner's Add: the shipped template, written to factory.yml, listed once main has loaded it. */
async function addReviewTemplate(steps: Steps): Promise<void> {
  const dashboard = dashboardOf(steps.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const banner = dashboard.getByRole('region', { name: 'Review PRs assigned to me automatically' });
  await banner.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(
    dashboard.locator('.automations-row', { hasText: 'review-assigned-prs' }),
  ).toHaveCount(1, { timeout: 15_000 });
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
  await expect(panel.getByRole('list', { name: 'Steps of this run' })).toBeVisible();
  return panel;
}

/** A step's row in the run's trace: its header, a button named `<id>: <outcome>` that opens it. */
function stepNode(panel: Locator, id: string): Locator {
  return panel
    .getByRole('list', { name: 'Steps of this run' })
    .getByRole('button', { name: new RegExp(`^${id}: `) });
}

/** A step's kind, as its row in the trace names it: `Command` or `Agent`. */
function stepKind(region: Locator): Locator {
  return region.locator('.automations-trace-kind');
}

/** One `env:` variable or output of a step's trace, by the `NAME =` it starts with. */
function variable(region: Locator, name: string): Locator {
  return region.locator('.automations-vars > li').filter({ hasText: new RegExp(`^${name} = `) });
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
  fs.writeFileSync(
    path.join(dir, 'factory.yml'),
    `version: 1\nautomations:\n${entry.replace(/^/gm, '  ')}\n`,
  );
}

/**
 * Whether main holds a terminal for `instanceId` whose agent has not exited:
 * exactly what main's `isRunning` asks of a session, so what `checkoutBusy`
 * and `worktreeInUse` see.
 */
async function terminalRunning(page: Page, instanceId: string): Promise<boolean> {
  return page.evaluate(
    async (id) => (await window.terminalAPI.getStatusSnapshot())[id]?.hasExited === false,
    instanceId,
  );
}

/** A session's record as main has it now, or null when it is gone. */
async function sessionRecord(steps: Steps, sessionId: string) {
  return steps.page.evaluate(
    async ([workspaceId, id]) => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      return (
        workspaces
          .find((workspace) => workspace.id === workspaceId)
          ?.sessions.find((session) => session.id === id) ?? null
      );
    },
    [steps.workspaceId, sessionId] as const,
  );
}

/**
 * Everything git says about a checkout that a run could change: the commit,
 * the branch (`HEAD` when detached), the index's entries, and every change in
 * the working tree, untracked and ignored files included. Read without
 * optional locks, so reading it never rewrites the index itself. The status
 * is kept exactly, leading space included: ` M` (unstaged) is not `M ` (staged).
 */
function checkoutState(dir: string) {
  const status = execFileSync(
    'git',
    [
      '-C',
      dir,
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignored',
    ],
    { encoding: 'utf8', env: GIT_ENV },
  );
  return {
    head: git(dir, 'rev-parse', 'HEAD'),
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    index: git(dir, 'ls-files', '--stage'),
    status: status.replace(/\n$/, ''),
  };
}

/** Each file's bytes, by its path under `dir`. */
function fileBytes(dir: string, files: readonly string[]): Record<string, Buffer> {
  return Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(dir, file))]));
}

/** What the scheduled pipeline's agent writes as its handover, and so what `post` copies. */
const SUMMARY = `## What fetch found

Two items, \`1\` and \`2\`.
`;

/**
 * A pipeline on a schedule, in `catalog-portal`'s folder: `fetch` prints
 * JSON kept as its `output`, `summarise` reads it, and `post` copies the
 * summary's handover file to `notes`. The cron is never due (31 February),
 * so only Run now starts it.
 */
function scheduledPipeline(notes: string): string {
  return `- name: summarise-items
  on: { cron: "0 0 31 2 *" }
  scope: catalog-portal
  mode: auto
  steps:
    - id: fetch
      run: printf '{"items":[1,2]}'
      outputs: { from: stdout, format: json }
    - id: summarise
      prompt: Summarise what fetch found.
      reads: [fetch.output]
    - id: post
      run: cp "$NOTES" "$OUT"
      env:
        NOTES: "{{steps.summarise.handover.file}}"
        OUT: "${notes}"`;
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
    expect(
      steps
        .ghLog()
        .filter(
          (line) =>
            line.startsWith('pr checkout') || line.includes(' url=') || line.includes('/reviews'),
        ),
    ).toEqual([]);
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
    const allowed =
      review.split(' --allowedTools ')[1]?.split(' --restricted')[0]?.split(' ') ?? [];
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
    const publish = steps
      .ghLog()
      .filter((line) => line.startsWith(`api repos/${REPO}/pulls/51/reviews `));
    expect(publish).toHaveLength(1);
    expect(publish[0]).toMatch(/ GH_TOKEN=gho_stub_token_for_JaviDev$/);

    // Opening the run, every step and the handover reads; it starts nothing.
    const counts = () => ({
      claude: steps.claudeLog().length,
      gh: steps.ghLog().length,
      posted: steps.posted().length,
    });
    const before = counts();
    const run = await openRun(steps);
    await expect(run.locator('.automations-run-status')).toHaveText('Completed');
    for (const id of ['fresh', 'review', 'publish']) {
      await expect(stepNode(run, id)).toHaveAccessibleName(new RegExp(`^${id}: Completed`));
    }

    await stepNode(run, 'fresh').click();
    const freshDetail = run.getByRole('region', { name: 'Step fresh' });
    await expect(variable(freshDetail, 'needed')).toHaveText(/^needed = true$/);
    await expect(freshDetail.getByText(templateCommand('fresh'), { exact: true })).toBeVisible();

    await stepNode(run, 'review').click();
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(variable(reviewDetail, 'verdict')).toHaveText(/^verdict = request-changes$/);
    // Its transcript, read from the stub's config dir: the turn's prompt.
    await expect(reviewDetail).toContainText('From the session’s transcript.');
    await expect(reviewDetail).toContainText('Review this pull request. Read it with Consola');
    const handover = reviewDetail.getByRole('button', { name: 'handover', exact: true });
    await handover.click();
    await expect(handover).toHaveAttribute('aria-expanded', 'true');
    await expect(reviewDetail.locator('.automations-step-artifact')).toContainText(
      'the catalog is exported empty, so search has nothing to find.',
    );

    await stepNode(run, 'publish').click();
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    // Each variable with the value it had, and the template it came from.
    await expect(variable(publishDetail, 'VERDICT')).toHaveText(
      /^VERDICT = request-changes\s*from \{\{steps\.review\.verdict\}\}$/,
    );
    await expect(variable(publishDetail, 'REPO')).toHaveText(
      new RegExp(`^REPO = ${REPO}\\s*from \\{\\{item\\.repo\\}\\}$`),
    );
    await expect(variable(publishDetail, 'NUMBER')).toHaveText(
      /^NUMBER = 51\s*from \{\{item\.number\}\}$/,
    );
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
    expect(statuses(run)).toEqual({
      fresh: 'completed',
      review: 'completed',
      publish: 'completed',
    });
    expect(stepsOf(run).review.outputs).toEqual({ verdict: 'approve' });
    expect(run.summary).toBe('fresh → review → publish (approve)');

    // A shipped review never approves: `approve` is posted as a comment, once, pinned to the checkout's head.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0].startsWith(REVIEWS_CALL)).toBe(true);
    expect(posted[0]).toContain(
      `-f commit_id=${git(steps.checkoutDir, 'rev-parse', 'HEAD')} -f event=COMMENT -F body=@`,
    );
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
    await expect(variable(run.getByRole('region', { name: 'Step fresh' }), 'needed')).toHaveText(
      /^needed = false$/,
    );
    await stepNode(run, 'review').click();
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(stepKind(reviewDetail)).toHaveText('Agent');
    // Why: its if:, as written, and the value that made it false.
    await expect(reviewDetail.getByText('if: steps.fresh.needed', { exact: true })).toBeVisible();
    await expect(reviewDetail.locator('.automations-fact-list li')).toHaveText(
      'steps.fresh.needed was false',
    );
    await stepNode(run, 'publish').click();
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    await expect(stepKind(publishDetail)).toHaveText('Command');
    await expect(publishDetail.getByText('if: steps.fresh.needed', { exact: true })).toBeVisible();
    await expect(publishDetail.locator('.automations-fact-list li')).toHaveText(
      'steps.fresh.needed was false',
    );

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
    expect(steps.claudeLog().filter((line) => line.startsWith('END '))).toEqual([
      `END ${id} exit 0`,
      `END ${id} exit 0`,
    ]);
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL consola_set_outputs'))).toEqual(
      [],
    );

    const record = await theRun(steps);
    expect(record.status).toBe('failed');
    expect(statuses(record)).toEqual({ fresh: 'completed', review: 'failed', publish: 'not-run' });
    expect(stepsOf(record).review.error).toBe('ended without setting verdict');
    expect(stepsOf(record).review.reminded).toBe(true);

    const run = await openRun(steps);
    await expect(run.locator('.automations-run-status')).toHaveText('Failed');
    await expect(stepNode(run, 'review')).toHaveAccessibleName(/^review: Failed/);
    // A step the run never reached did not run, and says why where it is listed, not on hover.
    await expect(stepNode(run, 'publish')).toHaveAccessibleName('publish: Did not run');
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    await expect(
      publishDetail.getByText('The run stopped at review before reaching it.', { exact: true }),
    ).toBeVisible();
    // The run's note says where it failed and what it never reached.
    const note = run.getByRole('note');
    await expect(note).toContainText('Failed at review');
    await expect(note).toContainText('Ended without setting verdict.');
    await expect(note).toContainText('Because of this, publish did not run.');
    // The failed step is open from the start.
    await expect(stepNode(run, 'review')).toHaveAttribute('aria-expanded', 'true');
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(
      reviewDetail.getByText('ended without setting verdict', { exact: true }),
    ).toBeVisible();
    await expect(reviewDetail.getByText('Reminded once', { exact: true })).toBeVisible();
    await stepNode(run, 'publish').click();
    await expect(stepKind(publishDetail)).toHaveText('Command');
    await expect(
      publishDetail.getByText(templateCommand('publish'), { exact: true }),
    ).toBeVisible();

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
    await expect
      .poll(() => steps.claudeLog().filter((line) => line.startsWith('END ')).length, {
        timeout: 60_000,
      })
      .toBe(1);
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL consola_set_outputs'))).toEqual(
      [],
    );
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
    expect(statuses(record)).toEqual({
      fresh: 'completed',
      review: 'completed',
      publish: 'completed',
    });
    expect(stepsOf(record).review.outputs).toEqual({ verdict: 'request-changes' });
    expect(stepsOf(record).review.reminded).toBe(true);

    // Posted exactly once, with the first turn's handover.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(
      `-f commit_id=${git(steps.checkoutDir, 'rev-parse', 'HEAD')} -f event=REQUEST_CHANGES -F body=@`,
    );
    expect(posted[0].slice(posted[0].indexOf(' BODY=') + ' BODY='.length)).toBe(flatten(HANDOVER));
    expect(reviewCalls(steps)).toHaveLength(1);

    const run = await openRun(steps);
    await stepNode(run, 'review').click();
    const reviewDetail = run.getByRole('region', { name: 'Step review' });
    await expect(reviewDetail.getByText('Reminded once', { exact: true })).toBeVisible();
    await expect(variable(reviewDetail, 'verdict')).toHaveText(/^verdict = request-changes$/);
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
    const relaunched = await launchElectron({
      userDataDir: steps.userDataDir,
      env: { ...steps.env, STUB_GH_SLEEP: '0' },
    });
    steps.app = relaunched.app;
    steps.page = relaunched.page;
    const dashboard = dashboardOf(steps.page);
    await expect(dashboard.getByRole('heading', { name: 'Automations · Sprocket' })).toBeVisible({
      timeout: 30_000,
    });
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(steps.page)).toContainText('failed at publish', { timeout: 30_000 });

    const record = await theRun(steps);
    expect(record.status).toBe('failed');
    expect(statuses(record)).toEqual({
      fresh: 'completed',
      review: 'completed',
      publish: 'failed',
    });
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
    await expect(run.locator('.automations-run-status')).toHaveText('Completed', {
      timeout: 60_000,
    });
    await expect(
      publishDetail.getByText('Attempt 2 · earlier: 1 failed', { exact: true }),
    ).toBeVisible();

    // Exactly one review on GitHub, from exactly one call since the restart.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(
      `-f commit_id=${git(steps.checkoutDir, 'rev-parse', 'HEAD')} -f event=REQUEST_CHANGES -F body=@`,
    );
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
    await expect(
      dashboard.locator('.automations-row', { hasText: 'review-assigned-prs' }),
    ).toHaveCount(1, { timeout: 15_000 });
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
    expect(statuses(record)).toEqual({
      fresh: 'completed',
      review: 'completed',
      publish: 'reported',
    });

    const run = await openRun(steps);
    await expect(stepNode(run, 'publish')).toHaveAccessibleName('publish: Would have run');
    await stepNode(run, 'publish').click();
    const publishDetail = run.getByRole('region', { name: 'Step publish' });
    await expect(publishDetail.getByRole('heading', { name: 'Would have run' })).toBeVisible();
    await expect(variable(publishDetail, 'VERDICT')).toHaveText(
      /^VERDICT = request-changes\s*from \{\{steps\.review\.verdict\}\}$/,
    );

    // The run has settled: nothing was posted, and the post was never called.
    expect(reviewCalls(steps)).toEqual([]);
    expect(fs.existsSync(steps.files.ghPosted)).toBe(false);
  } finally {
    await steps.close();
  }
});

test('a full-tools session on the Inbox worktree does not hold the review back', async () => {
  test.setTimeout(180_000);
  const steps = await setUpSteps();
  const { page } = steps;
  try {
    // #51's Inbox worktree, at the commit before the PR's: where a Review the
    // person started by hand left it.
    const inboxDir = path.join(steps.worktreesDir, 'catalog-portal-pr-51');
    const init = git(steps.clone, 'rev-parse', 'main');
    expect(init).not.toBe(steps.head);
    git(steps.clone, 'worktree', 'add', '--quiet', inboxDir, init);
    const left = checkoutState(inboxDir);
    expect(left).toMatchObject({ head: init, branch: 'HEAD', status: '' });
    // The person's uncommitted work there, of every kind a reset or a clean
    // would destroy: an edit not staged, a new file staged, a file untracked.
    fs.appendFileSync(path.join(inboxDir, 'src', 'catalog.ts'), 'export const seeded = true;\n');
    fs.writeFileSync(path.join(inboxDir, 'src', 'filters.ts'), 'export const filters = [];\n');
    git(inboxDir, 'add', 'src/filters.ts');
    fs.writeFileSync(path.join(inboxDir, 'review-notes.md'), '- search ignores case?\n');
    const work = ['src/catalog.ts', 'src/filters.ts', 'review-notes.md'];
    const held = checkoutState(inboxDir);
    expect(held).toMatchObject({
      head: init,
      branch: 'HEAD',
      status: [' M src/catalog.ts', 'A  src/filters.ts', '?? review-notes.md'].join('\n'),
    });
    expect(held.index).toContain('\tsrc/filters.ts');
    const heldBytes = fileBytes(inboxDir, work);

    // The person's session there, made as a window makes one: full tools (no
    // tool policy), in that folder, on #51.
    const instanceId = 'inbox-51-by-hand';
    const created = await page.evaluate(
      async ([workspaceId, cwd, id]) => {
        const { workspaces } = await window.workspaceAPI.getSnapshot();
        const scopeId = workspaces.find((workspace) => workspace.id === workspaceId)!.scopes[0].id;
        return window.workspaceAPI.createSession(workspaceId, {
          name: 'Reviewing #51 by hand',
          workspaceId,
          instanceId: id,
          harnessId: 'stub',
          scopeId,
          cwd,
          workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 },
        });
      },
      [steps.workspaceId, inboxDir, instanceId] as const,
    );
    if (!created) throw new Error('The session was not created.');
    const session = await sessionRecord(steps, created.id);
    expect(session).toMatchObject({
      cwd: inboxDir,
      instanceId,
      workItem: { repo: REPO, type: 'pr', number: 51 },
    });
    // Full tools, launched there: `worktreeInUse` holds the folder for it, running or not.
    expect(session?.toolPolicy).toBeUndefined();
    expect(session?.agentCwd).toBeUndefined();

    // Opened, so its agent is running there: what `checkoutBusy` asks of it too.
    expect(await terminalRunning(page, instanceId)).toBe(false);
    await page.locator('.session-nav-item', { hasText: 'Reviewing #51 by hand' }).click();
    await expect.poll(() => terminalRunning(page, instanceId), { timeout: 15_000 }).toBe(true);
    const inInbox = () => steps.launches().filter((line) => line.startsWith(`${inboxDir} :: `));
    await expect.poll(() => inInbox().length, { timeout: 15_000 }).toBe(1);
    const byHand = inInbox()[0].split(' :: ')[1].split(' ');
    expect(byHand.slice(0, 2)).toEqual(['--session-id', session!.claudeSessionId]);
    expect(byHand).not.toContain('-p');
    expect(byHand).not.toContain('--restricted');
    // Starting it moved nothing, and kept every change.
    expect(checkoutState(inboxDir)).toEqual(held);
    expect(fileBytes(inboxDir, work)).toEqual(heldBytes);

    const dashboard = await openAutomations(page);
    await addReviewTemplate(steps);
    await fireOn51(steps);
    await startTheRun(steps);
    await expect(runItems(page)).toContainText('Completed', { timeout: 60_000 });
    await expect(dashboard.locator('.automations-run-item')).toHaveCount(1);
    expect(freshCalls(steps), "fresh's gh call is in the stub's log").toHaveLength(1);

    // The review read #51's head, in the automation checkout.
    expect(git(steps.checkoutDir, 'rev-parse', 'HEAD')).toBe(steps.head);
    const turns = steps.launches().filter((line) => line.split(' :: ')[1].startsWith('-p '));
    expect(turns).toHaveLength(1);
    expect(turns[0].startsWith(`${steps.checkoutDir} :: -p --session-id `)).toBe(true);
    expect(turns[0]).toContain(' --restricted');
    expect((await theRun(steps)).checkout).toMatchObject({
      cwd: steps.checkoutDir,
      head: steps.head,
    });

    // And posted it, pinned to that head.
    const posted = steps.posted();
    expect(posted).toHaveLength(1);
    expect(posted[0].startsWith(REVIEWS_CALL)).toBe(true);
    expect(posted[0]).toContain(`-f commit_id=${steps.head} -f event=REQUEST_CHANGES -F body=@`);
    expect(reviewCalls(steps)).toHaveLength(1);

    // The person's checkout is as they left it: the same commit, still
    // detached, the same index, and their uncommitted work, byte for byte.
    expect(checkoutState(inboxDir)).toEqual(held);
    expect(fileBytes(inboxDir, work)).toEqual(heldBytes);
    expect(fs.existsSync(path.join(inboxDir, 'src', 'search.ts'))).toBe(false);
    // Their session worked there the whole time, and still does: one launch, still running, still in that folder.
    expect(inInbox()).toHaveLength(1);
    expect(await terminalRunning(page, instanceId)).toBe(true);
    const after = await sessionRecord(steps, created.id);
    expect(after).toMatchObject({ cwd: inboxDir });
    expect(after?.toolPolicy).toBeUndefined();
    expect(after?.agentCwd).toBeUndefined();
  } finally {
    await steps.close();
  }
});

test("a scheduled pipeline passes a command's output to an agent and its handover to a command", async () => {
  test.setTimeout(180_000);
  // The agent writes the summary as its handover and sets nothing: the step declares no outputs.
  const steps = await setUpSteps({ outputs: null, handover: SUMMARY });
  const notes = path.join(steps.base, 'notes.md');
  try {
    const dashboard = await openAutomations(steps.page);
    const entry = scheduledPipeline(notes);
    // The file means what this test says it does.
    const parsed = parseAutomationEntry(entry);
    if (!parsed.ok)
      throw new Error(`The pipeline does not parse: ${JSON.stringify(parsed.issues)}`);
    expect(
      parsed.automation.steps?.map((step) =>
        step.kind === 'run' ? [step.id, step.run] : [step.id, step.kind],
      ),
    ).toEqual([
      ['fetch', `printf '{"items":[1,2]}'`],
      ['summarise', 'agent'],
      ['post', 'cp "$NOTES" "$OUT"'],
    ]);
    writeFactory(steps, entry);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    const row = dashboard.locator('.automations-row', { hasText: 'summarise-items' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByRole('button', { name: 'Run now' }).click();
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 60_000 });

    // `post` got the summary's handover as a file, and copied it.
    expect(fs.readFileSync(notes, 'utf8')).toBe(SUMMARY);

    // `summarise`: one read-only turn in the scope's folder, told to read fetch's output.
    const launches = steps.launches();
    expect(launches).toHaveLength(1);
    const [summarise] = launches;
    expect(summarise.startsWith(`${steps.clone} :: -p --session-id `)).toBe(true);
    expect(summarise).toContain(' --restricted');
    expect(summarise).toContain(', in catalog-portal. ');
    expect(summarise).toContain(' Summarise what fetch found. ');
    expect(summarise).toContain(
      ' - fetch.output (from step "fetch", 15 B) Read them with consola_read_artifact.',
    );
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL '))).toEqual([
      expect.stringMatching(/^TOOL consola_write_artifact Wrote handover \(/),
    ]);

    const record = await theRun(steps);
    expect(record.status).toBe('completed');
    expect(statuses(record)).toEqual({
      fetch: 'completed',
      summarise: 'completed',
      post: 'completed',
    });
    const byId = stepsOf(record);
    expect(byId.fetch.artifacts?.map((artifact) => [artifact.name, artifact.bytes])).toEqual([
      ['output', 15],
    ]);
    expect(byId.summarise.artifacts?.map((artifact) => artifact.name)).toEqual(['handover']);
    expect(record.checkout?.cwd).toBe(steps.clone);

    // Each command ran in the scope's folder: the clone.
    const run = await openRun(steps);
    await expect(run.locator('.automations-run-status')).toHaveText('Completed');
    await stepNode(run, 'fetch').click();
    const fetchDetail = run.getByRole('region', { name: 'Step fetch' });
    await expect(fetchDetail.getByText(`printf '{"items":[1,2]}'`, { exact: true })).toBeVisible();
    await expect(fetchDetail.getByText(steps.clone, { exact: true })).toBeVisible();
    await stepNode(run, 'post').click();
    const postDetail = run.getByRole('region', { name: 'Step post' });
    await expect(postDetail.getByText(steps.clone, { exact: true })).toBeVisible();
  } finally {
    await steps.close();
  }
});
