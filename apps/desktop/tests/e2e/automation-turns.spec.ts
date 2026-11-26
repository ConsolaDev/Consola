import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../../src/shared/workspace';
import { launchElectron } from './helpers/electron';

/**
 * A step's turn reports itself, end to end: every unattended turn of a step
 * runs with `--output-format stream-json`, its pane shows Consola's lines
 * instead of the JSON, and the run records the CLI's own cost and turns.
 *
 * Nothing here reaches a model. The stub `claude`
 * (`tests/fixtures/claude-steps.cjs`) speaks stream-json when it is given
 * that flag, as the real CLI does, and MCP to Consola's real session
 * endpoint, so a step's handover and outputs arrive the way a real CLI's
 * would. Its knobs (`STUB_CLAUDE_COST`, `STUB_CLAUDE_SUBTYPE`, …) are fixed
 * for the app a test launches, so every turn of one test reports the same
 * figures, unless a cost or turns knob is a comma list, whose n-th value is
 * a conversation's n-th turn's. The engine reads a resumed turn's
 * `total_cost_usd` as the conversation's running total (canary row 14): the
 * reminder scenario reports 0.0015 then 0.003, and the step costs 0.003.
 *
 * The helpers are copied from `automation-steps.spec.ts`, not imported, so
 * each spec runs only its own tests. A pane is read from its remount
 * snapshot (`terminalAPI.create(…).replay`), never from the DOM: what a
 * remounted pane paints is the snapshot, and the DOM holds text only under
 * xterm's DOM renderer.
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

/** What the stub agent writes as its handover unless a test says otherwise. */
const HANDOVER = `## What look found

\`src/catalog.ts:1\`: the catalog is exported empty.
`;

/** The stub's `init` model, cost and turns, when no knob changes them. */
const STUB_MODEL = 'claude-stub-1';
const STUB_COST = 0.0123;
const STUB_TURNS = 3;

/** The stub's limit text (`STUB_CLAUDE_LIMIT=1`), as the CLI words a usage limit. */
const LIMIT_TEXT = "You've hit your limit · resets 3pm (Europe/Madrid)";

/** A cron that is never due (31 February): only Run now starts these. */
const NEVER = '"0 0 31 2 *"';

/** Two prompt steps, the first capped at 6 turns and handing over to the second. */
const CATALOG_NOTES = `- name: catalog-notes
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: look
      prompt: Look over the catalog and write up what is missing.
      max_turns: 6
    - id: tell
      prompt: Turn what look found into a short note for the team.
      reads: [look.handover]`;

/** As above, with a verdict the first step must set. */
const CATALOG_VERDICT = `- name: catalog-verdict
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: look
      prompt: Look over the catalog and give a verdict.
      outputs:
        verdict: { enum: [approve, request-changes] }
      max_turns: 6
    - id: tell
      prompt: Tell the team the verdict.
      reads: [look.handover]`;

/** One prompt step that must set a verdict, with no cap. */
const CATALOG_CHECK = `- name: catalog-check
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: look
      prompt: Look over the catalog and give a verdict.
      outputs:
        verdict: { enum: [approve, request-changes] }`;

/** One plain prompt step each, for watching a session while its turn is held open. */
const WATCHED = `- name: watch-working
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: look
      prompt: Look over the catalog.
- name: watch-waiting
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: look
      prompt: Look over the catalog.`;

/** What a step's reporting turn shows first in its pane: the plan's words. */
const REPORTING_NOTICE =
  'Consola is running this unattended and read-only. Its progress shows here; its findings are on the run page when it finishes. Press Ctrl+C to stop it.';

/** The reminder's prompt for a step that ended without its verdict. */
const REMINDER = 'You ended without: verdict (consola_set_outputs). Set it now; do nothing else.';

/**
 * `look`'s first launch in `catalog-notes`, written out rather than built:
 * slice 1's argv for that step, as the cut's (`c61ec752`)
 * `ClaudeDriver.buildSessionArgs` built it (`-p`, the base, no `--model`,
 * `--mcp-config`, `--settings` with the hooks, `READ_ONLY_ARGS` with its tool
 * list, `-- <prompt>`), plus exactly ` --output-format stream-json --verbose
 * --max-turns 6` after `--settings`. `normalised` puts the four values that
 * change from launch to launch in angle brackets.
 */
function lookLaunch(scope: string): string {
  return [
    `${scope} :: -p --session-id <id>`,
    '--mcp-config <mcp>',
    '--settings <settings>',
    '--output-format stream-json --verbose --max-turns 6',
    '--strict-mcp-config --permission-mode dontAsk --tools Read,Grep,Glob',
    '--allowedTools mcp__consola__consola_work_item_context mcp__consola__consola_list_inbox',
    'mcp__consola__consola_set_outputs mcp__consola__consola_write_artifact',
    'mcp__consola__consola_read_artifact mcp__consola__consola_list_artifacts',
    '--restricted -- <prompt>',
  ].join(' ');
}

/** A logged launch with its conversation id, MCP config path, hook settings and prompt replaced. */
function normalised(launch: string): string {
  const separator = launch.indexOf(' -- ');
  const head = separator === -1 ? launch : launch.slice(0, separator);
  return `${head
    .replace(/ --session-id [0-9a-f-]{36}/, ' --session-id <id>')
    // The config is under the profile's data folder, whose name has a space (`… Test`).
    .replace(/ --mcp-config .+? --settings /, ' --mcp-config <mcp> --settings ')
    .replace(
      / --settings \S+/,
      ' --settings <settings>',
    )}${separator === -1 ? '' : ' -- <prompt>'}`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A file's lines, none when it does not exist. */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
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
  /** Launch environment for this test, over the fixtures' own, or a function of the temp base. */
  env?: Record<string, string> | ((made: { base: string }) => Record<string, string>);
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
  page: Page;
  /** The whole launch environment. */
  env: Record<string, string>;
  /** The `catalog-portal` clone, the workspace's one scope: where its steps run. */
  clone: string;
  factoryDir: string;
  workspaceId: string;
  files: { claudeLog: string; outputs: string; handover: string };
  /** Every line the stub `claude` logged: its launches, `TOOL …`, `HOLD …`, `HOOK …`, and `END …` as each turn ends. */
  claudeLog(): string[];
  /** Only the launches: `<cwd> :: <argv>`. */
  launches(): string[];
  close(): Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, its default harness the stub `claude` (named Stub) with its own
 * config dir, and held in this window.
 */
async function setUpSteps(options: StepsOptions = {}): Promise<Steps> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automation-turns-')));
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
    // Never contacted.
    git(clone, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);

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
      outputs: path.join(base, 'outputs.json'),
      handover: path.join(base, 'handover.md'),
    };
    const none = { nodes: [] };
    fs.writeFileSync(
      files.inbox,
      JSON.stringify({
        data: { direct: none, team: none, authored: none, assigned: none, involved: none },
      }),
    );
    const outputs =
      options.outputs === undefined ? { verdict: 'request-changes' } : options.outputs;
    if (outputs !== null) {
      fs.writeFileSync(
        files.outputs,
        typeof outputs === 'string' ? outputs : JSON.stringify(outputs),
      );
    }
    const handover = options.handover === undefined ? HANDOVER : options.handover;
    if (handover !== null) fs.writeFileSync(files.handover, handover);
    const binaryPath = writeStubClaude(base);

    const env: Record<string, string> = {
      // The stub gh first on the app's own PATH too, so nothing can reach a real gh.
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      GRAPHQL_INBOX_FIXTURE: files.inbox,
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_DIR: factoryDir,
      SHELL: path.join(FIXTURES, 'login-shell.sh'),
      STUB_LOGIN_PATH: STUB_GH_DIR,
      STUB_GH_LOG: files.ghLog,
      STUB_CLAUDE_LOG: files.claudeLog,
      STUB_CLAUDE_OUTPUTS: files.outputs,
      STUB_CLAUDE_HANDOVER: files.handover,
      ...(typeof options.env === 'function' ? options.env({ base }) : (options.env ?? {})),
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

    return {
      page,
      env,
      clone,
      factoryDir,
      workspaceId,
      files,
      claudeLog: () => lines(files.claudeLog),
      launches: () => lines(files.claudeLog).filter((line) => line.includes(' :: ')),
      close,
    };
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

/** The workspace's runs in Activity's list. */
function runItems(page: Page): Locator {
  return dashboardOf(page).locator('.automations-run-item');
}

/**
 * Open the workspace's only run from Activity, into the side panel. A panel
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

/** A step's open detail in the run's trace. */
function stepDetail(panel: Locator, id: string): Locator {
  return panel.getByRole('region', { name: `Step ${id}` });
}

/** Open a step's detail in the trace, when it is not open already. */
async function openStep(panel: Locator, id: string): Promise<Locator> {
  const node = stepNode(panel, id);
  if ((await node.getAttribute('aria-expanded')) !== 'true') await node.click();
  await expect(node).toHaveAttribute('aria-expanded', 'true');
  return stepDetail(panel, id);
}

/** The step's row, then **Open session** in its detail: the step's session, in the main view. */
async function openStepSession(panel: Locator, id: string): Promise<void> {
  const detail = await openStep(panel, id);
  await detail.getByRole('button', { name: 'Open session', exact: true }).click();
}

/**
 * Run now's run, waiting for approval, started: a new `auto` automation asks
 * once, Review… opens the card, Start runs it, and Activity lists it beside
 * the `runs - 1` started before it.
 */
async function startTheRun(steps: Steps, runs = 1): Promise<void> {
  const dashboard = dashboardOf(steps.page);
  const waiting = dashboard.locator('.automations-waiting-card');
  await expect(waiting).toHaveCount(1, { timeout: 30_000 });
  await waiting.getByRole('button', { name: 'Review…' }).click();
  const approval = sidePanel(steps.page).getByRole('region', { name: 'Waiting for your approval' });
  await approval.getByRole('button', { name: 'Start', exact: true }).click();
  await dashboard.getByRole('tab', { name: 'Activity' }).click();
  await expect(runItems(steps.page)).toHaveCount(runs);
}

/** Wait for an automation's row, and press its Run now; a side panel open over the list is closed first. */
async function runNow(steps: Steps, dashboard: Locator, name: string): Promise<void> {
  const panel = sidePanel(steps.page);
  if ((await panel.count()) > 0) {
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toHaveCount(0);
  }
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const row = dashboard.locator('.automations-row', { hasText: name });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.getByRole('button', { name: 'Run now' }).click();
}

/** The workspace's runs, read whole from main, newest first. */
async function allRuns(steps: Steps): Promise<RunRecord[]> {
  return steps.page.evaluate(async (workspaceId) => {
    const { runs } = await window.automationsAPI.getSnapshot(workspaceId);
    const records = await Promise.all(runs.map((run) => window.automationsAPI.getRun(run.id)));
    return records.filter((record): record is RunRecord => record !== null);
  }, steps.workspaceId);
}

/** The workspace's one run, read whole from main. */
async function theRun(steps: Steps): Promise<RunRecord> {
  const runs = await allRuns(steps);
  if (runs.length !== 1) throw new Error(`Expected one run, found ${runs.length}.`);
  return runs[0];
}

/** The workspace's one run of an automation, read whole from main; null before it is made. */
async function runOf(steps: Steps, automation: string): Promise<RunRecord | null> {
  const runs = (await allRuns(steps)).filter((run) => run.automationId === automation);
  if (runs.length > 1) throw new Error(`Expected one run of ${automation}, found ${runs.length}.`);
  return runs[0] ?? null;
}

/** A run's steps by id: each one's record. */
function stepsOf(run: RunRecord): Record<string, StepRun> {
  return Object.fromEntries((run.steps ?? []).map((step) => [step.id, step]));
}

/** Each step's status, by id. */
function statuses(run: RunRecord): Record<string, string> {
  return Object.fromEntries((run.steps ?? []).map((step) => [step.id, step.status]));
}

/** The workspace's factory.yml holding exactly these entries. */
function writeFactory(steps: Steps, entries: string): void {
  const dir = path.join(steps.factoryDir, steps.workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'factory.yml'),
    `version: 1\nautomations:\n${entries.replace(/^/gm, '  ')}\n`,
  );
}

/** What main derives for a session now: `working`, `needs-attention`, … */
async function attentionOf(page: Page, sessionId: string): Promise<string | undefined> {
  return page.evaluate(
    async (id) => (await window.attentionAPI.getSnapshot()).attention[id],
    sessionId,
  );
}

/** Whether, and why, main holds a session stopped on its usage limit. */
async function limitOf(page: Page, sessionId: string) {
  return page.evaluate(
    async (id) => (await window.usageLimitsAPI?.getSnapshot())?.sessions[id] ?? null,
    sessionId,
  );
}

/** The session of a step of a run, its latest attempt's: the one whose provenance names them. */
async function stepSession(page: Page, runId: string, stepId: string): Promise<Session> {
  const found = await page.evaluate(
    async ([run, step]) => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      const sessions = workspaces
        .flatMap((workspace) => workspace.sessions)
        .filter(
          (session) => session.automation?.runId === run && session.automation.step?.id === step,
        );
      sessions.sort(
        (a, b) => (b.automation?.step?.attempt ?? 0) - (a.automation?.step?.attempt ?? 0),
      );
      return sessions[0] ?? null;
    },
    [runId, stepId] as const,
  );
  if (!found) throw new Error(`No session for ${stepId} of ${runId}.`);
  return found;
}

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL | ESC \`) and two-byte escapes: what paints, not what reads. */
const ESCAPES =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-_]/g;

/**
 * What a session's pane shows, read from its remount snapshot with the
 * escape sequences stripped: `TERMINAL_CREATE` on a terminal main still
 * holds returns its replay and starts nothing.
 */
async function paneText(page: Page, session: Session): Promise<string> {
  const replay = await page.evaluate(
    async (s) =>
      (
        await window.terminalAPI.create({
          instanceId: s.instanceId,
          workspaceId: s.workspaceId,
          cwd: s.cwd!,
          claudeSessionId: s.claudeSessionId,
          resume: true,
        })
      ).replay,
    session,
  );
  return replay.replace(ESCAPES, '');
}

/** A pane's lines with something on them, trimmed. */
function paneLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

interface TurnFile {
  turns: Array<{
    endedAt: string;
    exitCode: number;
    stopped?: string;
    maxTurns?: number;
    init?: { type?: string; model?: string };
    result?: { total_cost_usd?: number; num_turns?: number; subtype?: string };
    otherLines: string[];
  }>;
}

/** An attempt's folder in the run folder: its outputs, artifacts and `turn.json`. */
function attemptDir(steps: Steps, runId: string, stepId: string, attempt: number): string {
  return path.join(steps.factoryDir, steps.workspaceId, 'runs', runId, stepId, String(attempt));
}

/** An attempt's `turn.json`, parsed. */
function turnFile(steps: Steps, runId: string, stepId: string, attempt: number): TurnFile {
  return JSON.parse(
    fs.readFileSync(path.join(attemptDir(steps, runId, stepId, attempt), 'turn.json'), 'utf8'),
  ) as TurnFile;
}

test("a step's turn reports: Consola's lines in its pane, cost per step and per run, and its reopen is an ordinary resume", async () => {
  test.setTimeout(180_000);
  // No outputs file: neither step declares an output, so the stub sets none.
  const steps = await setUpSteps({
    outputs: null,
    // The stderr line tries to clear the pane and pass for Consola's dim lines.
    env: {
      STUB_CLAUDE_STDERR: '\x1b[2J\x1b[H\x1b[2mWarning: stub stderr line\x1b[0m',
      STUB_CLAUDE_DENIED: 'Read',
    },
  });
  try {
    const dashboard = await openAutomations(steps.page);
    writeFactory(steps, CATALOG_NOTES);
    await runNow(steps, dashboard, 'catalog-notes');
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 60_000 });

    const launches = steps.launches();
    expect(launches).toHaveLength(2);
    const [look, tell] = launches;
    expect(look).toContain(
      ' --output-format stream-json --verbose --max-turns 6 --strict-mcp-config ',
    );
    expect(look).toContain(' --restricted');
    expect(tell).toContain(' --output-format stream-json --verbose --strict-mcp-config ');
    expect(tell).not.toContain('--max-turns');
    // Slice 1's argv plus exactly the two flags and the cap, written out, never built.
    expect(normalised(look)).toBe(lookLaunch(steps.clone));

    const record = await theRun(steps);
    expect(record.status).toBe('completed');
    const byId = stepsOf(record);
    expect(byId.look).toMatchObject({
      turn: { costUsd: STUB_COST, turns: STUB_TURNS, maxTurns: 6, deniedTools: ['Read'] },
      model: STUB_MODEL,
    });
    expect(byId.tell).toMatchObject({
      turn: { costUsd: STUB_COST, turns: STUB_TURNS, deniedTools: ['Read'] },
      model: STUB_MODEL,
    });
    expect(byId.tell.turn?.maxTurns).toBeUndefined();
    expect(record.costUsd).toBeCloseTo(0.0246, 10);
    const lookTurns = turnFile(steps, record.id, 'look', 1).turns;
    expect(lookTurns).toHaveLength(1);
    expect(lookTurns[0].init?.type).toBe('system');
    expect(lookTurns[0].result?.total_cost_usd).toBe(STUB_COST);
    expect(lookTurns[0].maxTurns).toBe(6);
    expect(lookTurns[0].otherLines).toContain('Warning: stub stderr line');

    // The run page: the run's cost, each step's turns and cost, and look's own facts.
    const panel = await openRun(steps);
    await expect(panel.locator('.automations-run-stats')).toContainText('Cost');
    await expect(panel.locator('.automations-run-stats')).toContainText('$0.0246 est.');
    await expect(stepNode(panel, 'look')).toContainText('3 turns · $0.0123 est.');
    await expect(stepNode(panel, 'tell')).toContainText('3 turns · $0.0123 est.');
    // The row's name is unchanged: `<id>: <outcome>`.
    await expect(stepNode(panel, 'look')).toHaveAccessibleName(/^look: Completed/);
    const lookDetail = await openStep(panel, 'look');
    const turnFact = lookDetail.locator('.automations-fact').filter({ hasText: /^Turn/ });
    await expect(turnFact).toContainText('3 turns of at most 6 · $0.0123 est. · claude-stub-1');
    await expect(turnFact).toContainText('Denied: Read');
    await expect(turnFact).not.toContainText('Earlier attempts');

    // The pane, from its remount snapshot (never the DOM).
    const session = await stepSession(steps.page, record.id, 'look');
    await openStepSession(panel, 'look');
    await expect
      .poll(() => paneText(steps.page, session), { timeout: 15_000 })
      .toContain('Finished: 3 turns, $0.0123 est.');
    const text = await paneText(steps.page, session);
    expect(text).toContain('Its progress shows here');
    expect(text).toContain('→ mcp__consola__consola_write_artifact');
    expect(text).toContain('CLI │ Warning: stub stderr line');
    expect(text).not.toContain('"type":"');
    expect(text).not.toContain('total_cost_usd');
    // Exactly Consola's lines: the notice, one per tool call, what the CLI printed outside JSON
    // (inert, marked as the CLI's), the summary.
    expect(paneLines(text)).toEqual([
      REPORTING_NOTICE,
      '→ mcp__consola__consola_write_artifact',
      'CLI │ Warning: stub stderr line',
      'Finished: 3 turns, $0.0123 est.',
    ]);

    // The reopen: Continue resumes interactively, read-only, with none of the turn's flags.
    const restart = steps.page.locator('.terminal-restart-button');
    await expect(restart).toHaveText('Continue');
    await restart.click();
    await expect.poll(() => steps.launches().length, { timeout: 30_000 }).toBe(3);
    const reopen = steps.launches()[2];
    expect(reopen).toContain(` :: --resume ${session.claudeSessionId} `);
    expect(reopen).toContain(' --restricted');
    for (const flag of [' -p ', '--output-format', '--verbose', '--max-turns']) {
      expect(reopen).not.toContain(flag);
    }
  } finally {
    await steps.close();
  }
});

test('max_turns stops a turn with error_max_turns, with no reminder, and keeps its outputs', async () => {
  test.setTimeout(180_000);
  // The agent sets its verdict, then runs out of turns: the CLI's own `error_max_turns`.
  const steps = await setUpSteps({
    outputs: { verdict: 'approve' },
    env: { STUB_CLAUDE_SUBTYPE: 'error_max_turns', STUB_CLAUDE_TURNS: '6' },
  });
  try {
    const dashboard = await openAutomations(steps.page);
    writeFactory(steps, CATALOG_VERDICT);
    await runNow(steps, dashboard, 'catalog-verdict');
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('failed at look', { timeout: 60_000 });

    // One launch: a turn that hit its cap gets no reminder.
    const launches = steps.launches();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain(' --max-turns 6 ');
    expect(steps.claudeLog().filter((line) => line.startsWith('TOOL consola_set_outputs'))).toEqual(
      ['TOOL consola_set_outputs Set: verdict. Every output is set.'],
    );

    const record = await theRun(steps);
    expect(record.status).toBe('failed');
    expect(statuses(record)).toEqual({ look: 'failed', tell: 'not-run' });
    const look = stepsOf(record).look;
    expect(look.error).toBe('It hit its limit of 6 turns before finishing.');
    expect(look.reminded).toBeFalsy();
    expect(look.outputs).toEqual({ verdict: 'approve' });
    expect(look.turn).toMatchObject({ costUsd: STUB_COST, turns: 6, maxTurns: 6 });
    // What it set is kept in its attempt's folder.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(attemptDir(steps, record.id, 'look', 1), 'outputs.json'), 'utf8'),
      ),
    ).toEqual({ verdict: 'approve' });

    const panel = await openRun(steps);
    // The failed step is open from the start.
    const lookDetail = stepDetail(panel, 'look');
    await expect(
      lookDetail.getByText('It hit its limit of 6 turns before finishing.', { exact: true }),
    ).toBeVisible();
    await expect(
      lookDetail.locator('.automations-vars > li').filter({ hasText: /^verdict = / }),
    ).toHaveText(/^verdict = approve$/);
    await expect(stepNode(panel, 'look')).toContainText('6 turns · $0.0123 est.');

    // Its pane ends with why it ended, as the CLI reported it.
    const first = await stepSession(steps.page, record.id, 'look');
    await expect
      .poll(async () => paneLines(await paneText(steps.page, first)).at(-1), { timeout: 15_000 })
      .toBe('Ended without finishing: it reached its limit of 6 turns (6 turns, $0.0123 est.)');

    // Retry from look: the knob still holds, so the second attempt stops at its cap too.
    await panel.getByRole('button', { name: 'Retry from look', exact: true }).click();
    await expect
      .poll(async () => stepsOf(await theRun(steps)).look.attempt, { timeout: 60_000 })
      .toBe(2);
    await expect.poll(async () => (await theRun(steps)).status, { timeout: 60_000 }).toBe('failed');
    expect(steps.launches()).toHaveLength(2);
    const retried = await theRun(steps);
    const again = stepsOf(retried).look;
    expect(again.error).toBe('It hit its limit of 6 turns before finishing.');
    expect(again.previous).toEqual([
      expect.objectContaining({ attempt: 1, status: 'failed', costUsd: STUB_COST, turns: 6 }),
    ]);
    expect(retried.costUsd).toBeCloseTo(0.0246, 10);

    const rerun = await openRun(steps);
    await expect(rerun.locator('.automations-run-stats')).toContainText('$0.0246 est.');
    const turnFact = stepDetail(rerun, 'look')
      .locator('.automations-fact')
      .filter({ hasText: /^Turn/ });
    await expect(turnFact).toContainText('6 turns of at most 6 · $0.0123 est. · claude-stub-1');
    await expect(turnFact).toContainText('Earlier attempts: 1 $0.0123 est. in 6 turns');
  } finally {
    await steps.close();
  }
});

test('a reminder runs with its own cap, and its cost is added', async () => {
  test.setTimeout(180_000);
  // The first turn sets nothing. The reminder, resumed, waits at the gate
  // before it reads its knobs, so the verdict written between the turns is
  // what it sets, however soon Consola relaunches it. Each turn reports the
  // conversation's running cost, as the real CLI does: 0.0015, then 0.003.
  const steps = await setUpSteps({
    outputs: '',
    env: ({ base }) => ({
      STUB_CLAUDE_RESUME_GATE: path.join(base, 'resume-gate'),
      STUB_CLAUDE_COST: '0.0015,0.003',
    }),
  });
  const gate = steps.env.STUB_CLAUDE_RESUME_GATE;
  try {
    const dashboard = await openAutomations(steps.page);
    writeFactory(steps, CATALOG_CHECK);
    await runNow(steps, dashboard, 'catalog-check');
    await startTheRun(steps);

    // The first turn is over, having set nothing.
    await expect
      .poll(() => steps.claudeLog().filter((line) => line.startsWith('END ')).length, {
        timeout: 60_000,
      })
      .toBe(1);
    fs.writeFileSync(steps.files.outputs, JSON.stringify({ verdict: 'approve' }));
    fs.rmSync(steps.files.handover);
    fs.writeFileSync(gate, '');
    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 60_000 });

    const launches = steps.launches();
    expect(launches).toHaveLength(2);
    const [turn, reminder] = launches;
    // The step has no cap, so its first turn has none; the reminder has its own: 1 + 2 × one missing output.
    expect(turn).toContain(' --output-format stream-json --verbose --strict-mcp-config ');
    expect(turn).not.toContain('--max-turns');
    expect(reminder).toContain(' -p --resume ');
    expect(reminder).toContain(
      ' --output-format stream-json --verbose --max-turns 3 --strict-mcp-config ',
    );
    expect(reminder.endsWith(` -- ${REMINDER}`)).toBe(true);

    const record = await theRun(steps);
    expect(record.status).toBe('completed');
    const look = stepsOf(record).look;
    expect(look.reminded).toBe(true);
    expect(look.outputs).toEqual({ verdict: 'approve' });
    // Turns add up. A resumed print turn's `total_cost_usd` is the
    // conversation's running total, so the reminder's 0.003 is the attempt's
    // cost, not 0.0015 + 0.003.
    expect(look.turn).toEqual({ costUsd: 0.003, turns: 6 });
    expect(look.model).toBe(STUB_MODEL);
    expect(record.costUsd).toBeCloseTo(0.003, 10);
    const turns = turnFile(steps, record.id, 'look', 1).turns;
    expect(turns).toHaveLength(2);
    expect(turns[0].maxTurns).toBeUndefined();
    expect(turns[1].maxTurns).toBe(3);
    expect(turns.map((one) => one.result?.total_cost_usd)).toEqual([0.0015, 0.003]);

    const panel = await openRun(steps);
    const lookDetail = await openStep(panel, 'look');
    const turnFact = lookDetail.locator('.automations-fact').filter({ hasText: /^Turn/ });
    await expect(turnFact).toContainText('6 turns · $0.0030 est. · claude-stub-1');
    await expect(turnFact).not.toContainText('at most');
    await expect(panel.locator('.automations-run-stats')).toContainText('$0.0030 est.');
  } finally {
    await steps.close();
  }
});

test("a step's session still reads working, and waiting on a hook, while its pane shows Consola's lines", async () => {
  test.setTimeout(180_000);
  const steps = await setUpSteps({
    outputs: null,
    env: ({ base }) => ({
      STUB_CLAUDE_HOLD: path.join(base, 'hold'),
      STUB_CLAUDE_HOOKS_FILE: path.join(base, 'hooks.json'),
    }),
  });
  const hold = steps.env.STUB_CLAUDE_HOLD;
  const hooks = steps.env.STUB_CLAUDE_HOOKS_FILE;
  const held = () => steps.claudeLog().filter((line) => line === 'HOLD waiting').length;
  try {
    const dashboard = await openAutomations(steps.page);
    writeFactory(steps, WATCHED);

    // Held after `init`: the turn prints nothing more, and its session reads working.
    await runNow(steps, dashboard, 'watch-working');
    await startTheRun(steps);
    await expect.poll(held, { timeout: 60_000 }).toBe(1);
    const working = await runOf(steps, 'watch-working');
    if (!working) throw new Error('watch-working has no run.');
    const workingSession = await stepSession(steps.page, working.id, 'look');
    await expect
      .poll(() => attentionOf(steps.page, workingSession.id), { timeout: 15_000 })
      .toBe('working');
    // The model is on the running step already: `turnStarted` heard the stub's
    // `init` from the terminal, through main, while the turn is still going (the
    // turn's report, which also names it, comes only at its end).
    const runningLook = async () => {
      const run = await runOf(steps, 'watch-working');
      const look = run ? stepsOf(run).look : undefined;
      return { status: look?.status, model: look?.model, turn: look?.turn };
    };
    await expect
      .poll(runningLook, { timeout: 15_000 })
      .toEqual({ status: 'running', model: STUB_MODEL, turn: undefined });
    fs.writeFileSync(hold, '');
    await expect
      .poll(async () => (await runOf(steps, 'watch-working'))?.status, { timeout: 60_000 })
      .toBe('completed');
    expect(steps.claudeLog()).toContain('HOLD open');

    // A PermissionRequest hook during the turn: the session waits on the person.
    fs.rmSync(hold);
    fs.writeFileSync(hooks, JSON.stringify(['PermissionRequest']));
    await runNow(steps, dashboard, 'watch-waiting');
    await startTheRun(steps, 2);
    await expect.poll(held, { timeout: 60_000 }).toBe(2);
    const waiting = await runOf(steps, 'watch-waiting');
    if (!waiting) throw new Error('watch-waiting has no run.');
    const waitingSession = await stepSession(steps.page, waiting.id, 'look');
    expect(steps.claudeLog()).toContain('HOOK PermissionRequest 200');
    await expect
      .poll(() => attentionOf(steps.page, waitingSession.id), { timeout: 15_000 })
      .toBe('needs-attention');
    fs.writeFileSync(hold, '');
    await expect
      .poll(async () => (await runOf(steps, 'watch-waiting'))?.status, { timeout: 60_000 })
      .toBe('completed');
  } finally {
    await steps.close();
  }
});

test("a usage limit is still reported for a step's session", async () => {
  test.setTimeout(180_000);
  const steps = await setUpSteps({
    outputs: null,
    env: ({ base }) => ({
      STUB_CLAUDE_LIMIT: '1',
      STUB_CLAUDE_HOOKS_FILE: path.join(base, 'hooks.json'),
    }),
  });
  try {
    // The CLI's own StopFailure, with the error Claude names a usage limit by.
    fs.writeFileSync(steps.env.STUB_CLAUDE_HOOKS_FILE, JSON.stringify(['StopFailure:rate_limit']));
    const dashboard = await openAutomations(steps.page);
    writeFactory(steps, CATALOG_CHECK);
    await runNow(steps, dashboard, 'catalog-check');
    await startTheRun(steps);
    await expect(runItems(steps.page)).toContainText('failed at look', { timeout: 60_000 });

    // The CLI said it stopped on its limit: no reminder, and the step says why.
    expect(steps.launches()).toHaveLength(1);
    expect(steps.claudeLog()).toContain('HOOK StopFailure 200');
    const record = await theRun(steps);
    const look = stepsOf(record).look;
    expect(look.error).toBe(`It stopped before finishing: ${LIMIT_TEXT}.`);
    expect(look.reminded).toBeFalsy();

    // Main holds the session limited, from the hook.
    const session = await stepSession(steps.page, record.id, 'look');
    await expect
      .poll(async () => (await limitOf(steps.page, session.id))?.signal, { timeout: 15_000 })
      .toBe('hook');

    // Its pane: the limit's strip above the terminal, and the turn's own last line.
    const panel = await openRun(steps);
    await openStepSession(panel, 'look');
    const notice = steps.page.locator('.usage-limit-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Stopped on its usage limit');
    await expect
      .poll(async () => paneLines(await paneText(steps.page, session)).at(-1), { timeout: 15_000 })
      .toBe(`Ended without finishing: ${LIMIT_TEXT} (3 turns, $0.0123 est.)`);
  } finally {
    await steps.close();
  }
});

test('a harness whose extra args pin --max-turns refuses steps, and says why', async () => {
  test.setTimeout(120_000);
  const steps = await setUpSteps({ outputs: null });
  try {
    await steps.page.evaluate(() =>
      window.harnessStateAPI.updateHarness('stub', { extraArgs: ['--max-turns', '50'] }),
    );
    const dashboard = await openAutomations(steps.page);
    writeFactory(steps, CATALOG_NOTES);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    const row = dashboard.locator('.automations-row', { hasText: 'catalog-notes' });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    const why =
      "Stub can’t run automation steps: This harness's extra arguments set `--max-turns`, which would " +
      "override what Consola launches each step's turn with. Remove it in Settings › Harnesses.";
    // The problem names the entry's line in factory.yml: `- name: catalog-notes` is line 3.
    await expect(row.locator('.automations-row-problem')).toHaveText(
      `Not running: ${why} (line 3)`,
    );
    await expect(row.getByRole('button', { name: 'Run now' })).toBeDisabled();

    // Main refuses it too, in the same words, and nothing launches.
    const refused = await steps.page.evaluate(
      async (workspaceId) =>
        window.automationsAPI.runNow(workspaceId, 'catalog-notes').then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      steps.workspaceId,
    );
    expect(refused).toContain(`catalog-notes cannot run: ${why}`);
    expect(await allRuns(steps)).toEqual([]);
    expect(steps.launches()).toEqual([]);
  } finally {
    await steps.close();
  }
});

test("a window cannot give a session a turn cap, a tool policy, a provenance or an agent's grants", async () => {
  test.setTimeout(120_000);
  const steps = await setUpSteps({ outputs: null });
  try {
    // Made as a window makes one, with the four fields only main may set.
    const stored = await steps.page.evaluate(async (workspaceId) => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      const scopeId = workspaces.find((workspace) => workspace.id === workspaceId)!.scopes[0].id;
      const created = await window.workspaceAPI.createSession(workspaceId, {
        name: 'Made by a window',
        workspaceId,
        instanceId: 'made-by-a-window',
        harnessId: 'stub',
        scopeId,
        maxTurns: 3,
        toolPolicy: 'read-only',
        automation: {
          runId: 'run-x',
          automationId: 'catalog-notes',
          step: { id: 'look', attempt: 1 },
        },
        grants: {
          driverId: 'claude',
          servers: [{ name: 'grafana' }],
          skills: [],
          strict: true,
          allowedTools: ['mcp__grafana__*'],
        },
      } as never);
      const after = await window.workspaceAPI.getSnapshot();
      return {
        created,
        record:
          after.workspaces
            .flatMap((workspace) => workspace.sessions)
            .find((session) => session.instanceId === 'made-by-a-window') ?? null,
      };
    }, steps.workspaceId);
    expect(stored.record).toMatchObject({ name: 'Made by a window' });
    for (const field of ['maxTurns', 'toolPolicy', 'automation', 'grants']) {
      expect(stored.created).not.toHaveProperty(field);
      expect(stored.record).not.toHaveProperty(field);
    }
  } finally {
    await steps.close();
  }
});
