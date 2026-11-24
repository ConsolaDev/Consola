import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../../src/shared/workspace';
import { MOVED_ROW_PRESS_MS } from '../../src/renderer/sidebar/shiftGuard';
import { launchElectron } from './helpers/electron';

/**
 * An agent's MCP servers and skills, end to end (phase 2-C): north-star
 * §4.2's investigator in its stub form, naming a claude.ai connector, a user
 * server narrowed to one tool and a skill, on one harness, beside a summariser
 * on another; a probe that fails and Check again on the entry it stopped; a
 * server that needs a sign-in, or that the CLI no longer loads, failing its
 * step before anything posts; a step on someone else's pull request offered
 * connectors only; and the refusals at apply, where nothing launches.
 *
 * Nothing here reaches a model or a real CLI. Two harnesses run the stub
 * `claude` (`tests/fixtures/claude-steps.cjs`) through wrappers that first log
 * `WORK <argv>` or `PERSONAL <argv>` (line breaks flattened) to the stub's
 * log, then export their own knobs: `STUB_CLAUDE_MCP` (the servers each
 * profile has, as the CLI would report and load them) and
 * `STUB_CLAUDE_COMMANDS` (the skills and commands its `initialize` lists).
 * Each harness's config dir holds a `.claude.json`, which Consola only passes
 * on (`--mcp-config`) and the stub reads as "user servers load".
 *
 * The helpers are copied from `automation-turns.spec.ts`,
 * `automation-sources.spec.ts` and `automation-agents.spec.ts`, not imported,
 * so each spec runs only its own tests. Each scenario launches its own app on
 * its own temp base, and `close()` removes all of it.
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

/** The engine's tick in these tests, in milliseconds. */
const TICK_MS = 2000;

/** A cron that is never due (31 February): only Run now starts these. */
const NEVER = '"0 0 31 2 *"';

/** What every stub agent writes as its handover. */
const HANDOVER = `## catalog-portal 5xx spike

The 14:02 deploy of the cart service raised 5xx to 9%. Roll it back, then page bob.
`;

const STUB_COST = 0.0123;

/** Every MCP server the stub profiles have: two connectors, two user servers. */
const SERVERS = [
  {
    name: 'claude.ai Coralogix',
    scope: 'claudeai',
    type: 'claudeai-proxy',
    url: 'https://mcp.coralogix.example/mcp',
    status: 'connected',
    tools: ['query_logs', 'list_alerts'],
  },
  {
    name: 'claude.ai Slack',
    scope: 'claudeai',
    type: 'claudeai-proxy',
    url: 'https://mcp.slack.example/mcp',
    status: 'connected',
    tools: ['post_message'],
  },
  {
    name: 'grafana',
    scope: 'dynamic',
    type: 'stdio',
    status: 'connected',
    tools: ['query_logs', 'list_dashboards'],
  },
  {
    name: 'tracker',
    scope: 'dynamic',
    type: 'http',
    url: 'https://tracker.example/mcp',
    status: 'connected',
    tools: ['search'],
  },
];
const CORALOGIX_URL = 'https://mcp.coralogix.example/mcp';

const INVESTIGATOR_FILE = 'agents/investigator.md';
const SUMMARISER_FILE = 'agents/summariser.md';
const TRIAGE_FILE = 'skills/incident-triage/SKILL.md';
const QUERIES_FILE = 'skills/incident-triage/queries.md';
const INVESTIGATE_FILE = 'automations/investigate-alerts.yaml';
const INVESTIGATE = 'investigate-alerts';

/** The investigator: a connector, a user server narrowed to one tool, a skill. */
function investigator(body = 'INVESTIGATOR-BODY-1'): string {
  return `---
description: Investigates production alerts for the catalog-portal services.
harness: stub-work
model: opus
mcpServers:
  - claude.ai Coralogix
  - grafana: [query_logs]
skills: [incident-triage]
max_turns: 40
---
${body}: start from the alert's query; end with cause, impact and the next action.
`;
}

const SUMMARISER = `---
description: Writes short replies for alert threads.
harness: stub-personal
model: haiku
---
SUMMARISER-BODY-1: plain sentences, the action first.
`;

const TRIAGE = `---
name: incident-triage
description: The team's triage checklist for catalog-portal alerts.
---
TRIAGE-SKILL-1: check the last deploy first; see queries.md.
`;
const QUERIES_1 = 'QUERIES-1: rate(http_5xx[5m])\n';
const QUERIES_2 = 'QUERIES-2: rate(http_5xx[1m])\n';
const RELEASE_NOTES = `---
name: release-notes
description: How catalog-portal's release notes are written.
---
RELEASE-NOTES-1: one line per change.
`;

const ALERT_TITLE = 'catalog-portal 5xx spike';
const ALERTS = JSON.stringify([
  { ts: '1763800000.000100', channel: 'C0ALERTS01', title: ALERT_TITLE },
]);

/** A poll with `key:` and `scope:`: every run carries an alert someone else wrote. */
function investigateAlerts(base: string): string {
  return `on:
  poll:
    every: 5m
    run: printf '%s' '${ALERTS}'
    key: .ts
scope: catalog-portal
mode: auto
steps:
  - id: investigate
    agent: investigator
    outputs:
      severity: { enum: [noise, low, high] }
  - id: summarise
    if: steps.investigate.severity != 'noise'
    agent: summariser
    prompt: Write the reply for the alert's thread, in at most eight lines.
    reads: [investigate.handover]
    max_turns: 6
  - id: reply
    if: steps.investigate.severity != 'noise'
    run: cat "$BODY_FILE" >> ${path.join(base, 'replies.log')}
    env: { BODY_FILE: "{{steps.summarise.handover.file}}" }
`;
}

/** What `investigate`'s `init` check says while Coralogix needs a sign-in. */
const CORALOGIX_SIGN_IN =
  '`claude.ai Coralogix` was not connected (needs-auth). Sign in to it in Work stub (run `claude`, then /mcp), then retry this step.';
const GRAFANA_NOT_LOADED =
  '`grafana` was not loaded: it was removed from Work stub, or it is blocked by its URL.';
const CORALOGIX_NEEDS_AUTH =
  '`claude.ai Coralogix` needs you to sign in again in Work stub: run `claude`, then /mcp.';
const SWITCH_REFUSED =
  "This step's session stays on its agent's harness while its run is open. Switch it once the run has ended.";
const ITEM_TEXT_LINE = 'This agent reads text other people wrote, with these tools at hand.';

/** The person's own server, refused on an item step: the driver's words. */
function ownFile(name: string): string {
  return `\`${name}\` comes from Work stub's own settings, and a step on someone else's pull request or issue starts it, or a helper command it runs for its sign-in, inside the author's checkout, where \`npx\`, \`uvx\` or a relative path can run the author's code. On item steps, use a claude.ai connector; this server works in scheduled steps.`;
}

/** The banner's time: `HH:MM` today. */
const AT = '\\d\\d:\\d\\d';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A file's lines, none when it does not exist. */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** A wrapper that runs the test runner's own Node on a fixture: `node` is not on the app's PATH. */
function writeNodeWrapper(file: string, fixture: string, prelude: string[] = []): string {
  fs.writeFileSync(
    file,
    ['#!/bin/sh', ...prelude, `exec '${process.execPath}' '${fixture}' "$@"`, ''].join('\n'),
    { mode: 0o755 },
  );
  return file;
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

interface SetUpOptions {
  /** The pull requests the Inbox holds from the start, by number. */
  inbox?: number[];
}

interface Steps {
  app: ElectronApplication;
  page: Page;
  base: string;
  /** The `catalog-portal` clone, the workspace's one scope. */
  clone: string;
  /** #51's automation checkout: where a step on it runs. */
  checkoutDir: string;
  factoryDir: string;
  workspaceId: string;
  files: { claudeLog: string; mcp: string; replies: string; hold: string };
  /** Every line the stub `claude` and the wrappers logged. */
  claudeLog(): string[];
  /** The servers every stub profile has, written whole. */
  writeServers(servers: ReadonlyArray<Record<string, unknown>>): void;
  close(): Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, its default harness the plain stub (named Stub), held in this
 * window. The clone's origin is #51's repository and `pr-51` is one commit
 * ahead of `main` (`setUpSources`' clone). No outputs file: each harness's
 * wrapper says its own. No servers file yet: each scenario writes it, or not.
 */
async function setUpSteps(options: SetUpOptions = {}): Promise<Steps> {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automation-servers-')),
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
      handover: path.join(base, 'handover.md'),
      prHead: path.join(base, 'pr-51-head'),
      mcp: path.join(base, 'mcp.json'),
      replies: path.join(base, 'replies.log'),
      hold: path.join(base, 'hold-summarise'),
    };
    const none = { nodes: [] };
    fs.writeFileSync(
      files.inbox,
      JSON.stringify({
        data: {
          direct: { nodes: (options.inbox ?? []).map(requestedPull) },
          team: none,
          authored: none,
          assigned: none,
          involved: none,
        },
      }),
    );
    fs.writeFileSync(files.handover, HANDOVER);
    fs.writeFileSync(files.prHead, `${head}\n`);
    const binaryPath = writeNodeWrapper(
      path.join(base, 'claude.sh'),
      path.join(FIXTURES, 'claude-steps.cjs'),
    );

    const env: Record<string, string> = {
      // The stub gh first on the app's own PATH too, so nothing can reach a real gh.
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
      STUB_GH_LOG: files.ghLog,
      STUB_GH_POSTED: files.ghPosted,
      STUB_CLAUDE_LOG: files.claudeLog,
      STUB_CLAUDE_HANDOVER: files.handover,
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
        // The built-in harness too, so nothing it is asked (a switch's preview asks every
        // harness for its usage limits) can reach the ambient CLI.
        await window.harnessStateAPI.updateHarness('default', { binaryPath: binary });
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
      clone,
      checkoutDir: path.join(worktreesDir, 'catalog-portal-pr-51-automation'),
      factoryDir,
      workspaceId,
      files,
      claudeLog: () => lines(files.claudeLog),
      writeServers: (servers) => {
        // Written beside, then renamed in: a probe never reads half a file.
        const temporary = `${files.mcp}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(servers));
        fs.renameSync(temporary, files.mcp);
      },
      close,
    };
    return steps;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/**
 * A harness on the stub (`automation-agents.spec.ts`' `addPersonalHarness`,
 * generalised): `<base>/claude-<mark>.sh` appends `<MARK> ` and its
 * flattened arguments to `$STUB_CLAUDE_LOG`, exports `env` and unsets
 * `unset`, then execs the same Node on the same fixture. Its config dir holds
 * a `.claude.json` of `{}`, which Consola only passes on.
 */
async function addHarness(
  steps: Steps,
  harness: {
    id: string;
    name: string;
    mark: string;
    env?: Record<string, string>;
    unset?: string[];
    driverId?: 'claude' | 'codex';
  },
): Promise<string> {
  const configDir = path.join(steps.base, `${harness.id}-config`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.claude.json'), '{}');
  const prelude = [
    ...Object.entries(harness.env ?? {}).map(([name, value]) => `export ${name}='${value}'`),
    ...(harness.unset ?? []).map((name) => `unset ${name}`),
    `printf '${harness.mark} %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> "$STUB_CLAUDE_LOG"`,
  ];
  const fixture =
    harness.driverId === 'codex'
      ? path.join(FIXTURES, 'codex.cjs')
      : path.join(FIXTURES, 'claude-steps.cjs');
  const wrapper = writeNodeWrapper(
    path.join(steps.base, `claude-${harness.mark.toLowerCase()}.sh`),
    fixture,
    prelude,
  );
  await steps.page.evaluate(
    async ([id, name, driverId, binary, harnessConfigDir]) => {
      await window.harnessStateAPI.addHarness({
        id,
        driverId,
        name,
        accentColor: '#777777',
        binaryPath: binary,
        configDir: harnessConfigDir,
      });
    },
    [harness.id, harness.name, harness.driverId ?? 'claude', wrapper, configDir] as const,
  );
  return configDir;
}

/**
 * The two stub harnesses every scenario uses: Work stub (`WORK`), whose
 * agent sets `severity: high` (the investigator's output; `outputs: false`
 * for a step that declares none, which has no tool to set one), and Personal
 * stub (`PERSONAL`), which sets no outputs. `hold` holds Personal stub's turns after their `init` until the
 * test writes that file.
 */
async function addStubHarnesses(
  steps: Steps,
  options: { hold?: boolean; outputs?: boolean } = {},
): Promise<{ workConfig: string; personalConfig: string }> {
  const outputs = path.join(steps.base, 'outputs-work.json');
  fs.writeFileSync(outputs, JSON.stringify({ severity: 'high' }));
  const knobs = {
    STUB_CLAUDE_MCP: steps.files.mcp,
    STUB_CLAUDE_COMMANDS: 'dataviz,simplify,clear',
  };
  const workConfig = await addHarness(steps, {
    id: 'stub-work',
    name: 'Work stub',
    mark: 'WORK',
    env: { ...knobs, ...(options.outputs === false ? {} : { STUB_CLAUDE_OUTPUTS: outputs }) },
    unset: options.outputs === false ? ['STUB_CLAUDE_OUTPUTS'] : [],
  });
  const personalConfig = await addHarness(steps, {
    id: 'stub-personal',
    name: 'Personal stub',
    mark: 'PERSONAL',
    env: { ...knobs, ...(options.hold ? { STUB_CLAUDE_HOLD: steps.files.hold } : {}) },
    unset: ['STUB_CLAUDE_OUTPUTS'],
  });
  return { workConfig, personalConfig };
}

/** A harness's launches: its wrapper's lines, less the health probe and every control-protocol ask. */
function launchesOf(steps: Steps, mark: string): string[] {
  return steps
    .claudeLog()
    .filter(
      (line) =>
        line.startsWith(`${mark} `) &&
        !line.startsWith(`${mark} --version`) &&
        !line.includes('--input-format'),
    );
}

/** The control requests the stub answered: `CONTROL <subtype> in <cwd> with <argv>`. */
function controls(steps: Steps, subtype: string): string[] {
  return steps.claudeLog().filter((line) => line.startsWith(`CONTROL ${subtype} in `));
}

/** The workspace's factory folder. */
function folderOf(steps: Steps): string {
  return path.join(steps.factoryDir, steps.workspaceId);
}

/**
 * Write one file of the folder whole, atomically (written beside the base,
 * then renamed in), or delete it (null). Agent and skill files go in before
 * the entries that name them.
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

/** The investigator's factory: its two agents, its skill (and one nothing names), then its entry. */
function writeInvestigator(steps: Steps): void {
  writeFactoryFile(steps, TRIAGE_FILE, TRIAGE);
  writeFactoryFile(steps, QUERIES_FILE, QUERIES_1);
  writeFactoryFile(steps, 'skills/release-notes/SKILL.md', RELEASE_NOTES);
  writeFactoryFile(steps, INVESTIGATOR_FILE, investigator());
  writeFactoryFile(steps, SUMMARISER_FILE, SUMMARISER);
  writeFactoryFile(steps, INVESTIGATE_FILE, investigateAlerts(steps.base));
}

/** The workspace's automations, issues, notices and standing, as main has them now. */
async function snapshotOf(steps: Steps) {
  return steps.page.evaluate(
    (workspaceId) => window.automationsAPI.getSnapshot(workspaceId),
    steps.workspaceId,
  );
}

/** An automation as main lists it now. */
async function viewOf(steps: Steps, name: string) {
  return (await snapshotOf(steps)).automations.find((automation) => automation.name === name);
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

/** An automation's page's pipeline node for one step, by its id. */
function pipelineNode(panel: Locator, id: string): Locator {
  return panel
    .getByRole('list', { name: 'Pipeline' })
    .locator('.automations-node')
    .filter({ has: panel.page().locator('.automations-node-code', { hasText: id }) });
}

/** Open the workspace's only run from Activity, into the side panel, mounted afresh. */
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

/** Open a step's detail in the trace, when it is not open already. */
async function openStep(panel: Locator, id: string): Promise<Locator> {
  const node = stepNode(panel, id);
  if ((await node.getAttribute('aria-expanded')) !== 'true') await node.click();
  await expect(node).toHaveAttribute('aria-expanded', 'true');
  return panel.getByRole('region', { name: `Step ${id}` });
}

/** A fact of an open step detail, by its label. */
function factOf(detail: Locator, label: string): Locator {
  return detail
    .locator('.automations-fact')
    .filter({ has: detail.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) });
}

/** The step's row, then **Open session** in its detail: the step's session, in the main view. */
async function openStepSession(panel: Locator, id: string): Promise<void> {
  const detail = await openStep(panel, id);
  await detail.getByRole('button', { name: 'Open session', exact: true }).click();
}

/** The run waiting for approval: Review… opens its card in the side panel. */
async function reviewTheRun(steps: Steps): Promise<Locator> {
  await closePanel(steps.page);
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

/** One step's card in the approval, by its id. */
function approvalStepOf(approval: Locator, id: string): Locator {
  return approval
    .locator('.automations-approval-step')
    .filter({ has: approval.page().locator('.automations-approval-id', { hasText: id }) });
}

/** An automation's check, as main has it now. */
async function checkOf(steps: Steps, name: string) {
  return (await viewOf(steps, name))?.check;
}

/** Allow on the automation's page, then its first check: it records what is there and fires nothing. */
async function allow(steps: Steps, name: string): Promise<void> {
  const panel = await openAutomation(steps, name);
  await panel
    .getByRole('region', { name: `Allow ${name}` })
    .getByRole('button', { name: 'Allow', exact: true })
    .click();
  await expect
    .poll(async () => (await checkOf(steps, name))?.lastAt, { timeout: 15_000 })
    .toBeTruthy();
}

/** Run on… the alert, from its last check: a run starts and opens in the panel. */
async function runOnTheAlert(steps: Steps, name: string): Promise<void> {
  const panel = await openAutomation(steps, name);
  await panel.getByRole('button', { name: 'Run on…' }).click();
  const picker = steps.page.getByRole('dialog', { name: 'Run on an item' });
  const row = picker
    .getByRole('region', { name: 'In its last check' })
    .getByRole('button', { name: new RegExp(ALERT_TITLE) });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(picker).toHaveCount(0);
}

/** The workspace's runs, read whole from main, newest first. */
async function allRuns(steps: Steps): Promise<RunRecord[]> {
  return steps.page.evaluate(async (workspaceId) => {
    const { runs } = await window.automationsAPI.getSnapshot(workspaceId);
    const records = await Promise.all(runs.map((run) => window.automationsAPI.getRun(run.id)));
    return records.filter((record): record is RunRecord => record !== null);
  }, steps.workspaceId);
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
function statuses(run: RunRecord | null): Record<string, string> {
  return Object.fromEntries((run?.steps ?? []).map((step) => [step.id, step.status]));
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

interface TurnFile {
  turns: Array<{
    init?: { type?: string; mcp_servers?: Array<{ name: string; status: string }> };
    result?: { total_cost_usd?: number };
  }>;
}

/** An attempt's folder in the run folder: its outputs, artifacts, plugin and `turn.json`. */
function attemptDir(steps: Steps, runId: string, stepId: string, attempt: number): string {
  return path.join(folderOf(steps), 'runs', runId, stepId, String(attempt));
}

/** An attempt's `turn.json`, parsed. */
function turnFile(steps: Steps, runId: string, stepId: string, attempt: number): TurnFile {
  return JSON.parse(
    fs.readFileSync(path.join(attemptDir(steps, runId, stepId, attempt), 'turn.json'), 'utf8'),
  ) as TurnFile;
}

/** The one `--settings` value of a logged launch, parsed. */
function settingsOf(launch: string): { hooks?: unknown; allowedMcpServers?: unknown } {
  const values = [...launch.matchAll(/ --settings (\S+)/g)].map((match) => match[1]);
  expect(values).toHaveLength(1);
  return JSON.parse(values[0]);
}

/**
 * Right-click a sidebar row once the list has left it where it is for longer
 * than the sidebar's shift guard holds a row it moved (`MOVED_ROW_PRESS_MS`,
 * `automation-sources.spec.ts`' `clickWhenRowSettles`).
 */
async function rightClickWhenSettled(row: Locator): Promise<void> {
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
  await row.click({ button: 'right' });
}

test('the investigator: a connector and a user server, a skill and its deny list, on two harnesses', async () => {
  test.setTimeout(360_000);
  const steps = await setUpSteps();
  try {
    steps.writeServers(SERVERS);
    const { workConfig } = await addStubHarnesses(steps, { hold: true });
    await openAutomations(steps.page);
    writeInvestigator(steps);

    // It applies once Work stub's CLI said which servers it has: asked from home, never the checkout.
    const row = rowOf(steps.page, INVESTIGATE);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.locator('.automations-row-file')).toHaveText(`${INVESTIGATE_FILE}:1`, {
      timeout: 30_000,
    });
    await expect(row.locator('.automations-row-problem')).toHaveCount(0);
    expect((await snapshotOf(steps)).standing).toBeUndefined();
    const home = fs.realpathSync(os.homedir());
    const asked = controls(steps, 'mcp_status');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]).toContain(`CONTROL mcp_status in ${home} with `);
    expect(asked[0]).toContain('--restricted');
    expect(asked[0]).toContain(`--mcp-config ${path.join(workConfig, '.claude.json')}`);

    // Its pipeline: each agent with its harness and model; the investigator's servers and skill (review S2, S3).
    const page = await openAutomation(steps, INVESTIGATE);
    const investigateNode = pipelineNode(page, 'investigate');
    await expect(investigateNode).toContainText('investigator · stub-work · opus');
    await expect(investigateNode.locator('.automations-node-agent')).toHaveText(
      'claude.ai Coralogix · grafana (query_logs) · skills: incident-triage',
    );
    await expect(investigateNode).toContainText(
      'Read-only but for its servers, in a session of its own',
    );
    const summariseNode = pipelineNode(page, 'summarise');
    await expect(summariseNode).toContainText('summariser · stub-personal · haiku');
    await expect(summariseNode).toContainText('Read-only, in a session of its own');
    await expect(summariseNode).not.toContainText('but for its servers');

    // The Allow card: both bodies, what each server grants, the skill with its Open, and the item line.
    const card = page.getByRole('region', { name: `Allow ${INVESTIGATE}` });
    const investigatorCard = card.locator('.automations-allow-agent', {
      hasText: INVESTIGATOR_FILE,
    });
    const summariserCard = card.locator('.automations-allow-agent', { hasText: SUMMARISER_FILE });
    await expect(
      investigatorCard.locator('.automations-allow-agent-body .automations-prompt'),
    ).toContainText('INVESTIGATOR-BODY-1', { timeout: 15_000 });
    await expect(summariserCard.locator('.automations-prompt')).toContainText('SUMMARISER-BODY-1');
    await expect(investigatorCard).toContainText(
      'claude.ai Coralogix: all its tools (query_logs, list_alerts), including any that post or change things',
    );
    await expect(investigatorCard).toContainText('grafana: query_logs only');
    await expect(investigatorCard).toContainText('Skills: incident-triage');
    // Its SKILL.md as the version Allow accepts holds it, folded like the body (review M4).
    await expect(
      investigatorCard.locator('.automations-allow-skill', { hasText: TRIAGE_FILE }),
    ).toContainText('TRIAGE-SKILL-1: check the last deploy first');
    await expect(
      investigatorCard.getByRole('button', {
        name: 'Open skills/incident-triage/SKILL.md',
        exact: true,
      }),
    ).toBeVisible();
    await expect(summariserCard).not.toContainText('all its tools');
    await expect(card.getByText(ITEM_TEXT_LINE, { exact: true })).toHaveCount(1);

    // The investigator's body changes while the card is open: the card shows the new one (review S1).
    const listed = (await viewOf(steps, INVESTIGATE))?.version;
    writeFactoryFile(steps, INVESTIGATOR_FILE, investigator('INVESTIGATOR-BODY-2'));
    await expect
      .poll(async () => (await viewOf(steps, INVESTIGATE))?.version, { timeout: 30_000 })
      .not.toBe(listed);
    await expect(
      investigatorCard.locator('.automations-allow-agent-body .automations-prompt'),
    ).toContainText('INVESTIGATOR-BODY-2', { timeout: 15_000 });
    await expect(
      investigatorCard.locator('.automations-allow-agent-body .automations-prompt'),
    ).not.toContainText('INVESTIGATOR-BODY-1');
    await allow(steps, INVESTIGATE);
    expect(await viewOf(steps, INVESTIGATE)).not.toHaveProperty('needsAllow');
    expect(await checkOf(steps, INVESTIGATE)).toMatchObject({ baseline: true, items: 1 });

    // Run on… the alert.
    await runOnTheAlert(steps, INVESTIGATE);
    await expect.poll(() => launchesOf(steps, 'WORK').length, { timeout: 60_000 }).toBe(1);
    const run = (await runOf(steps, INVESTIGATE))!;
    const attempt1 = attemptDir(steps, run.id, 'investigate', 1);
    const pluginDir = path.join(attempt1, 'plugin');

    // investigate's launch: its servers allowed by name or URL, strict dropped for the connector,
    // the account file passed on, the narrowed tool, the skill and its deny list, its cap.
    const [investigate] = launchesOf(steps, 'WORK');
    expect(investigate).toContain(' -p ');
    expect(investigate).toContain(' --model opus ');
    expect(investigate).toMatch(
      new RegExp(` --mcp-config .+ ${path.join(workConfig, '.claude.json')} --settings `),
    );
    const settings = settingsOf(investigate);
    expect(settings.hooks).toBeDefined();
    expect(settings.allowedMcpServers).toEqual([
      { serverName: 'consola' },
      { serverUrl: CORALOGIX_URL },
      { serverName: 'grafana' },
    ]);
    expect(investigate).toContain(` --plugin-dir ${pluginDir} --add-dir ${pluginDir} `);
    expect(investigate).toContain(' --tools Read,Grep,Glob,Skill ');
    expect(investigate).toContain(' mcp__claude_ai_Coralogix__* ');
    expect(investigate).toContain(' mcp__grafana__query_logs ');
    expect(investigate).toContain(
      ' Skill(consola-step:incident-triage) --disallowedTools Skill(dataviz) Skill(simplify) Skill(clear) --restricted',
    );
    expect(investigate).toContain(' --max-turns 40 ');
    expect(investigate).not.toContain('--strict-mcp-config');
    expect(investigate).not.toContain('mcp__grafana__*');
    // The granted skill is allowed, never denied: nothing between `--disallowedTools` and the prompt names it.
    const denied = investigate.slice(
      investigate.indexOf('--disallowedTools'),
      investigate.indexOf(' -- '),
    );
    expect(denied).toBe(
      '--disallowedTools Skill(dataviz) Skill(simplify) Skill(clear) --restricted',
    );
    // Just before it, the deny list was asked where the session runs, with the skill flags only.
    const log = steps.claudeLog();
    const launchAt = log.indexOf(investigate);
    const denyAsks = log
      .slice(0, launchAt)
      .filter((line) => line.startsWith('CONTROL initialize in '));
    const denyAsk = denyAsks[denyAsks.length - 1];
    expect(denyAsk).toContain(`CONTROL initialize in ${steps.clone} with `);
    expect(denyAsk).toContain('--strict-mcp-config');
    expect(denyAsk).toContain(`--plugin-dir ${pluginDir}`);
    expect(denyAsk).not.toContain('--mcp-config');
    expect(denyAsk).not.toContain('--settings');

    // The plugin dir Consola built: its manifest, and the one skill, byte for byte.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('consola-step');
    expect(fs.readdirSync(path.join(pluginDir, 'skills'))).toEqual(['incident-triage']);
    expect(fs.readdirSync(path.join(pluginDir, 'skills', 'incident-triage')).sort()).toEqual([
      'SKILL.md',
      'queries.md',
    ]);
    expect(fs.readFileSync(path.join(pluginDir, TRIAGE_FILE), 'utf8')).toBe(TRIAGE);
    expect(fs.readFileSync(path.join(pluginDir, QUERIES_FILE), 'utf8')).toBe(QUERIES_1);

    // summarise holds after its init: its launch on Personal stub carries none of the grants.
    await expect
      .poll(() => steps.claudeLog().includes('HOLD waiting'), { timeout: 60_000 })
      .toBe(true);
    const personal = launchesOf(steps, 'PERSONAL');
    expect(personal).toHaveLength(1);
    expect(personal[0]).toContain(' --model haiku ');
    expect(personal[0]).toContain(' --max-turns 6 ');
    expect(personal[0]).toContain(' --strict-mcp-config ');
    for (const absent of ['allowedMcpServers', '--plugin-dir', 'Skill', '.claude.json'])
      expect(personal[0]).not.toContain(absent);

    // investigate's init: Consola's server and its two, and neither of the others.
    const init = turnFile(steps, run.id, 'investigate', 1).turns[0].init;
    const loaded = (init?.mcp_servers ?? []).map((server) => server.name);
    expect(loaded).toEqual(expect.arrayContaining(['consola', 'claude.ai Coralogix', 'grafana']));
    expect(loaded).not.toContain('tracker');
    expect(loaded).not.toContain('claude.ai Slack');

    // While summarise holds, investigate's session cannot switch harness (review S9).
    const panel = await openRun(steps);
    const investigateSession = await stepSession(steps.page, run.id, 'investigate');
    expect(investigateSession.grants).toBeDefined();
    await openStepSession(panel, 'investigate');
    const sessionRow = steps.page.locator('.session-nav-item.active');
    await expect(sessionRow).toHaveCount(1, { timeout: 15_000 });
    await rightClickWhenSettled(sessionRow);
    await steps.page.getByRole('menuitem', { name: 'Switch harness…', exact: true }).click();
    const dialog = steps.page.getByRole('dialog', { name: 'Switch harness', exact: true });
    await expect(dialog).toContainText(SWITCH_REFUSED, { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await stepSession(steps.page, run.id, 'investigate')).harnessId).toBe('stub-work');
    // The pane names what the allow-list blocked, as the CLI printed it.
    await expect
      .poll(() => paneText(steps.page, investigateSession), { timeout: 15_000 })
      .toContain(
        'CLI │ Warning: MCP servers blocked by enterprise policy: claude.ai Slack, tracker',
      );
    fs.writeFileSync(steps.files.hold, '');

    // reply posts the summariser's handover once, and the run completes.
    await expect
      .poll(async () => (await runOf(steps, INVESTIGATE))?.status, { timeout: 60_000 })
      .toBe('completed');
    expect(fs.readFileSync(steps.files.replies, 'utf8')).toBe(HANDOVER);
    expect(statuses(await runOf(steps, INVESTIGATE))).toEqual({
      investigate: 'completed',
      summarise: 'completed',
      reply: 'completed',
    });

    // The run page: its total cost, each agent step's, and investigate's servers and skills.
    await openAutomations(steps.page);
    const runPage = await openRun(steps);
    await expect(runPage.locator('.automations-run-stats')).toContainText(
      `$${(STUB_COST * 2).toFixed(4)} est.`,
    );
    await expect(stepNode(runPage, 'investigate')).toContainText('3 turns · $0.0123 est.');
    await expect(stepNode(runPage, 'summarise')).toContainText('3 turns · $0.0123 est.');
    const detail = await openStep(runPage, 'investigate');
    await expect(factOf(detail, 'Servers')).toContainText(
      'claude.ai Coralogix · grafana (query_logs)',
    );
    await expect(factOf(detail, 'Skills')).toContainText('incident-triage');
    const summariseDetail = await openStep(runPage, 'summarise');
    await expect(factOf(summariseDetail, 'Servers')).toHaveCount(0);

    // The reopen: Continue resumes interactively with the same grants, the deny list asked again.
    const asksBefore = controls(steps, 'initialize').length;
    await openStepSession(runPage, 'investigate');
    const restart = steps.page.locator('.terminal-restart-button');
    await expect(restart).toHaveText('Continue', { timeout: 15_000 });
    await restart.click();
    await expect.poll(() => launchesOf(steps, 'WORK').length, { timeout: 30_000 }).toBe(2);
    const reopen = launchesOf(steps, 'WORK')[1];
    expect(reopen).toContain(`--resume ${investigateSession.claudeSessionId} `);
    expect(settingsOf(reopen).allowedMcpServers).toEqual(settings.allowedMcpServers);
    expect(reopen).toContain(` --plugin-dir ${pluginDir} --add-dir ${pluginDir} `);
    expect(reopen).toContain(
      ' --disallowedTools Skill(dataviz) Skill(simplify) Skill(clear) --restricted',
    );
    expect(reopen).not.toContain(' -p ');
    expect(controls(steps, 'initialize').length).toBe(asksBefore + 1);
  } finally {
    await steps.close();
  }
});

test('a probe that fails, a sign-in, or a server that did not load: the step fails and posts nothing', async () => {
  test.setTimeout(360_000);
  const steps = await setUpSteps();
  try {
    // (a) No servers file yet: asking Work stub's CLI fails, and the entry says so, with Check again.
    await addStubHarnesses(steps);
    const dashboard = await openAutomations(steps.page);
    writeInvestigator(steps);
    const row = rowOf(steps.page, INVESTIGATE);
    const problem = row.locator('.automations-row-problem');
    await expect(problem).toContainText(
      `Not running: ${INVESTIGATOR_FILE}: Couldn't ask Work stub which MCP servers it has: STUB_CLAUDE_MCP names no file`,
      { timeout: 30_000 },
    );
    const checkAgain = problem.getByRole('button', { name: 'Check again', exact: true });
    await expect(checkAgain).toBeVisible();
    // The folder applied: a failed probe stops the entry, never the folder (no banner).
    await expect(bannerOf(steps.page)).toHaveCount(0);
    expect((await snapshotOf(steps)).standing).toBeUndefined();
    await steps.page.waitForTimeout(2000);
    expect(launchesOf(steps, 'WORK')).toEqual([]);
    expect(launchesOf(steps, 'PERSONAL')).toEqual([]);

    // (b) The servers file, with Coralogix needing a sign-in; Check again on the row asks once more.
    steps.writeServers(
      SERVERS.map((server) =>
        server.name === 'claude.ai Coralogix' ? { ...server, status: 'needs-auth' } : server,
      ),
    );
    const probes = controls(steps, 'mcp_status').length;
    await checkAgain.click();
    await expect
      .poll(() => controls(steps, 'mcp_status').length, { timeout: 30_000 })
      .toBeGreaterThan(probes);
    await expect(row.locator('.automations-row-problem')).toHaveCount(0, { timeout: 30_000 });
    await expect(dashboard.locator('.automations-notices')).toContainText(CORALOGIX_NEEDS_AUTH);

    // (c) Allowed and run on the alert: investigate fails at its init, and nothing after it runs.
    await allow(steps, INVESTIGATE);
    await runOnTheAlert(steps, INVESTIGATE);
    await expect
      .poll(async () => (await runOf(steps, INVESTIGATE))?.status, { timeout: 60_000 })
      .toBe('failed');
    const run = (await runOf(steps, INVESTIGATE))!;
    expect(statuses(run)).toEqual({
      investigate: 'failed',
      summarise: 'not-run',
      reply: 'not-run',
    });
    expect(stepsOf(run).investigate.error).toBe(CORALOGIX_SIGN_IN);
    expect(fs.existsSync(steps.files.replies)).toBe(false);
    expect(launchesOf(steps, 'PERSONAL')).toEqual([]);

    // (d) Coralogix signed in, grafana gone from the CLI (its cached answer still lists it), and
    // the folder's skill edited: Retry builds its plugin from the fired copy, and init fails it.
    steps.writeServers(
      SERVERS.filter((server) => server.name !== 'grafana').map((server) => ({ ...server })),
    );
    writeFactoryFile(steps, QUERIES_FILE, QUERIES_2);
    await expect
      .poll(() => fs.readFileSync(path.join(folderOf(steps), QUERIES_FILE), 'utf8'), {
        timeout: 5000,
      })
      .toBe(QUERIES_2);
    const runPage = await openRun(steps);
    await runPage.getByRole('button', { name: 'Retry from investigate', exact: true }).click();
    await expect.poll(() => launchesOf(steps, 'WORK').length, { timeout: 60_000 }).toBe(2);
    await expect
      .poll(async () => stepsOf((await runOf(steps, INVESTIGATE))!).investigate?.attempt, {
        timeout: 30_000,
      })
      .toBe(2);
    await expect
      .poll(async () => (await runOf(steps, INVESTIGATE))?.status, { timeout: 60_000 })
      .toBe('failed');
    const retried = (await runOf(steps, INVESTIGATE))!;
    expect(stepsOf(retried).investigate.error).toBe(GRAFANA_NOT_LOADED);
    expect(statuses(retried)).toMatchObject({ summarise: 'not-run', reply: 'not-run' });
    const plugin2 = path.join(attemptDir(steps, run.id, 'investigate', 2), 'plugin');
    expect(fs.readFileSync(path.join(plugin2, QUERIES_FILE), 'utf8')).toBe(QUERIES_1);
    expect(fs.existsSync(steps.files.replies)).toBe(false);
    expect(launchesOf(steps, 'PERSONAL')).toEqual([]);
  } finally {
    await steps.close();
  }
});

const PR_READER_FILE = 'agents/pr-reader.md';
/** The PR reader, naming one server: the person's own, or a connector. */
function prReader(server: string): string {
  return `---\nharness: stub-work\nmcpServers: [${server}]\n---\nPR-READER-BODY-1: read what changed and say what it breaks.\n`;
}
const LOOK = `steps:
  - id: look
    agent: pr-reader
    prompt: Read what changed.
`;
const READ_NIGHTLY = `on: { cron: ${NEVER} }\nscope: catalog-portal\nmode: confirm\n${LOOK}`;
const READ_PRS = `on: manual\napplies_to: [pr]\nmode: confirm\n${LOOK}`;
const REVIEW_PRS = `on: { github: pull_request.review_requested }\nmode: confirm\n${LOOK}`;

test("a step on someone else's pull request is offered connectors only", async () => {
  test.setTimeout(360_000);
  const steps = await setUpSteps({ inbox: [51] });
  try {
    steps.writeServers(SERVERS);
    await addStubHarnesses(steps, { outputs: false });
    await openAutomations(steps.page);

    // (a) A scheduled step may use the person's own server.
    writeFactoryFile(steps, PR_READER_FILE, prReader('grafana'));
    writeFactoryFile(steps, 'automations/read-nightly.yaml', READ_NIGHTLY);
    await expect(rowOf(steps.page, 'read-nightly')).toHaveCount(1, { timeout: 30_000 });
    await expect(
      rowOf(steps.page, 'read-nightly').getByRole('button', { name: 'Run now' }),
    ).toBeEnabled({
      timeout: 30_000,
    });
    expect((await viewOf(steps, 'read-nightly'))?.problem).toBeUndefined();
    expect((await snapshotOf(steps)).standing).toBeUndefined();

    // (b) The same agent on a pull request someone else wrote: refused at its file, and the folder keeps running.
    writeFactoryFile(steps, 'automations/read-prs.yaml', READ_PRS);
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      new RegExp(
        `^Your changes didn't apply: 1 problem in agents/pr-reader\\.md\\. The version from ${AT} keeps running\\.$`,
      ),
      { timeout: 30_000 },
    );
    const group = issueGroup(steps.page, PR_READER_FILE);
    await expect(group).toContainText(ownFile('grafana'));
    await expect(rowOf(steps.page, 'read-nightly')).toHaveCount(1);
    expect((await viewOf(steps, 'read-nightly'))?.problem).toBeUndefined();
    expect(await viewOf(steps, 'read-prs')).toBeUndefined();

    // (c) A pull-request event entry too (review M6): two problems, both the own-file words.
    writeFactoryFile(steps, 'automations/review-prs.yaml', REVIEW_PRS);
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      new RegExp(
        `^Your changes didn't apply: 2 problems in agents/pr-reader\\.md\\. The version from ${AT} keeps running\\.$`,
      ),
      { timeout: 30_000 },
    );
    await expect(group.locator('li', { hasText: ownFile('grafana') })).toHaveCount(2);
    writeFactoryFile(steps, 'automations/review-prs.yaml', null);
    await expect(bannerOf(steps.page).locator('.automations-standing-text')).toHaveText(
      new RegExp(`1 problem in agents/pr-reader\\.md\\.`),
      { timeout: 30_000 },
    );

    // (d) Another of the person's own servers, remote this time: the same words.
    writeFactoryFile(steps, PR_READER_FILE, prReader('tracker'));
    await expect(group).toContainText(ownFile('tracker'), { timeout: 30_000 });

    // (e) A connector: everything applies.
    writeFactoryFile(steps, PR_READER_FILE, prReader('claude.ai Coralogix'));
    await expect(bannerOf(steps.page)).toHaveCount(0, { timeout: 30_000 });
    await expect(rowOf(steps.page, 'read-prs')).toHaveCount(1, { timeout: 30_000 });
    expect((await viewOf(steps, 'read-prs'))?.problem).toBeUndefined();

    // Run on… #51: its approval card says what the connector grants, naming its tools as the run's
    // definition keeps them, as the Allow card does (review S1), and that the agent reads other people's text.
    const prPage = await openAutomation(steps, 'read-prs');
    await prPage.getByRole('button', { name: 'Run on…' }).click();
    const picker = steps.page.getByRole('dialog', { name: 'Run on an item' });
    const inbox = picker.getByRole('region', { name: 'In your Inbox' });
    await expect(inbox.getByRole('button', { name: /#51/ })).toHaveCount(1, { timeout: 30_000 });
    await inbox.getByRole('button', { name: /#51/ }).click();
    await expect(picker).toHaveCount(0);
    const approval = await reviewTheRun(steps);
    const look = approvalStepOf(approval, 'look');
    await expect(look).toContainText('pr-reader · stub-work');
    await expect(look.locator('.automations-meta')).toHaveText(
      'Agent, read-only but for its servers',
    );
    await expect(look).toContainText(
      'claude.ai Coralogix: all its tools (query_logs, list_alerts), including any that post or change things',
    );
    await expect(look).toContainText(ITEM_TEXT_LINE);
    await approval.getByRole('button', { name: 'Start', exact: true }).click();

    // look runs in #51's own checkout with the connector alone: no strict, no account file.
    await expect.poll(() => launchesOf(steps, 'WORK').length, { timeout: 60_000 }).toBe(1);
    const [launch] = launchesOf(steps, 'WORK');
    // The wrapper logs, then the stub it execs logs `<cwd> :: <argv>`, a moment later: wait for it.
    const stubCwd = () => {
      const log = steps.claudeLog();
      const stubLine = log.slice(log.indexOf(launch) + 1).find((line) => line.includes(' :: '));
      return stubLine?.split(' :: ')[0];
    };
    await expect.poll(stubCwd, { timeout: 30_000 }).toBe(steps.checkoutDir);
    expect(settingsOf(launch).allowedMcpServers).toEqual([
      { serverName: 'consola' },
      { serverUrl: CORALOGIX_URL },
    ]);
    expect(launch).toMatch(/ --mcp-config \S.* --settings /);
    expect(launch).not.toContain('.claude.json');
    expect(launch).not.toContain('--strict-mcp-config');
    expect(launch).toContain(' mcp__claude_ai_Coralogix__* ');

    // (f) The scheduled entry's card: the same connector, its tools named, and no item line.
    await expect
      .poll(async () => (await runOf(steps, 'read-prs'))?.status, { timeout: 60_000 })
      .not.toBe('running');
    const looked = stepsOf((await runOf(steps, 'read-prs'))!).look;
    expect({ status: looked.status, error: looked.error }).toEqual({
      status: 'completed',
      error: undefined,
    });
    await closePanel(steps.page);
    await dashboardOf(steps.page).getByRole('tab', { name: 'Automations' }).click();
    await rowOf(steps.page, 'read-nightly').getByRole('button', { name: 'Run now' }).click();
    const nightly = approvalStepOf(await reviewTheRun(steps), 'look');
    await expect(nightly).toContainText(
      'claude.ai Coralogix: all its tools (query_logs, list_alerts), including any that post or change things',
    );
    await expect(nightly).not.toContainText(ITEM_TEXT_LINE);
  } finally {
    await steps.close();
  }
});

test('refused at apply: a plugin server, an unknown server and a Codex harness, and nothing launches', async () => {
  test.setTimeout(240_000);
  const steps = await setUpSteps();
  try {
    steps.writeServers(SERVERS);
    await addStubHarnesses(steps);
    await addHarness(steps, { id: 'codex-1', name: 'Codex 1', mark: 'CODEX', driverId: 'codex' });
    await openAutomations(steps.page);
    const agents = {
      'agents/miro-reader.md':
        '---\nharness: stub-work\nmcpServers:\n  - "plugin:miro:miro"\n---\nRead the board.\n',
      'agents/grafana-reader.md':
        '---\nharness: stub-work\nmcpServers:\n  - grafanna\n---\nRead the dashboards.\n',
      'agents/codex-reader.md': '---\nharness: codex-1\n---\nRead the catalog.\n',
    };
    for (const [file, text] of Object.entries(agents)) writeFactoryFile(steps, file, text);
    for (const name of ['miro-reader', 'grafana-reader', 'codex-reader'])
      writeFactoryFile(
        steps,
        `automations/${name}.yaml`,
        `on: { cron: ${NEVER} }\nscope: catalog-portal\nmode: auto\nsteps:\n  - id: look\n    agent: ${name}\n`,
      );

    // Each refusal under its agent file: the servers at their `mcpServers:` line, the harness at `harness:`.
    await expect(bannerOf(steps.page)).toHaveCount(1, { timeout: 30_000 });
    const refusals: Array<[string, number, string]> = [
      [
        'agents/miro-reader.md',
        3,
        "`plugin:miro:miro` comes from a plugin, which would bring its hooks and skills too. Add the server itself as a user server in Work stub; it will need its own sign-in, since a sign-in belongs to a server's name.",
      ],
      [
        'agents/grafana-reader.md',
        3,
        "`grafanna` isn't one of Work stub's MCP servers (it has: claude.ai Coralogix, claude.ai Slack, grafana, tracker). Add it with `claude mcp add --scope user`, or fix the name.",
      ],
      [
        'agents/codex-reader.md',
        2,
        'Codex sessions cannot be made read-only yet, so automations cannot start one: make a Claude harness this workspace’s default to run them. Steps on Codex arrive later; they need a Codex harness with a home of its own.',
      ],
    ];
    for (const [file, line, words] of refusals) {
      const issue = issueGroup(steps.page, file).locator('li', { hasText: words });
      await expect(issue).toHaveCount(1, { timeout: 30_000 });
      await expect(issue.locator('.automations-line')).toHaveText(`line ${line}`);
    }

    // None of the three is in the running version, so Run now on each is refused, and nothing launches.
    for (const name of ['miro-reader', 'grafana-reader', 'codex-reader']) {
      expect(await viewOf(steps, name)).toBeUndefined();
      const refused = await steps.page.evaluate(
        async ([workspaceId, entry]) =>
          window.automationsAPI.runNow(workspaceId, entry).then(
            () => null,
            (error: unknown) => String(error),
          ),
        [steps.workspaceId, name] as const,
      );
      expect(refused).not.toBeNull();
    }
    await steps.page.waitForTimeout(2000);
    expect(launchesOf(steps, 'WORK')).toEqual([]);
    expect(launchesOf(steps, 'PERSONAL')).toEqual([]);
    expect(steps.claudeLog().filter((line) => line.includes(' :: '))).toEqual([]);
    // Codex was asked only about itself (its version, login, models), never to run a session.
    expect(
      steps
        .claudeLog()
        .filter(
          (line) => line.startsWith('CODEX ') && !/^CODEX (--version|login|app-server)/.test(line),
        ),
    ).toEqual([]);
  } finally {
    await steps.close();
  }
});
