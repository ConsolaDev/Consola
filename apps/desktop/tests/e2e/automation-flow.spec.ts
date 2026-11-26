import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { assignedReviewsGatedEntry } from '@consola/automation-engine';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';

/**
 * Control flow in a `steps:` run, end to end (slice 3, phase 3-A): a loop
 * that runs round by round, a gate a person answers in Consola, a declared
 * retry that waits and runs again, a budget that stops a run, a parked run
 * that survives a restart, and the gated review template holding its pull
 * request while it waits.
 *
 * Nothing here reaches GitHub or a model. The stub `claude`
 * (`tests/fixtures/claude-steps.cjs`) speaks MCP to Consola's real session
 * endpoint, so a step's outputs and handover arrive the way a real CLI's
 * would; every loop round is a new session, so the per-round `findings` come
 * from `STUB_CLAUDE_OUTPUTS_SEQ`, one entry per launch. The `run:` steps
 * find the stub `gh` through the fixture login shell, as in
 * `automation-steps.spec.ts`, whose helpers are copied here, not imported,
 * so each spec runs only its own tests. Where a scenario has two runs, a run
 * is found by its automation, never as "the only one".
 *
 * Every entry here is new and `mode: auto`, so its first run asks first:
 * each scenario starts it with Review… and Start before asserting anything
 * of the run. The engine ticks every two seconds and a declared retry waits
 * a second (`CONSOLA_AUTOMATIONS_TICK_MS`, `CONSOLA_AUTOMATIONS_RETRY_MS`).
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
const PR_TITLE = 'Add catalog search';
/** The Inbox fixture's one date, so nothing here reads the clock. */
const UPDATED_AT = '2026-11-14T09:30:00Z';

/** What the stub agent writes as its handover: Markdown over several lines. */
const HANDOVER = `## Findings

\`src/catalog.ts:1\`: the catalog is exported empty, so search has nothing to find.
`;

/** The loop, the gate after it and the command the gate decides: the plan's scenarios' factory. */
const GATED_LOOP = `- name: gated-loop
  on: manual
  scope: catalog-portal
  mode: auto
  budget: { usd: 1 }
  steps:
    - id: polish
      repeat: { max: 3, until: steps.look.findings == 0 }
      steps:
        - id: look
          prompt: Count the findings.
          outputs: { findings: integer }
        - id: fix
          if: steps.look.findings > 0
          run: echo fixed
          dry_run: run
      on_exhausted: { gate: "Still findings after 3 rounds. Go on?" }
    - id: decide
      gate: { ask: "Publish it?", choices: [publish, hold] }
    - id: publish
      if: steps.decide.decision == 'publish'
      run: echo published`;

/** The same, with a command before the loop that fails once and declares one retry. */
function withFlaky(mark: string): string {
  return GATED_LOOP.replace(
    '  steps:\n    - id: polish',
    [
      '  steps:',
      '    - id: flaky',
      '      run: test -f "$MARK" || { touch "$MARK"; exit 1; }',
      `      env: { MARK: ${JSON.stringify(mark)} }`,
      '      dry_run: run',
      '      on_failure: { retry: 1 }',
      '    - id: polish',
    ].join('\n'),
  );
}

/** A second automation on the same pull request: one read-only step, which declares the verdict the stub sets. */
const REVIEW_AGAIN = `- name: review-again
  on: manual
  applies_to: [pr]
  mode: auto
  steps:
    - id: again
      prompt: Review this pull request again.
      outputs:
        verdict: { enum: [approve, comment, request-changes] }`;

const GATED_REVIEW = 'review-assigned-prs-gated';

/** The over-budget words and the Retry refusal, as the plan fixes them. */
const OVER_BUDGET = 'over its budget: $1.20 spent of $1.00';
const OVER_BUDGET_RETRY =
  "This run can't continue: it is over the budget it was approved with. Raise `budget:` in the file and run it again.";

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A file's lines, none when it does not exist. */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
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

interface FlowOptions {
  /** Launch environment for this test, over the fixtures' own. */
  env?: Record<string, string>;
  /** What `STUB_CLAUDE_OUTPUTS_SEQ` holds, one outputs object per launch; null writes no file. */
  sequence?: Array<Record<string, unknown>> | null;
  /** What `STUB_CLAUDE_OUTPUTS` holds; null writes no file. Default none. */
  outputs?: Record<string, unknown> | null;
}

interface Flow {
  app: ElectronApplication;
  page: Page;
  base: string;
  /** The profile, under `base`; main keeps its data in `${userDataDir} Test`, also under `base`. */
  userDataDir: string;
  /** The whole launch environment, for relaunching on the same profile. */
  env: Record<string, string>;
  /** #51's automation checkout, beside the Inbox's worktree: where an item run's steps run. */
  checkoutDir: string;
  factoryDir: string;
  workspaceId: string;
  /** The tip of `pr-51`, one commit ahead of `main`: #51's head. */
  head: string;
  files: { inbox: string; claudeLog: string; ghPosted: string };
  /** Every review the stub `gh` finished posting: its argv, then `BODY=` the body file's text. */
  posted(): string[];
  writeInbox(direct: number[]): void;
  close(): Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, its default harness the stub `claude` with its own config dir, and
 * held in this window. The clone's origin is #51's repository, and `pr-51` is
 * one commit ahead of `main`. The Inbox starts empty.
 */
async function setUpFlow(options: FlowOptions = {}): Promise<Flow> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automation-flow-')));
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
      sequence: path.join(base, 'outputs-seq.json'),
      handover: path.join(base, 'handover.md'),
    };
    writeInbox(files.inbox, []);
    if (options.outputs) fs.writeFileSync(files.outputs, JSON.stringify(options.outputs));
    if (options.sequence) fs.writeFileSync(files.sequence, JSON.stringify(options.sequence));
    fs.writeFileSync(files.handover, HANDOVER);
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
      CONSOLA_AUTOMATIONS_TICK_MS: '2000',
      CONSOLA_AUTOMATIONS_RETRY_MS: '1000',
      SHELL: path.join(FIXTURES, 'login-shell.sh'),
      STUB_LOGIN_PATH: STUB_GH_DIR,
      STUB_GH_PR_HEAD: head,
      STUB_GH_LOG: files.ghLog,
      STUB_GH_POSTED: files.ghPosted,
      STUB_CLAUDE_LOG: files.claudeLog,
      STUB_CLAUDE_OUTPUTS: files.outputs,
      STUB_CLAUDE_OUTPUTS_SEQ: files.sequence,
      STUB_CLAUDE_HANDOVER: files.handover,
      ...(options.env ?? {}),
    };
    const userDataDir = path.join(base, 'profile');
    const launched = await launchElectron({ userDataDir, env, strictLaunches: true });
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

    const flow: Flow = {
      app,
      page,
      base,
      userDataDir,
      env,
      checkoutDir: path.join(worktreesDir, 'catalog-portal-pr-51-automation'),
      factoryDir,
      workspaceId,
      head,
      files,
      posted: () => lines(files.ghPosted),
      writeInbox: (direct) => writeInbox(files.inbox, direct),
      // The current app, so a test that relaunches can hand its own back.
      close: async () => {
        app = flow.app;
        await close();
      },
    };
    return flow;
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

/** The workspace's factory.yml holding exactly these entries. */
function writeFactory(flow: Flow, entries: string): void {
  const dir = path.join(flow.factoryDir, flow.workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'factory.yml'),
    `version: 1\nautomations:\n${entries.replace(/^/gm, '  ')}\n`,
  );
}

/** An automation's row in the Automations tab, by its name exactly (`review-assigned-prs` is in another's). */
function rowOf(page: Page, name: string): Locator {
  return dashboardOf(page)
    .locator('.automations-row')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
}

/** Wait for an automation's row, and press its Run now. */
async function runNow(flow: Flow, name: string): Promise<void> {
  await closePanel(flow.page);
  const dashboard = dashboardOf(flow.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const row = rowOf(flow.page, name);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.getByRole('button', { name: 'Run now' }).click();
}

/**
 * #51 asks for a review, for `automation` (an Inbox event entry): its first
 * check is the baseline, over an empty Inbox, and the second finds #51 new.
 * Each waits for its check to end (the button reads "Checking…" until it does).
 */
async function fireOn51(flow: Flow, automation: string): Promise<void> {
  await closePanel(flow.page);
  const dashboard = dashboardOf(flow.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const checkNow = rowOf(flow.page, automation).getByRole('button', { name: 'Check now' });
  await expect(checkNow).toHaveCount(1, { timeout: 15_000 });
  flow.writeInbox([]);
  await checkNow.click();
  await expect(checkNow).toBeEnabled();
  flow.writeInbox([51]);
  await checkNow.click();
  await expect(checkNow).toBeEnabled();
}

/** The workspace's runs in Activity's list. */
function runItems(page: Page): Locator {
  return dashboardOf(page).locator('.automations-run-item');
}

/**
 * `automation`'s run in Activity, by the name it is listed under exactly: a
 * run held by another's gate names that one in its own row.
 */
function runItemOf(page: Page, automation: string): Locator {
  return runItems(page).filter({
    has: page.locator('.automations-run-item-name', { hasText: new RegExp(`^${automation}$`) }),
  });
}

/**
 * The first run of `automation`, waiting for approval, started: Review… on
 * its card in the Automations tab's *Waiting for you* (a run parked at a
 * gate is a card there too), then Start; Activity then lists `rows` runs.
 * Before Start it checks the card's flow lines, `flow`, are there.
 */
async function startTheRun(
  flow: Flow,
  automation: string,
  rows = 1,
  lines: string[] = [],
): Promise<void> {
  await closePanel(flow.page);
  const dashboard = dashboardOf(flow.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const card = dashboard.locator('.automations-waiting-card').filter({ hasText: automation });
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review…' }).click();
  const approval = sidePanel(flow.page).getByRole('region', { name: 'Waiting for your approval' });
  const flowLines = approval.getByRole('group', { name: 'How this run flows' });
  for (const line of lines) await expect(flowLines).toContainText(line);
  await approval.getByRole('button', { name: 'Start', exact: true }).click();
  await dashboard.getByRole('tab', { name: 'Activity' }).click();
  await expect(runItems(flow.page)).toHaveCount(rows, { timeout: 15_000 });
}

/**
 * Open `automation`'s run from Activity, into the side panel. A panel
 * already open is closed first, so the run's page mounts afresh and reads
 * everything it shows again.
 */
async function openRun(flow: Flow, automation: string): Promise<Locator> {
  await closePanel(flow.page);
  await dashboardOf(flow.page).getByRole('tab', { name: 'Activity' }).click();
  const item = runItemOf(flow.page, automation);
  await expect(item).toHaveCount(1, { timeout: 15_000 });
  await item.click();
  const panel = sidePanel(flow.page);
  await expect(panel.getByRole('list', { name: 'Steps of this run' })).toBeVisible();
  return panel;
}

/** A step's row in the run's trace: its header, a button named `<id>: <outcome>` that opens it. */
function stepNode(panel: Locator, id: string): Locator {
  return panel
    .getByRole('list', { name: 'Steps of this run' })
    .getByRole('button', { name: new RegExp(`^${id}: `) });
}

/** The workspace's runs of `automation`, read whole from main. */
async function runsOf(flow: Flow, automation: string): Promise<RunRecord[]> {
  return flow.page.evaluate(
    async ([workspaceId, name]) => {
      const { runs } = await window.automationsAPI.getSnapshot(workspaceId);
      const records = await Promise.all(
        runs
          .filter((run) => run.automationId === name)
          .map((run) => window.automationsAPI.getRun(run.id)),
      );
      return records.filter((record): record is RunRecord => record !== null);
    },
    [flow.workspaceId, automation] as const,
  );
}

/** `automation`'s one run, read whole from main. */
async function theRun(flow: Flow, automation: string): Promise<RunRecord> {
  const runs = await runsOf(flow, automation);
  if (runs.length !== 1) {
    throw new Error(`Expected one run of ${automation}, found ${runs.length}.`);
  }
  return runs[0];
}

/** A run, by id, read whole from main. */
async function getRun(flow: Flow, runId: string): Promise<RunRecord> {
  const run = await flow.page.evaluate((id) => window.automationsAPI.getRun(id), runId);
  if (!run) throw new Error(`The run ${runId} is gone.`);
  return run;
}

/** A run's steps by id: each one's record. */
function stepsOf(run: RunRecord): Record<string, StepRun> {
  return Object.fromEntries((run.steps ?? []).map((step) => [step.id, step]));
}

/** Where a run stands, as a test waits for it: its status, and the step it waits at when it waits. */
async function standing(flow: Flow, runId: string): Promise<string> {
  const run = await getRun(flow, runId);
  const waitingAt = (run.steps ?? []).find((step) => step.status === 'waiting');
  return waitingAt ? `${run.status} at ${waitingAt.id}` : run.status;
}

test('a review loop runs round by round, waits for you at its gate, and survives a restart', async () => {
  test.setTimeout(240_000);
  const flow = await setUpFlow({ sequence: [{ findings: 1 }, { findings: 0 }] });
  try {
    await openAutomations(flow.page);
    writeFactory(flow, GATED_LOOP);
    await runNow(flow, 'gated-loop');
    // The approval card says how the run flows, from main's lines (Task 19).
    await startTheRun(flow, 'gated-loop', 1, [
      'Repeats `look` and `fix` up to 3 times until `steps.look.findings == 0`; then asks you.',
      'Stops for you at `decide`.',
      '`fix` runs once per round (up to 3 times).',
      'Nothing retries by itself.',
      'Budget: $1 at most (est.).',
    ]);
    const { id: runId } = await theRun(flow, 'gated-loop');
    await expect.poll(() => standing(flow, runId), { timeout: 90_000 }).toBe('waiting at decide');

    // Round 1 found one and fixed it; round 2 found none, so `fix` was skipped and the loop ended clean.
    const parked = stepsOf(await getRun(flow, runId));
    expect(parked.look).toMatchObject({ attempt: 2, round: 2, status: 'completed' });
    expect(parked.look.previous?.[0]).toMatchObject({ round: 1, status: 'completed' });
    expect(parked.fix).toMatchObject({ round: 2, status: 'skipped' });
    expect(parked.fix.previous?.[0]).toMatchObject({ attempt: 1, round: 1, status: 'completed' });
    expect(parked.polish).toMatchObject({
      kind: 'repeat',
      status: 'completed',
      note: 'clean after round 2',
    });
    expect(parked.decide).toMatchObject({ kind: 'gate', status: 'waiting' });
    expect(parked.publish.status).toBe('pending');

    // Activity's first group is the person's: it reads where the run waits.
    const waitingGroup = dashboardOf(flow.page).locator('.automations-run-waiting');
    await expect(waitingGroup).toContainText('Waiting for you');
    await expect(waitingGroup.locator('.automations-run-item')).toContainText(
      'waiting for you at decide',
    );
    const panel = await openRun(flow, 'gated-loop');
    await expect(
      panel.getByRole('button', { name: /^polish · round 2 of 3: Completed/ }),
    ).toBeVisible();
    // The waiting gate opens itself: its question, its two choices, then Reject.
    const card = panel.getByRole('region', { name: 'Gate decide' });
    await expect(card).toContainText('Publish it?');
    for (const choice of ['Publish', 'Hold', 'Reject']) {
      await expect(card.getByRole('button', { name: choice, exact: true })).toBeVisible();
    }

    // A restart while it waits: the same profile, and the run comes back as it was.
    await flow.app.close();
    const relaunched = await launchElectron({
      strictLaunches: true,
      userDataDir: flow.userDataDir,
      env: flow.env,
    });
    flow.app = relaunched.app;
    flow.page = relaunched.page;
    await expect(
      dashboardOf(flow.page).getByRole('heading', { name: 'Automations · Sprocket' }),
    ).toBeVisible({ timeout: 30_000 });
    expect(await standing(flow, runId)).toBe('waiting at decide');
    expect(stepsOf(await getRun(flow, runId)).polish.status).toBe('completed');
    const again = await openRun(flow, 'gated-loop');
    const asked = again.getByRole('region', { name: 'Gate decide' });
    await expect(asked).toContainText('Publish it?');
    await asked.getByRole('button', { name: 'Publish', exact: true }).click();

    await expect.poll(() => standing(flow, runId), { timeout: 60_000 }).toBe('completed');
    const done = stepsOf(await getRun(flow, runId));
    expect(done.decide).toMatchObject({ status: 'completed', outputs: { decision: 'publish' } });
    expect(done.publish.status).toBe('completed');
    await expect(again.locator('.automations-run-status')).toHaveText('Completed');
    await expect(again.getByRole('region', { name: 'Gate decide' })).toContainText(
      'answered publish by you',
    );
  } finally {
    await flow.close();
  }
});

test('an exhausted loop asks after its last round, and Reject ends the run rejected', async () => {
  test.setTimeout(180_000);
  const flow = await setUpFlow({ sequence: [{ findings: 1 }] });
  try {
    await openAutomations(flow.page);
    writeFactory(flow, GATED_LOOP);
    await runNow(flow, 'gated-loop');
    await startTheRun(flow, 'gated-loop');
    const { id: runId } = await theRun(flow, 'gated-loop');
    await expect.poll(() => standing(flow, runId), { timeout: 120_000 }).toBe('waiting at polish');

    const panel = await openRun(flow, 'gated-loop');
    const loop = panel.getByRole('region', { name: 'Loop polish' });
    const card = loop.getByRole('region', { name: 'Gate polish' });
    await expect(card).toContainText('Still findings after 3 rounds. Go on? (after 3 rounds)');
    // With no `show:`, it shows the last round's handovers, as material.
    await expect(card.locator('.automations-gate-material-label')).toHaveText(
      'material from the run · look.handover',
    );
    await expect(card.locator('.automations-gate-material')).toContainText(
      'the catalog is exported empty',
    );
    await card.getByRole('button', { name: 'Reject', exact: true }).click();

    await expect.poll(() => standing(flow, runId), { timeout: 30_000 }).toBe('rejected');
    await expect(panel.locator('.automations-run-status')).toHaveText('Rejected');
    await expect(panel.locator('.automations-rejected')).toContainText(
      'rejected at `polish` by you',
    );
    // What ran is in the record: `fix` is a command, so the stub claude's log never names it.
    const record = await getRun(flow, runId);
    expect(record.summary).toBe('rejected at polish');
    const steps = stepsOf(record);
    for (const id of ['look', 'fix']) {
      expect(steps[id], id).toMatchObject({ attempt: 3, round: 3, status: 'completed' });
      expect(steps[id].previous?.map((line) => line.round)).toEqual([1, 2]);
    }
    expect(steps.polish).toMatchObject({ status: 'completed', gate: { decision: 'reject' } });
    expect(steps.decide.status).toBe('not-run');
    expect(steps.publish.status).toBe('not-run');
    // `echo published` never ran.
    expect(steps.publish.command).toBeUndefined();
  } finally {
    await flow.close();
  }
});

test('a declared retry waits, then runs the step again', async () => {
  test.setTimeout(180_000);
  // Long enough for the run page to show the wait; the tick resumes it after.
  const flow = await setUpFlow({
    sequence: [{ findings: 0 }],
    env: { CONSOLA_AUTOMATIONS_RETRY_MS: '8000' },
  });
  try {
    await openAutomations(flow.page);
    writeFactory(flow, withFlaky(path.join(flow.base, 'flaky-mark')));
    await runNow(flow, 'gated-loop');
    await startTheRun(flow, 'gated-loop', 1, ['`flaky` retries by itself up to 1 time.']);
    const { id: runId } = await theRun(flow, 'gated-loop');
    await expect.poll(() => standing(flow, runId), { timeout: 30_000 }).toBe('waiting at flaky');
    const panel = await openRun(flow, 'gated-loop');
    const node = stepNode(panel, 'flaky');
    await expect(node).toHaveAccessibleName(/^flaky: Waiting to retry/);
    await expect(node).toContainText('retries at');

    // Its retry runs it again within its wait and a tick, and the run goes on.
    await expect.poll(() => standing(flow, runId), { timeout: 40_000 }).toBe('waiting at decide');
    const steps = stepsOf(await getRun(flow, runId));
    expect(steps.flaky).toMatchObject({ attempt: 2, status: 'completed' });
    expect(steps.flaky.previous?.[0]).toMatchObject({ attempt: 1, status: 'failed' });
    expect(steps.polish).toMatchObject({ status: 'completed', note: 'clean after round 1' });
    await expect(stepNode(panel, 'flaky')).toHaveAccessibleName(/^flaky: Completed/);
  } finally {
    await flow.close();
  }
});

test('a run over its budget stops at the next step, and Retry is refused', async () => {
  test.setTimeout(180_000);
  const flow = await setUpFlow({
    sequence: [{ findings: 1 }],
    env: { STUB_CLAUDE_COST: '0.6' },
  });
  try {
    await openAutomations(flow.page);
    writeFactory(flow, GATED_LOOP);
    await runNow(flow, 'gated-loop');
    await startTheRun(flow, 'gated-loop');
    const { id: runId } = await theRun(flow, 'gated-loop');
    await expect.poll(() => standing(flow, runId), { timeout: 90_000 }).toBe('failed');

    const record = await getRun(flow, runId);
    expect(record.error).toBe(OVER_BUDGET);
    expect(record.costUsd).toBeCloseTo(1.2, 10);
    const steps = stepsOf(record);
    // Round 2's look spent the last of it; the boundary before fix stopped the run.
    expect(steps.look).toMatchObject({ attempt: 2, round: 2, status: 'completed' });
    expect(steps.fix.status).toBe('failed');

    const panel = await openRun(flow, 'gated-loop');
    await panel.getByRole('button', { name: /^Retry from / }).click();
    await expect(panel.getByRole('alert')).toContainText(OVER_BUDGET_RETRY);
    expect((await getRun(flow, runId)).status).toBe('failed');
  } finally {
    await flow.close();
  }
});

test('the gated review asks before it approves, and holds the pull request meanwhile', async () => {
  test.setTimeout(180_000);
  const flow = await setUpFlow({ outputs: { verdict: 'approve' } });
  try {
    await openAutomations(flow.page);
    writeFactory(flow, `${assignedReviewsGatedEntry()}\n${REVIEW_AGAIN}`);
    await fireOn51(flow, GATED_REVIEW);
    await startTheRun(flow, GATED_REVIEW);
    const { id: gatedId } = await theRun(flow, GATED_REVIEW);
    await expect.poll(() => standing(flow, gatedId), { timeout: 90_000 }).toBe('waiting at decide');
    expect(git(flow.checkoutDir, 'rev-parse', 'HEAD')).toBe(flow.head);

    // Only now another automation's run on #51, so the order is fixed.
    await closePanel(flow.page);
    const dashboard = dashboardOf(flow.page);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await rowOf(flow.page, 'review-again')
      .getByRole('button', { name: 'review-again', exact: true })
      .click();
    const page = sidePanel(flow.page);
    await expect(page.getByRole('heading', { name: 'review-again', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run on…' }).click();
    const picker = flow.page.getByRole('dialog', { name: 'Run on an item' });
    await picker
      .getByRole('region', { name: 'In your Inbox' })
      .getByRole('button', { name: /#51/ })
      .click();
    await expect(picker).toHaveCount(0);
    await startTheRun(flow, 'review-again', 2);
    const { id: againId } = await theRun(flow, 'review-again');
    await expect.poll(() => standing(flow, againId), { timeout: 30_000 }).toBe('queued');
    expect((await getRun(flow, againId)).waitingFor).toMatchObject({
      gate: { automation: GATED_REVIEW, run: gatedId, step: 'decide' },
    });
    await expect(runItemOf(flow.page, 'review-again')).toContainText(
      `waiting for you at \`decide\` in \`${GATED_REVIEW}\``,
    );
    // Held: the checkout stays at the head the review read, and nothing was posted.
    expect(git(flow.checkoutDir, 'rev-parse', 'HEAD')).toBe(flow.head);
    expect(flow.posted()).toEqual([]);

    const panel = await openRun(flow, GATED_REVIEW);
    const card = panel.getByRole('region', { name: 'Gate decide' });
    await expect(card).toContainText(
      'The reviewer would approve this pull request. Post the review as an approval?',
    );
    await card.getByRole('button', { name: 'Approve', exact: true }).click();

    await expect.poll(() => standing(flow, gatedId), { timeout: 60_000 }).toBe('completed');
    expect(flow.posted()).toHaveLength(1);
    expect(flow.posted()[0]).toContain('-f event=APPROVE ');
    expect(flow.posted()[0]).toContain(`-f commit_id=${flow.head} `);
    const gated = stepsOf(await getRun(flow, gatedId));
    expect(gated.publish.status).toBe('skipped');
    expect(gated['publish-decided'].status).toBe('completed');
    // The held run goes on once the gate is answered.
    await expect
      .poll(() => standing(flow, againId), { timeout: 60_000 })
      .toMatch(/^(running|completed)$/);
  } finally {
    await flow.close();
  }
});
