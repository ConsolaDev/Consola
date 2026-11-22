import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../../src/shared/workspace';
import { launchElectron } from './helpers/electron';

/**
 * A factory folder's agents, end to end: an automation file whose steps name
 * agent files runs each step on its agent's harness and model with the
 * agent's body in its prompt; the folder applies as a unit, so a broken file
 * keeps the last applied version running, under a banner, across a restart;
 * a removal always applies; an agent that names servers or skills is refused
 * until 2-C; a harness turned off stops an unchanged entry and holds back a
 * changed one; and a slice-1 file beside agent files runs exactly as before.
 *
 * Nothing here reaches a model. The stub `claude`
 * (`tests/fixtures/claude-steps.cjs`) speaks stream-json and MCP as the real
 * CLI does. The workspace's default harness is the stub (`stub`); the
 * agents' harness, `stub-personal`, runs the same stub through a second
 * wrapper that first logs `PERSONAL <argv>` (line breaks flattened) to the
 * same log, so a launch on it shows as a `PERSONAL` line beside the stub's
 * own `<cwd> :: <argv>` line.
 *
 * The helpers are copied from `automation-turns.spec.ts` (and the relaunch
 * from `automation-steps.spec.ts`), not imported, so each spec runs only its
 * own tests. No step here declares an output, so every setup writes no
 * outputs file. Each scenario launches its own app on its own temp base, and
 * `close()` closes whichever app is current and removes all of it.
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

/** A cron that is never due (31 February): only Run now starts these. */
const NEVER = '"0 0 31 2 *"';

/** Two prompt steps, the first capped at 6 turns and handing over to the second: slice 1, no agent. */
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

const REVIEWER_FILE = 'agents/reviewer.md';
const NOTER_FILE = 'agents/noter.md';
const CATALOG_AGENTS_FILE = 'automations/catalog-agents.yaml';
const OLD_DIGEST_FILE = 'automations/old-digest.yaml';

/** The reviewer: its description, harness, model and cap, then its body. */
function reviewer(body = 'REVIEWER-BODY-1', extra = ''): string {
  return `---\ndescription: Reviews catalog-portal's changes.\nharness: stub-personal\nmodel: haiku\nmax_turns: 4\n${extra}---\n${body}: read what changed in catalog-portal and write it up.\n`;
}

/** A body-only agent: every key at its default, the default harness. */
const NOTER = 'Write a short note for the team. NOTER-BODY-1\n';

/** `look` runs as the reviewer alone; `tell` as the noter with a prompt of its own and a cap. */
function catalogAgents(tellPrompt = 'Turn the handover into a note.'): string {
  return `on: { cron: ${NEVER} }
scope: catalog-portal
mode: auto
steps:
  - id: look
    agent: reviewer
  - id: tell
    agent: noter
    prompt: ${tellPrompt}
    reads: [look.handover]
    max_turns: 2
`;
}

const CATALOG_WATCH_FILE = 'automations/catalog-watch.yaml';
/** A poll whose check finds nothing (it never runs before Allow), and whose one step runs as the reviewer. */
const CATALOG_WATCH = `on:
  poll:
    every: 1h
    run: printf '[]'
    key: .id
scope: catalog-portal
mode: auto
steps:
  - id: look
    agent: reviewer
`;

const OLD_DIGEST = `on: { cron: ${NEVER} }
scope: catalog-portal
mode: auto
steps:
  - id: digest
    prompt: Write the weekly digest of catalog-portal.
`;

/** The banner's time: `HH:MM` today. */
const AT = '\\d\\d:\\d\\d';

/** A broken agent file counts twice: its own problem, and the reference in the entry that names it (Task 7). */
const BROKEN_REVIEWER_BANNER = new RegExp(
  `^Your changes didn't apply: 2 problems in agents/reviewer\\.md and automations/catalog-agents\\.yaml\\. The version from ${AT} keeps running\\.$`,
);

const WRITE_TOOLS = 'Write tools arrive with write steps; an agent is read-only until then.';
const SERVERS_LATER = 'Servers and skills for agents arrive with the next update';
const TURNED_OFF =
  '`stub-personal` is turned off: turn it on in Settings › Harnesses, or change `harness:`';

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

interface Steps {
  app: ElectronApplication;
  page: Page;
  base: string;
  /** The profile, under `base`; main keeps its data in `${userDataDir} Test`, also under `base`. */
  userDataDir: string;
  /** The whole launch environment, for relaunching on the same profile. */
  env: Record<string, string>;
  /** The default harness's wrapper. */
  binaryPath: string;
  /** The `catalog-portal` clone, the workspace's one scope: where its steps run. */
  clone: string;
  factoryDir: string;
  workspaceId: string;
  files: { claudeLog: string; handover: string };
  /** Every line the stub `claude` logged, `PERSONAL …` lines included. */
  claudeLog(): string[];
  /** Only the stub's launches: `<cwd> :: <argv>`, on either harness. */
  launches(): string[];
  close(): Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, its default harness the stub `claude` (named Stub) with its own
 * config dir, and held in this window. No outputs file: no step declares one.
 */
async function setUpSteps(): Promise<Steps> {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automation-agents-')),
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
    fs.writeFileSync(files.handover, HANDOVER);
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
      binaryPath,
      clone,
      factoryDir,
      workspaceId,
      files,
      claudeLog: () => lines(files.claudeLog),
      launches: () => lines(files.claudeLog).filter((line) => line.includes(' :: ')),
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

/** Quit, then launch again on the same profile and environment; the window reopens where it was left. */
async function relaunch(steps: Steps): Promise<void> {
  await steps.app.close();
  const relaunched = await launchElectron({ userDataDir: steps.userDataDir, env: steps.env });
  steps.app = relaunched.app;
  steps.page = relaunched.page;
}

/**
 * The agents' harness, `stub-personal`: the same stub, through a wrapper that
 * first logs `PERSONAL <argv>` (line breaks flattened), with a config dir of
 * its own, so its conversations' transcripts are written there.
 */
async function addPersonalHarness(steps: Steps): Promise<string> {
  const wrapper = path.join(steps.base, 'claude-personal.sh');
  fs.writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      `printf 'PERSONAL %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> "$STUB_CLAUDE_LOG"`,
      `exec '${process.execPath}' '${path.join(FIXTURES, 'claude-steps.cjs')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const configDir = path.join(steps.base, 'claude-personal-config');
  fs.mkdirSync(configDir, { recursive: true });
  await steps.page.evaluate(
    async ([binary, harnessConfigDir]) => {
      await window.harnessStateAPI.addHarness({
        id: 'stub-personal',
        driverId: 'claude',
        name: 'Personal stub',
        accentColor: '#777777',
        binaryPath: binary,
        configDir: harnessConfigDir,
      });
    },
    [wrapper, configDir] as const,
  );
  return configDir;
}

/** The launches on `stub-personal`: its wrapper's lines, less the health and capability probes. */
function personalLaunches(steps: Steps): string[] {
  return steps
    .claudeLog()
    .filter(
      (line) =>
        line.startsWith('PERSONAL ') &&
        !line.startsWith('PERSONAL --version') &&
        !line.includes('--input-format'),
    );
}

/** The workspace's factory folder. */
function folderOf(steps: Steps): string {
  return path.join(steps.factoryDir, steps.workspaceId);
}

/**
 * Write one file of the folder whole, atomically (written beside the base,
 * then renamed in, as an editor that saves by renaming does), or delete it
 * (null). Agent files go in before the entries that name them, so the poll
 * never reads an entry without its agent.
 */
function writeFactoryFile(steps: Steps, relative: string, text: string | null): void {
  const file = path.join(folderOf(steps), relative);
  if (text === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(steps.base, `.write-${path.basename(relative)}`);
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

/** The agent files, then the automation file that names them. */
function writeAgentFiles(steps: Steps, reviewerText = reviewer()): void {
  writeFactoryFile(steps, REVIEWER_FILE, reviewerText);
  writeFactoryFile(steps, NOTER_FILE, NOTER);
  writeFactoryFile(steps, CATALOG_AGENTS_FILE, catalogAgents());
}

/** The workspace's automations, issues, notices and standing, as main has them now. */
async function snapshotOf(steps: Steps) {
  return steps.page.evaluate(
    (workspaceId) => window.automationsAPI.getSnapshot(workspaceId),
    steps.workspaceId,
  );
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

/** After a relaunch: the dashboard, which the window reopens on, or opened from the sidebar. */
async function dashboardAfterRelaunch(page: Page): Promise<Locator> {
  const dashboard = dashboardOf(page);
  const heading = dashboard.getByRole('heading', { name: 'Automations · Sprocket' });
  try {
    await expect(heading).toBeVisible({ timeout: 30_000 });
    return dashboard;
  } catch {
    return openAutomations(page);
  }
}

/** The side panel, over the dashboard. */
function sidePanel(page: Page): Locator {
  return page.locator('.automations-side-panel');
}

/** Close the side panel when one is open. */
async function closePanel(page: Page): Promise<void> {
  const panel = sidePanel(page);
  if ((await panel.count()) > 0) {
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toHaveCount(0);
  }
}

/** The workspace's runs in Activity's list. */
function runItems(page: Page): Locator {
  return dashboardOf(page).locator('.automations-run-item');
}

/** An automation's row in the Automations tab. */
function rowOf(page: Page, name: string): Locator {
  return dashboardOf(page).locator('.automations-row', { hasText: name });
}

/** The banner while the folder does not apply. */
function bannerOf(page: Page): Locator {
  return dashboardOf(page).locator('.automations-standing');
}

/** One file's group in the issue list. */
function issueGroup(page: Page, file: string): Locator {
  return dashboardOf(page)
    .locator('.automations-issues-file')
    .filter({ has: page.locator('.automations-issues-file-head code', { hasText: file }) });
}

/** An automation's page in the side panel, from its row. */
async function openAutomation(steps: Steps, name: string): Promise<Locator> {
  await closePanel(steps.page);
  const dashboard = dashboardOf(steps.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  await rowOf(steps.page, name).getByRole('button', { name, exact: true }).click();
  const panel = sidePanel(steps.page);
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  return panel;
}

/**
 * Open the workspace's only run from Activity, into the side panel. A panel
 * already open is closed first, so the run's page mounts afresh and reads
 * everything it shows again.
 */
async function openRun(steps: Steps): Promise<Locator> {
  await closePanel(steps.page);
  await dashboardOf(steps.page).getByRole('tab', { name: 'Activity' }).click();
  await expect(runItems(steps.page)).toHaveCount(1);
  await runItems(steps.page).click();
  const panel = sidePanel(steps.page);
  await expect(panel.getByRole('list', { name: 'Steps of this run' })).toBeVisible();
  return panel;
}

/** A step's row in the run's trace: its header, a button named `<id>: <outcome>` that opens it. */
function stepNode(panel: Locator, id: string): Locator {
  return panel
    .getByRole('list', { name: 'Steps of this run' })
    .getByRole('button', { name: new RegExp(`^${id}: `) });
}

/** A step's open detail in the trace. */
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

/** The run waiting for approval: Review… opens its card in the side panel. */
async function reviewTheRun(steps: Steps): Promise<Locator> {
  const dashboard = dashboardOf(steps.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const waiting = dashboard.locator('.automations-waiting-card');
  await expect(waiting).toHaveCount(1, { timeout: 30_000 });
  await waiting.getByRole('button', { name: 'Review…' }).click();
  const approval = sidePanel(steps.page).getByRole('region', { name: 'Waiting for your approval' });
  await expect(approval.locator('.automations-approval-step').first()).toBeVisible({
    timeout: 15_000,
  });
  return approval;
}

/** Start the reviewed run, and see Activity list it beside the `runs - 1` started before it. */
async function start(steps: Steps, approval: Locator, runs = 1): Promise<void> {
  await approval.getByRole('button', { name: 'Start', exact: true }).click();
  await dashboardOf(steps.page).getByRole('tab', { name: 'Activity' }).click();
  await expect(runItems(steps.page)).toHaveCount(runs);
}

/**
 * Run now's run, waiting for approval, started: a new `auto` automation asks
 * once, Review… opens the card, Start runs it, and Activity lists it beside
 * the `runs - 1` started before it.
 */
async function startTheRun(steps: Steps, runs = 1): Promise<void> {
  await start(steps, await reviewTheRun(steps), runs);
}

/** One step's card in the approval, by its id. */
function approvalStepOf(approval: Locator, id: string): Locator {
  return approval
    .locator('.automations-approval-step')
    .filter({ has: approval.page().locator('.automations-approval-id', { hasText: id }) });
}

/** Wait for an automation's row, and press its Run now; a side panel open over the list is closed first. */
async function runNow(steps: Steps, dashboard: Locator, name: string): Promise<void> {
  await closePanel(steps.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const row = rowOf(steps.page, name);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled({ timeout: 15_000 });
  await row.getByRole('button', { name: 'Run now' }).click();
}

/** Every run of the workspace, ended, before the next: `count` items, none of them still going. */
async function runsSettled(steps: Steps, count: number): Promise<void> {
  await dashboardOf(steps.page).getByRole('tab', { name: 'Activity' }).click();
  await expect(runItems(steps.page)).toHaveCount(count, { timeout: 30_000 });
  await expect
    .poll(async () => (await allRuns(steps)).filter((run) => run.status === 'completed').length, {
      timeout: 60_000,
    })
    .toBe(count);
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

/** A run's steps by id: each one's record. */
function stepsOf(run: RunRecord): Record<string, StepRun> {
  return Object.fromEntries((run.steps ?? []).map((step) => [step.id, step]));
}

/** The workspace's factory.yml holding exactly these entries. */
function writeFactory(steps: Steps, entries: string): void {
  const dir = folderOf(steps);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'factory.yml'),
    `version: 1\nautomations:\n${entries.replace(/^/gm, '  ')}\n`,
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

/** The newest run's waiting definition: what its approval would start. */
async function newestDefinition(steps: Steps) {
  return steps.page.evaluate(async (workspaceId) => {
    const { runs } = await window.automationsAPI.getSnapshot(workspaceId);
    return runs[0] ? window.automationsAPI.getRunDefinition(runs[0].id) : null;
  }, steps.workspaceId);
}

test('an agent file applies: its step runs on its harness and model, with its body in the prompt', async () => {
  test.setTimeout(300_000);
  const steps = await setUpSteps();
  try {
    const personalConfig = await addPersonalHarness(steps);
    const dashboard = await openAutomations(steps.page);
    writeAgentFiles(steps);

    // The row, from its own file; its pipeline names each step's agent.
    await expect(rowOf(steps.page, 'catalog-agents')).toHaveCount(1, { timeout: 15_000 });
    await expect(rowOf(steps.page, 'catalog-agents')).toContainText(
      'automations/catalog-agents.yaml:1',
    );
    const page = await openAutomation(steps, 'catalog-agents');
    await expect(page.locator('.automations-lead-file')).toHaveText(
      'automations/catalog-agents.yaml:1',
    );
    const pipeline = page.getByRole('list', { name: 'Pipeline' });
    await expect(pipeline).toContainText('reviewer · stub-personal · haiku');
    await expect(pipeline.locator('.automations-node-agent')).toHaveText(['noter']);
    expect((await snapshotOf(steps)).standing).toBeUndefined();

    // The approval card shows each step's agent, as approved; look has no empty prompt.
    await runNow(steps, dashboard, 'catalog-agents');
    const approval = await reviewTheRun(steps);
    const look = approvalStepOf(approval, 'look');
    const lookAgent = look.locator('.automations-approval-field').filter({ hasText: /^agent/ });
    await expect(lookAgent.locator('.automations-approval-label')).toHaveText('agent');
    await expect(lookAgent).toContainText('reviewer · stub-personal · haiku');
    await expect(look).toContainText("Reviews catalog-portal's changes.");
    await expect(look.locator('.automations-prompt')).toHaveCount(1);
    await expect(look.locator('.automations-prompt')).toContainText('REVIEWER-BODY-1');
    await expect(look).not.toContainText('The prompt it will send');
    const tell = approvalStepOf(approval, 'tell');
    const tellAgent = tell.locator('.automations-approval-field').filter({ hasText: /^agent/ });
    await expect(tellAgent).toContainText('noter');
    await expect(tellAgent).not.toContainText('·');
    // The agent first, then the step's own prompt.
    const tellTexts = tell.locator('.automations-prompt');
    await expect(tellTexts).toHaveCount(2);
    await expect(tellTexts.nth(0)).toContainText('NOTER-BODY-1');
    await expect(tellTexts.nth(1)).toContainText('Turn the handover into a note.');
    await start(steps, approval);
    await expect(runItems(steps.page)).toContainText('Completed', { timeout: 90_000 });

    // look launched on the agent's harness, with its model, its cap and its body; tell on the default.
    const launches = steps.launches();
    expect(launches).toHaveLength(2);
    const [lookLaunch, tellLaunch] = launches;
    const personal = personalLaunches(steps);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toContain('Your standing instructions (agents/reviewer.md):');
    for (const part of [
      ' --model haiku ',
      ' --max-turns 4 ',
      'Your standing instructions (agents/reviewer.md):',
      'REVIEWER-BODY-1',
    ])
      expect(lookLaunch).toContain(part);
    expect(lookLaunch).not.toContain('This step:');
    for (const part of [
      ' --max-turns 2 ',
      'Your standing instructions (agents/noter.md):',
      'NOTER-BODY-1',
      'This step:',
      'Turn the handover into a note.',
    ])
      expect(tellLaunch).toContain(part);
    expect(tellLaunch).not.toContain('--model');

    const record = await theRun(steps);
    expect(record.status).toBe('completed');
    const byId = stepsOf(record);
    expect(byId.look.agent).toBe('reviewer');
    expect(byId.tell.agent).toBe('noter');
    expect(byId.look.conversation?.harnessId).toBe('stub-personal');
    expect(byId.tell.conversation?.harnessId).toBe('stub');
    expect(byId.look.turn?.maxTurns).toBe(4);
    expect(byId.tell.turn?.maxTurns).toBe(2);
    // The transcript is under the agent harness's own config dir.
    expect(
      fs.existsSync(
        path.join(personalConfig, 'projects', 'p', `${byId.look.conversation?.id}.jsonl`),
      ),
    ).toBe(true);

    // The step detail names the agent and its conversation's harness.
    const panel = await openRun(steps);
    const lookDetail = await openStep(panel, 'look');
    await expect(
      lookDetail.locator('.automations-fact').filter({ hasText: /^Agent/ }),
    ).toContainText('reviewer · stub-personal');

    // Continue: an interactive resume on the same harness and model, read-only.
    const session = await stepSession(steps.page, record.id, 'look');
    await openStepSession(panel, 'look');
    const restart = steps.page.locator('.terminal-restart-button');
    await expect(restart).toHaveText('Continue');
    await restart.click();
    await expect.poll(() => steps.launches().length, { timeout: 30_000 }).toBe(3);
    const reopen = steps.launches()[2];
    expect(reopen).toContain(` :: --resume ${session.claudeSessionId} `);
    expect(reopen).toContain(' --model haiku ');
    expect(reopen).toContain(' --restricted');
    expect(reopen).not.toContain(' -p ');
    expect(personalLaunches(steps)).toHaveLength(2);

    // A relaunch's reopen goes through TERMINAL_CREATE: the record's harness and model, whatever a window sends.
    await openAutomations(steps.page);
    await relaunch(steps);
    await dashboardAfterRelaunch(steps.page);
    await steps.page.waitForTimeout(3000);
    const before = steps.launches().length;
    const personalBefore = personalLaunches(steps).length;
    expect(steps.launches().slice(3)).toEqual([]);
    const after = await stepSession(steps.page, record.id, 'look');
    await steps.page.evaluate(
      (s) =>
        window.terminalAPI.create({
          instanceId: s.instanceId,
          workspaceId: s.workspaceId,
          cwd: s.cwd!,
          claudeSessionId: s.claudeSessionId,
          resume: true,
          model: 'opus',
        }),
      after,
    );
    await expect.poll(() => steps.launches().length, { timeout: 30_000 }).toBe(before + 1);
    const recreated = steps.launches()[before];
    expect(recreated).toContain(` :: --resume ${session.claudeSessionId} `);
    expect(recreated).toContain(' --model haiku ');
    expect(recreated).not.toContain('--model opus');
    expect(personalLaunches(steps)).toHaveLength(personalBefore + 1);
    expect(personalLaunches(steps).at(-1)).toContain(`--resume ${session.claudeSessionId} `);
  } finally {
    await steps.close();
  }
});

test('a broken agent file keeps the last applied version, with the banner; a fix applies and asks again', async () => {
  test.setTimeout(360_000);
  const steps = await setUpSteps();
  try {
    await addPersonalHarness(steps);
    let dashboard = await openAutomations(steps.page);
    writeAgentFiles(steps);
    await runNow(steps, dashboard, 'catalog-agents');
    await startTheRun(steps);
    await runsSettled(steps, 1);

    // The agent asks for write tools: the folder does not apply, and the version from before runs.
    // Its time is a fixed whole second, kept through the fix below, so only Check again sees that.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    const broken = reviewer('REVIEWER-BODY-2', 'tools: write\n');
    writeFactoryFile(steps, REVIEWER_FILE, broken);
    const reviewerPath = path.join(folderOf(steps), REVIEWER_FILE);
    fs.utimesSync(reviewerPath, pinned, pinned);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await expect(bannerOf(steps.page)).toHaveCount(1, { timeout: 15_000 });
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      BROKEN_REVIEWER_BANNER,
    );
    const words = await bannerOf(steps.page).locator('.automations-standing-text').textContent();
    await expect(dashboard.locator('.automations-issues-title')).toHaveText(
      'What keeps your changes from applying',
    );
    await expect(issueGroup(steps.page, REVIEWER_FILE)).toContainText(WRITE_TOOLS);
    await expect(issueGroup(steps.page, CATALOG_AGENTS_FILE)).toContainText(
      '`reviewer` has problems of its own in agents/reviewer.md',
    );
    // The entry as written is the version that runs.
    const entryPage = await openAutomation(steps, 'catalog-agents');
    await entryPage.getByRole('button', { name: 'YAML', exact: true }).click();
    await expect(entryPage.locator('.automations-entry')).toContainText(
      'This is the version that runs; your edits have not applied.',
    );
    await closePanel(steps.page);

    // Run now runs at once (its acceptance holds), on the body that applied.
    await runNow(steps, dashboard, 'catalog-agents');
    await expect.poll(() => personalLaunches(steps).length, { timeout: 30_000 }).toBe(2);
    expect(personalLaunches(steps)[1]).toContain('REVIEWER-BODY-1');
    expect(personalLaunches(steps)[1]).not.toContain('REVIEWER-BODY-2');
    await expect(dashboard.locator('.automations-waiting-card')).toHaveCount(0);
    await runsSettled(steps, 2);

    // Across a restart, through the desktop's own store: the same banner, the same body.
    await relaunch(steps);
    dashboard = await dashboardAfterRelaunch(steps.page);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      words ?? '',
      { timeout: 30_000 },
    );
    await runNow(steps, dashboard, 'catalog-agents');
    await expect.poll(() => personalLaunches(steps).length, { timeout: 30_000 }).toBe(3);
    expect(personalLaunches(steps)[2]).toContain('REVIEWER-BODY-1');
    expect(personalLaunches(steps)[2]).not.toContain('REVIEWER-BODY-2');
    await runsSettled(steps, 3);

    // The fix, written in place at the same size and time: the poll cannot see it; Check again does.
    const fixed = broken.replace('tools: write\n', '#tools:write\n');
    expect(fixed.length).toBe(broken.length);
    fs.writeFileSync(reviewerPath, fixed);
    fs.utimesSync(reviewerPath, pinned, pinned);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await steps.page.waitForTimeout(5000);
    await expect(bannerOf(steps.page)).toHaveCount(1);
    await bannerOf(steps.page).getByRole('button', { name: 'Check again' }).click();
    await expect(bannerOf(steps.page)).toHaveCount(0, { timeout: 15_000 });
    expect((await snapshotOf(steps)).standing).toBeUndefined();

    // The version changed: Run now asks again, and its card shows the new body.
    await runNow(steps, dashboard, 'catalog-agents');
    const approval = await reviewTheRun(steps);
    await expect(approvalStepOf(approval, 'look').locator('.automations-prompt')).toContainText(
      'REVIEWER-BODY-2',
    );
    await start(steps, approval, 4);
    await expect.poll(() => personalLaunches(steps).length, { timeout: 30_000 }).toBe(4);
    expect(personalLaunches(steps)[3]).toContain('REVIEWER-BODY-2');
  } finally {
    await steps.close();
  }
});

test('while the folder does not apply, the Allow card shows the agent as the version that runs (review B1)', async () => {
  test.setTimeout(240_000);
  const steps = await setUpSteps();
  try {
    await addPersonalHarness(steps);
    await openAutomations(steps.page);
    // A poll entry whose step runs as the reviewer: it waits for Allow, at the version with body 1.
    writeFactoryFile(steps, REVIEWER_FILE, reviewer('REVIEWER-BODY-1'));
    writeFactoryFile(steps, NOTER_FILE, NOTER);
    writeFactoryFile(steps, CATALOG_WATCH_FILE, CATALOG_WATCH);
    await expect(rowOf(steps.page, 'catalog-watch')).toHaveCount(1, { timeout: 15_000 });
    await expect
      .poll(async () => (await snapshotOf(steps)).automations[0]?.needsAllow, { timeout: 15_000 })
      .toBe(true);
    const listed = (await snapshotOf(steps)).automations[0].version;

    // Another file breaks, so the folder keeps that version; then the reviewer is rewritten.
    writeFactoryFile(steps, NOTER_FILE, `---\ntools: write\n---\n${NOTER}`);
    await expect(bannerOf(steps.page)).toHaveCount(1, { timeout: 15_000 });
    writeFactoryFile(steps, REVIEWER_FILE, reviewer('REVIEWER-BODY-2'));
    await expect
      .poll(() => fs.readFileSync(path.join(folderOf(steps), REVIEWER_FILE), 'utf8'), {
        timeout: 5_000,
      })
      .toContain('REVIEWER-BODY-2');
    await steps.page.waitForTimeout(5000);
    expect((await snapshotOf(steps)).automations[0].version).toBe(listed);

    // The card shows the body Allow accepts, the running version's, and says so; Open is the file as it is now.
    const panel = await openAutomation(steps, 'catalog-watch');
    const card = panel.getByRole('region', { name: 'Allow catalog-watch' });
    const agent = card.locator('.automations-allow-agent', { hasText: REVIEWER_FILE });
    await agent.locator('summary', { hasText: REVIEWER_FILE }).click();
    await expect(agent.locator('.automations-prompt')).toContainText('REVIEWER-BODY-1');
    await expect(agent.locator('.automations-prompt')).not.toContainText('REVIEWER-BODY-2');
    await expect(agent).toContainText("Reviews catalog-portal's changes.");
    await expect(agent.locator('.automations-entry-note')).toHaveText(
      'This is the version that runs; your edits have not applied.',
    );
    await expect(
      agent.getByRole('button', { name: `Open as it is now: ${REVIEWER_FILE}`, exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Open as it is now', exact: true }),
    ).toBeVisible();

    // Allow accepts exactly that version.
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect
      .poll(async () => (await snapshotOf(steps)).automations[0]?.needsAllow, { timeout: 15_000 })
      .toBeUndefined();
  } finally {
    await steps.close();
  }
});

test('removing an automation always applies, even beside a broken file', async () => {
  test.setTimeout(240_000);
  const steps = await setUpSteps();
  try {
    await addPersonalHarness(steps);
    const dashboard = await openAutomations(steps.page);
    writeAgentFiles(steps);
    writeFactoryFile(steps, OLD_DIGEST_FILE, OLD_DIGEST);
    await expect(rowOf(steps.page, 'catalog-agents')).toHaveCount(1, { timeout: 15_000 });
    await expect(rowOf(steps.page, 'old-digest')).toHaveCount(1, { timeout: 15_000 });
    expect((await snapshotOf(steps)).standing).toBeUndefined();

    writeFactoryFile(steps, REVIEWER_FILE, reviewer('REVIEWER-BODY-1', 'tools: write\n'));
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      BROKEN_REVIEWER_BANNER,
      { timeout: 15_000 },
    );
    writeFactoryFile(steps, OLD_DIGEST_FILE, null);
    await expect(rowOf(steps.page, 'old-digest')).toHaveCount(0, { timeout: 15_000 });
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      new RegExp(
        `^\`old-digest\` was removed\\. The rest of your changes didn't apply: 2 problems in agents/reviewer\\.md and automations/catalog-agents\\.yaml\\. The version from ${AT} keeps running\\.$`,
      ),
    );
    await expect(rowOf(steps.page, 'catalog-agents')).toHaveCount(1);
    expect((await snapshotOf(steps)).standing?.removed).toEqual(['old-digest']);
    expect(dashboard).toBeTruthy();
  } finally {
    await steps.close();
  }
});

test('an agent that names servers or skills is refused, and says why', async () => {
  test.setTimeout(240_000);
  const steps = await setUpSteps();
  try {
    await addPersonalHarness(steps);
    // A first start: the folder has never applied (no applied version), as on an upgrade.
    await steps.app.close();
    writeAgentFiles(steps, reviewer('REVIEWER-BODY-1', 'mcpServers: [notion]\n'));
    // The empty folder applied when the workspace was made; its kept version goes.
    const store = path.join(`${steps.userDataDir} Test`, 'factory-applied');
    expect(fs.readdirSync(store)).toHaveLength(1);
    fs.rmSync(store, { recursive: true, force: true });
    const relaunched = await launchElectron({ userDataDir: steps.userDataDir, env: steps.env });
    steps.app = relaunched.app;
    steps.page = relaunched.page;
    const railButton = steps.page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Sprocket', exact: true });
    await railButton.click();
    const dashboard = await openAutomations(steps.page);

    // Entry by entry: catalog-agents is listed, with its agent's problem, and runs nothing.
    const row = rowOf(steps.page, 'catalog-agents');
    await expect(row).toContainText(`Not running: agents/reviewer.md: ${SERVERS_LATER}`, {
      timeout: 15_000,
    });
    await expect(row.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect((await snapshotOf(steps)).standing).toBeUndefined();
    await steps.page.waitForTimeout(2000);
    expect(steps.launches()).toEqual([]);

    // From a clean apply, the same edit is held back: the banner, and why, at the agent's file.
    writeFactoryFile(steps, REVIEWER_FILE, reviewer());
    await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled({ timeout: 15_000 });
    expect((await snapshotOf(steps)).standing).toBeUndefined();
    writeFactoryFile(steps, REVIEWER_FILE, reviewer('REVIEWER-BODY-1', 'mcpServers: [notion]\n'));
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      new RegExp(
        `^Your changes didn't apply: 1 problem in agents/reviewer\\.md\\. The version from ${AT} keeps running\\.$`,
      ),
      { timeout: 15_000 },
    );
    await expect(issueGroup(steps.page, REVIEWER_FILE)).toContainText(
      `agents/reviewer.md: ${SERVERS_LATER}`,
    );
    expect(dashboard).toBeTruthy();
    expect(steps.launches()).toEqual([]);
  } finally {
    await steps.close();
  }
});

test('a harness turned off stops an unchanged entry and holds back a changed one', async () => {
  test.setTimeout(240_000);
  const steps = await setUpSteps();
  try {
    await addPersonalHarness(steps);
    const dashboard = await openAutomations(steps.page);
    writeAgentFiles(steps);
    const row = rowOf(steps.page, 'catalog-agents');
    await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled({ timeout: 15_000 });
    expect((await snapshotOf(steps)).standing).toBeUndefined();

    // Unchanged: the entry's own problem, and nothing runs.
    await steps.page.evaluate(() =>
      window.harnessStateAPI.updateHarness('stub-personal', { enabled: false }),
    );
    await expect(row).toContainText(`Not running: agents/reviewer.md: ${TURNED_OFF}`, {
      timeout: 15_000,
    });
    await expect(row.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect((await snapshotOf(steps)).standing).toBeUndefined();

    // Changed while it is off: held back, at the agent's file.
    writeFactoryFile(steps, CATALOG_AGENTS_FILE, catalogAgents('Turn the handover into a memo.'));
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      new RegExp(
        `^Your changes didn't apply: 1 problem in agents/reviewer\\.md\\. The version from ${AT} keeps running\\.$`,
      ),
      { timeout: 15_000 },
    );
    await expect(issueGroup(steps.page, REVIEWER_FILE)).toContainText(TURNED_OFF);

    // On again: it applies, and the next run carries the edit.
    await steps.page.evaluate(() =>
      window.harnessStateAPI.updateHarness('stub-personal', { enabled: true }),
    );
    await expect(bannerOf(steps.page)).toHaveCount(0, { timeout: 15_000 });
    await runNow(steps, dashboard, 'catalog-agents');
    await reviewTheRun(steps);
    const definition = await newestDefinition(steps);
    const tellStep = definition?.automation.steps.find((step) => step.id === 'tell');
    expect(tellStep && 'prompt' in tellStep ? tellStep.prompt : undefined).toBe(
      'Turn the handover into a memo.',
    );
    expect(steps.launches()).toEqual([]);
  } finally {
    await steps.close();
  }
});

test('slice 1 untouched beside agent files', async () => {
  test.setTimeout(300_000);
  const steps = await setUpSteps();
  try {
    const dashboard = await openAutomations(steps.page);
    writeFactory(steps, CATALOG_NOTES);
    await runNow(steps, dashboard, 'catalog-notes');
    await startTheRun(steps);
    await runsSettled(steps, 1);

    // Agent files arrive beside it; catalog-notes' version does not move.
    await addPersonalHarness(steps);
    writeAgentFiles(steps);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await expect(rowOf(steps.page, 'catalog-agents')).toHaveCount(1, { timeout: 15_000 });
    expect((await snapshotOf(steps)).standing).toBeUndefined();
    await runNow(steps, dashboard, 'catalog-notes');
    await expect.poll(() => steps.launches().length, { timeout: 30_000 }).toBeGreaterThan(2);
    await expect(dashboard.locator('.automations-waiting-card')).toHaveCount(0);
    await runsSettled(steps, 2);

    const launches = steps.launches();
    expect(launches).toHaveLength(4);
    for (const launch of launches) {
      expect(launch).not.toContain('--model');
      expect(launch).not.toContain('Your standing instructions');
    }
    expect(personalLaunches(steps)).toEqual([]);
    const runs = await allRuns(steps);
    expect(runs).toHaveLength(2);
    expect(runs[0].actionVersion).toBe(runs[1].actionVersion);
  } finally {
    await steps.close();
  }
});
