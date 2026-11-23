import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  GRAMMAR_EXAMPLES,
  KEYCHAIN_SENTENCE,
  KEYCHAIN_SIGN_INS_SENTENCE,
} from '@consola/automation-engine';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';

/**
 * North-star §4.1 end to end, on stubs (slice 3, phase 3-B): a Jira bug,
 * found by a poll of the stub `acli`, triaged, fixed by a write agent in a
 * checkout the run owns, reviewed in a loop, pushed by a `run:` step to a
 * real bare repository, opened as a pull request by the stub `gh`, and its
 * ticket moved. The entry, its three agents and its environment are the
 * grammar's own example (`GRAMMAR_EXAMPLES`), so what an agent is taught is
 * what runs here.
 *
 * Nothing reaches Jira, GitHub or a model. The person's clone says its
 * origin is `https://github.com/sprocket/catalog-portal.git`, which is how
 * Consola finds it for `repos:`; the login environment alone (a login shell
 * written per test) maps that URL to the bare `origin.git` beside it, so the
 * run's clone, made with the bound account's environment, fetches and
 * pushes there, while main's own read of the origin still names GitHub.
 * The stub `claude` writes, holds, leaves a process and moves `HEAD` only on
 * a launch whose `--tools` holds `Write` (review S6), and logs each launch's
 * variable names (`STUB_CLAUDE_ENV_LOG`). Helpers are copied from
 * `automation-flow.spec.ts`, not imported, so each spec runs only its own
 * tests.
 *
 * Each scenario launches its own app on its own temp base, and `close()`
 * removes all of it, profile included.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const STUB_GH_DIR = path.join(FIXTURES, 'stub-gh');
const STUB_ACLI_DIR = path.join(FIXTURES, 'stub-acli');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

const REPO = 'sprocket/catalog-portal';
const GITHUB_URL = `https://github.com/${REPO}.git`;
const AUTOMATION = 'ui-bug-to-pr';
const PR_URL = 'https://github.com/sprocket/catalog-portal/pull/77';
const INTERRUPTED =
  'Interrupted: Consola quit while this step was changing the checkout. Check it, then retry.';

/** The grammar's §4.1 example: the entry and the files beside it. */
const EXAMPLE = (() => {
  const example = GRAMMAR_EXAMPLES.find(
    (candidate) => candidate.title === 'A Jira bug to a pull request, in a sandbox',
  );
  if (!example?.files) throw new Error('The grammar lost its §4.1 example.');
  // `automations/ui-bug-to-pr.yaml`: the entry's keys at the top level, without its name.
  const file = example.entry
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n');
  return { file: `${file}\n`, files: example.files };
})();

/** What the stub agent writes as its handover: also the pull request's body. */
const HANDOVER = `## The fix

The search box no longer clips its placeholder.
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A file's lines, none when it does not exist. */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** sha256 of each of the person's clone's git files and folders Consola must never write (review M10). */
function cloneFingerprint(clone: string): Record<string, string> {
  const gitDir = path.join(clone, '.git');
  const hashTree = (target: string): string => {
    const hash = createHash('sha256');
    const walk = (at: string) => {
      const stat = fs.lstatSync(at, { throwIfNoEntry: false });
      if (!stat) return hash.update(`absent ${path.relative(gitDir, at)}\n`);
      if (stat.isDirectory()) {
        hash.update(`dir ${path.relative(gitDir, at)}\n`);
        for (const name of fs.readdirSync(at).sort()) walk(path.join(at, name));
      } else hash.update(`file ${path.relative(gitDir, at)}\n`).update(fs.readFileSync(at));
    };
    walk(target);
    return hash.digest('hex');
  };
  return Object.fromEntries(
    ['refs', 'packed-refs', 'HEAD', 'config', path.join('objects', 'info')].map((name) => [
      name,
      hashTree(path.join(gitDir, name)),
    ]),
  );
}

/**
 * The stub harness's binary: `node` is not on PATH, so a shell wrapper
 * execs the test runner's own Node on the checked-in fixture. The stub's
 * knobs are exported by the wrapper itself: a sandboxed session gets only
 * its environment's allow-list (`sandboxSessionEnv`), which a knob in the
 * app's environment would never pass, and the stub's `ENV` line must show
 * what the session itself was given.
 */
function writeStubClaude(base: string, knobs: Record<string, string>): string {
  const wrapper = path.join(base, 'claude.sh');
  fs.writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      ...Object.entries(knobs).map(([name, value]) => `export ${name}='${value}'`),
      `exec '${process.execPath}' '${path.join(FIXTURES, 'claude-steps.cjs')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return wrapper;
}

/**
 * The login shell for this test: the fixtures' own, with the GitHub URL
 * mapped to the bare repository for every git the login environment starts
 * (the run clone's fetch and every `run:` step), and for nothing else.
 */
function writeLoginShell(base: string, origin: string): string {
  const shell = path.join(base, 'login-shell.sh');
  fs.writeFileSync(
    shell,
    [
      '#!/bin/sh',
      'GIT_CONFIG_COUNT=1',
      `GIT_CONFIG_KEY_0='url.${origin}.insteadOf'`,
      `GIT_CONFIG_VALUE_0='${GITHUB_URL}'`,
      'export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0',
      `exec '${path.join(FIXTURES, 'login-shell.sh')}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return shell;
}

interface WritingOptions {
  /** Launch environment for this test, over the fixtures' own. */
  env?: Record<string, string>;
  /** `STUB_CLAUDE_OUTPUTS_SEQ`: one outputs object per print launch, in order. */
  sequence: Array<Record<string, unknown>>;
  /** `STUB_CLAUDE_WRITES`: one entry per print-mode Write launch, in order. */
  writes?: Array<{ files?: Record<string, string> }>;
  /** More of the stub's knobs, exported by its wrapper (`STUB_CLAUDE_HOLD_WRITE`, …). */
  knobs?: Record<string, string>;
}

interface Writing {
  app: ElectronApplication;
  page: Page;
  base: string;
  userDataDir: string;
  env: Record<string, string>;
  /** The person's clone, the workspace's scope. */
  clone: string;
  /** The bare repository the clone came from, where `pr` pushes. */
  origin: string;
  worktreesDir: string;
  factoryDir: string;
  workspaceId: string;
  files: {
    claudeLog: string;
    envLog: string;
    ghCreated: string;
    acliItems: string;
    acliLog: string;
    holdWrite: string;
    leaveProcess: string;
    writesOpen: string;
  };
  /** The Jira items the poll's `acli` lists next. */
  setItems(items: Array<{ key: string; summary: string }>): void;
  close(): Promise<void>;
}

/**
 * A bare `origin.git` (`main` with `src/app.ts` and `CLAUDE.md`), the
 * person's clone of it as a `Sprocket` workspace bound to GitHub as
 * JaviDev, the stub `claude` as its default harness and as `claude-work`
 * (the harness the example's agents name), each with its own config dir,
 * and the §4.1 factory in its folder. The poll lists no item yet.
 */
async function setUpWriting(options: WritingOptions): Promise<Writing> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-writing-')));
  let app: ElectronApplication | undefined;
  const close = async () => {
    try {
      await app?.close();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
  try {
    const origin = path.join(base, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = path.join(base, 'seed');
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    fs.mkdirSync(path.join(seed, 'src'));
    fs.writeFileSync(path.join(seed, 'src', 'app.ts'), 'broken');
    fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# catalog-portal\n\nRun `pnpm test`.\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'push', '-q', origin, 'main');
    fs.rmSync(seed, { recursive: true, force: true });

    const clone = path.join(base, 'catalog-portal');
    execFileSync('git', ['clone', '-q', origin, clone], { env: GIT_ENV });
    // What Consola matches `repos:` against; only the login environment maps it to `origin.git`.
    git(clone, 'remote', 'set-url', 'origin', GITHUB_URL);
    git(clone, 'config', 'user.name', 'JaviDev');
    git(clone, 'config', 'user.email', 'javidev@sprocket.test');

    const worktreesDir = path.join(base, 'worktrees');
    fs.mkdirSync(worktreesDir);
    const factoryDir = path.join(base, 'factories');
    fs.mkdirSync(factoryDir);
    const files = {
      inbox: path.join(base, 'inbox.json'),
      claudeLog: path.join(base, 'claude.log'),
      envLog: path.join(base, 'env.log'),
      ghLog: path.join(base, 'gh.log'),
      ghCreated: path.join(base, 'gh-created.jsonl'),
      acliItems: path.join(base, 'acli-items.json'),
      acliLog: path.join(base, 'acli.log'),
      sequence: path.join(base, 'outputs-seq.json'),
      writes: path.join(base, 'writes.json'),
      handover: path.join(base, 'handover.md'),
      holdWrite: path.join(base, 'hold-write'),
      leaveProcess: path.join(base, 'leftover.pid'),
      writesOpen: path.join(base, 'writes-open.json'),
    };
    const none = { nodes: [] };
    fs.writeFileSync(
      files.inbox,
      JSON.stringify({
        data: { direct: none, team: none, authored: none, assigned: none, involved: none },
      }),
    );
    fs.writeFileSync(files.acliItems, '[]');
    fs.writeFileSync(files.sequence, JSON.stringify(options.sequence));
    fs.writeFileSync(files.writes, JSON.stringify(options.writes ?? []));
    fs.writeFileSync(files.handover, HANDOVER);
    const binaryPath = writeStubClaude(base, {
      STUB_CLAUDE_LOG: files.claudeLog,
      STUB_CLAUDE_ENV_LOG: files.envLog,
      STUB_CLAUDE_OUTPUTS_SEQ: files.sequence,
      STUB_CLAUDE_WRITES: files.writes,
      STUB_CLAUDE_HANDOVER: files.handover,
      ...(options.knobs ?? {}),
    });

    const env: Record<string, string> = {
      PATH: `${STUB_GH_DIR}${path.delimiter}${STUB_ACLI_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      GRAPHQL_INBOX_FIXTURE: files.inbox,
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_DIR: factoryDir,
      CONSOLA_AUTOMATIONS_TICK_MS: '2000',
      SHELL: writeLoginShell(base, origin),
      STUB_LOGIN_PATH: `${STUB_GH_DIR}${path.delimiter}${STUB_ACLI_DIR}`,
      STUB_GH_LOG: files.ghLog,
      STUB_GH_CREATED: files.ghCreated,
      STUB_ACLI_ITEMS: files.acliItems,
      STUB_ACLI_LOG: files.acliLog,
      // What the environment passes (`env: [CI]`), and two a sandboxed agent must never get.
      CI: '1',
      GH_TOKEN: 'gh-e2e-dummy',
      DUMMY_SECRET: 'e2e-dummy',
      ...(options.env ?? {}),
    };
    const userDataDir = path.join(base, 'profile');
    const launched = await launchElectron({ userDataDir, env, strictLaunches: true });
    app = launched.app;
    const { page } = launched;
    const workspaceId = await page.evaluate(
      async ([folder, binary, stubConfig, workConfig]) => {
        await window.harnessStateAPI.addHarness({
          id: 'stub',
          driverId: 'claude',
          name: 'Stub',
          accentColor: '#555555',
          binaryPath: binary,
          configDir: stubConfig,
        });
        await window.harnessStateAPI.addHarness({
          id: 'claude-work',
          driverId: 'claude',
          name: 'Claude work',
          accentColor: '#666666',
          binaryPath: binary,
          configDir: workConfig,
        });
        const workspace = await window.workspaceAPI.createWorkspace(
          'Sprocket',
          folder,
          true,
          'stub',
        );
        await window.workspaceAPI.updateScope(workspace.id, workspace.scopes[0].id, {
          name: 'catalog-portal',
        });
        await window.workspaceAPI.setProviderBinding(workspace.id, {
          id: 'github',
          accountLogin: 'JaviDev',
        });
        return workspace.id;
      },
      [clone, binaryPath, path.join(base, 'stub-config'), path.join(base, 'work-config')] as const,
    );
    const railButton = page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Sprocket', exact: true });
    await railButton.click();
    await expect(railButton).toHaveAttribute('aria-current', 'true');

    // The §4.1 factory: `repos:`, the entry in its own file, its three agents and its environment.
    const folder = path.join(factoryDir, workspaceId);
    fs.mkdirSync(path.join(folder, 'automations'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'environments'), { recursive: true });
    fs.writeFileSync(path.join(folder, `automations/${AUTOMATION}.yaml`), EXAMPLE.file);
    for (const [file, text] of Object.entries(EXAMPLE.files))
      fs.writeFileSync(path.join(folder, file), text);
    fs.writeFileSync(
      path.join(folder, 'factory.yml'),
      `version: 1\nrepos: [${REPO}]\nautomations: []\n`,
    );

    const writing: Writing = {
      app,
      page,
      base,
      userDataDir,
      env,
      clone,
      origin,
      worktreesDir,
      factoryDir,
      workspaceId,
      files,
      setItems: (items) =>
        fs.writeFileSync(
          files.acliItems,
          // What `acli jira workitem search --json` prints, which the entry's `jq` reads.
          JSON.stringify(items.map(({ key, summary }) => ({ key, fields: { summary } }))),
        ),
      close: async () => {
        app = writing.app;
        await close();
      },
    };
    return writing;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/**
 * One more of the stub's knobs, exported by its wrapper from the next
 * launch on (the wrapper is read at every launch): a knob naming a file in
 * the test's own base, which exists only once it is set up.
 */
function writeStubKnob(writing: Writing, name: string, value: string): void {
  const wrapper = path.join(writing.base, 'claude.sh');
  const text = fs.readFileSync(wrapper, 'utf8');
  fs.writeFileSync(wrapper, text.replace(/^exec /m, `export ${name}='${value}'\nexec `));
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

/** An automation's row in the Automations tab, by its name exactly. */
function rowOf(page: Page, name: string): Locator {
  return dashboardOf(page)
    .locator('.automations-row')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
}

/** The automation as main lists it now. */
async function viewOf(writing: Writing) {
  const { automations } = await writing.page.evaluate(
    (workspaceId) => window.automationsAPI.getSnapshot(workspaceId),
    writing.workspaceId,
  );
  return automations.find((automation) => automation.name === AUTOMATION);
}

/**
 * Allow the poll on the automation's page: its first check records what
 * `acli` lists (nothing) and fires nothing.
 */
async function allow(writing: Writing): Promise<void> {
  await closePanel(writing.page);
  const dashboard = dashboardOf(writing.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  const row = rowOf(writing.page, AUTOMATION);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(async () => (await viewOf(writing))?.problem, { timeout: 30_000 })
    .toBeUndefined();
  await row.getByRole('button', { name: AUTOMATION, exact: true }).click();
  const panel = sidePanel(writing.page);
  const card = panel.getByRole('region', { name: `Allow ${AUTOMATION}` });
  // What the person reads before Allow (the 3-B code review's F9): the write agent, how it is held, the keychain, the commands after it.
  const writes = card.getByRole('group', { name: 'What it can change' });
  await expect(writes.locator('.automations-approval-writes-checkout')).toHaveText(
    `Cuts \`fix/<ticket>\` from ${REPO}'s default branch, in a checkout of its own. Nothing else is written.`,
  );
  await expect(writes.locator('.automations-approval-writes-head')).toHaveText([
    /^ui-bugfixer · claude-work · sonnet · writes files and runs commands · environment sandboxed \(sandbox, enforced on this Mac\) · checked on Claude /,
  ]);
  await expect(writes.locator('.automations-approval-writes-sentence')).toContainText(
    `${KEYCHAIN_SIGN_INS_SENTENCE} ${KEYCHAIN_SENTENCE}`,
  );
  await expect(writes.locator('.automations-approval-writes-command')).toHaveText([
    '`pr` · on host, after ui-bugfixer: runs code an agent changed, as you, with your logins.',
    '`ticket` · on host, after ui-bugfixer: runs code an agent changed, as you, with your logins.',
  ]);
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect
    .poll(async () => (await viewOf(writing))?.check?.lastAt, { timeout: 30_000 })
    .toBeTruthy();
  await closePanel(writing.page);
}

/** Check now on the poll's row, waiting until that check has ended. */
async function checkNow(writing: Writing): Promise<void> {
  const before = (await viewOf(writing))?.check?.lastAt;
  await closePanel(writing.page);
  const dashboard = dashboardOf(writing.page);
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  await rowOf(writing.page, AUTOMATION).getByRole('button', { name: 'Check now' }).click();
  await expect
    .poll(async () => (await viewOf(writing))?.check?.lastAt, { timeout: 30_000 })
    .not.toBe(before);
}

/** The workspace's runs in Activity's list. */
function runItems(page: Page): Locator {
  return dashboardOf(page).locator('.automations-run-item');
}

/** Allow the poll, then list `items` and check: the runs it fires, each started. */
async function fire(writing: Writing, keys: string[]): Promise<void> {
  await openAutomations(writing.page);
  await allow(writing);
  writing.setItems(keys.map((key) => ({ key, summary: `Search box clips (${key})` })));
  await checkNow(writing);
  // Allow accepted the entry's version: each run it fires starts unattended, asking nothing.
  for (const key of keys)
    await expect
      .poll(async () => (await runOn(writing, key)) !== undefined, { timeout: 30_000 })
      .toBe(true);
}

/** A run's status, with its error when it failed: what a wait shows when it is not what it waits for. */
function said(run: RunRecord | undefined): string | undefined {
  if (run?.status !== 'failed') return run?.status;
  const failed = (run.steps ?? []).find((step) => step.status === 'failed');
  return `failed: ${run.error ?? ''}${failed ? ` (${failed.id}: ${failed.error ?? ''})` : ''}`;
}

/** The workspace's runs, read whole from main. */
async function runs(writing: Writing): Promise<RunRecord[]> {
  return writing.page.evaluate(async (workspaceId) => {
    const { runs: listed } = await window.automationsAPI.getSnapshot(workspaceId);
    const records = await Promise.all(listed.map((run) => window.automationsAPI.getRun(run.id)));
    return records.filter((record): record is RunRecord => record !== null);
  }, writing.workspaceId);
}

/** The run on a Jira item, by its key; undefined before it fired. */
async function runOn(writing: Writing, key: string): Promise<RunRecord | undefined> {
  return (await runs(writing)).find((run) => run.trigger.item?.key === key);
}

/** A run, by id, read whole from main. */
async function getRun(writing: Writing, runId: string): Promise<RunRecord> {
  const run = await writing.page.evaluate((id) => window.automationsAPI.getRun(id), runId);
  if (!run) throw new Error(`The run ${runId} is gone.`);
  return run;
}

/** A run's steps by id: each one's record. */
function stepsOf(run: RunRecord): Record<string, StepRun> {
  return Object.fromEntries((run.steps ?? []).map((step) => [step.id, step]));
}

/** Where a run stands: its status, the step it waits at when it waits, and why when it failed. */
async function standing(writing: Writing, runId: string): Promise<string> {
  const run = await getRun(writing, runId);
  const waitingAt = (run.steps ?? []).find((step) => step.status === 'waiting');
  return waitingAt ? `${run.status} at ${waitingAt.id}` : (said(run) ?? run.status);
}

/** Open the run on `key` from Activity, into the side panel. */
async function openRun(writing: Writing, key: string): Promise<Locator> {
  await closePanel(writing.page);
  await dashboardOf(writing.page).getByRole('tab', { name: 'Activity' }).click();
  const item = runItems(writing.page).filter({ hasText: key });
  await expect(item).toHaveCount(1, { timeout: 15_000 });
  await item.click();
  const panel = sidePanel(writing.page);
  await expect(panel.getByRole('list', { name: 'Steps of this run' })).toBeVisible();
  return panel;
}

/** A step's row in the run's trace: a button named `<id>: <outcome>` that opens it. */
function stepNode(panel: Locator, id: string): Locator {
  return panel
    .getByRole('list', { name: 'Steps of this run' })
    .getByRole('button', { name: new RegExp(`^${id}: `) });
}

/** The stub's launch line for a conversation: `<cwd> :: <argv>`. */
function launchLine(writing: Writing, conversation: string): string {
  const found = lines(writing.files.claudeLog).find(
    (line) =>
      line.includes(' :: ') &&
      (line.includes(`--session-id ${conversation} `) ||
        line.includes(`--resume ${conversation} `)),
  );
  if (!found) throw new Error(`No launch of ${conversation} in the stub's log.`);
  return found;
}

/** The variable names a conversation's launch had, from `STUB_CLAUDE_ENV_LOG`. */
function envNames(writing: Writing, conversation: string): string[] {
  const prefix = `ENV ${conversation} :: `;
  const found = lines(writing.files.envLog).find((line) => line.startsWith(prefix));
  if (!found) throw new Error(`No environment logged for ${conversation}.`);
  return found.slice(prefix.length).split(' ');
}

/** The value after `flag` in a logged argv. */
function flagValue(argv: string, flag: string): string {
  const at = argv.indexOf(` ${flag} `);
  if (at === -1) throw new Error(`${flag} is not in ${argv}`);
  const rest = argv.slice(at + flag.length + 2);
  if (rest.startsWith('{')) {
    // A JSON value (`--settings`): up to its matching brace.
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}' && --depth === 0) return rest.slice(0, i + 1);
    }
  }
  return rest.split(' ')[0];
}

/**
 * One outputs object per print launch, in launch order (`STUB_CLAUDE_OUTPUTS_SEQ`):
 * `null` for a step that declares none (`fix`, `address`), which sets nothing.
 */
const CLEAN_ON_ROUND_2 = [{ kind: 'bug' }, null, { findings: 1 }, null, { findings: 0 }];
/** Every review finds one: triage, fix, then three rounds of review and address. */
const NEVER_CLEAN = [{ kind: 'bug' }, null, ...[1, 2, 3].flatMap(() => [{ findings: 1 }, null])];
const FIXED = { files: { 'src/app.ts': 'fixed' } };

test('a Jira bug becomes a pull request: fixed in a sandbox, reviewed clean on round 2, pushed by a command', async () => {
  test.setTimeout(240_000);
  const writing = await setUpWriting({
    sequence: CLEAN_ON_ROUND_2,
    writes: [{ files: { 'src/app.ts': 'fixed' } }, { files: { 'src/app.ts': 'fixed twice' } }],
  });
  try {
    const before = cloneFingerprint(writing.clone);
    await fire(writing, ['SHOP-42']);
    const run = (await runOn(writing, 'SHOP-42'))!;
    await expect.poll(() => standing(writing, run.id), { timeout: 180_000 }).toBe('completed');
    const done = await getRun(writing, run.id);
    const steps = stepsOf(done);

    // Its own checkout: a clone whose git folder is outside it, on the branch the run cut.
    expect(done.checkout).toMatchObject({ kind: 'run-owned', repo: REPO, branch: 'fix/SHOP-42' });
    const checkout = done.checkout!.cwd;
    expect(path.dirname(checkout)).toBe(writing.worktreesDir);
    expect(fs.readdirSync(writing.worktreesDir)).toEqual([path.basename(checkout)]);
    const pointer = fs.readFileSync(path.join(checkout, '.git'), 'utf8').trim();
    expect(pointer).toMatch(/^gitdir: /);
    const gitFolder = pointer.slice('gitdir: '.length);
    expect(gitFolder.startsWith(`${checkout}${path.sep}`)).toBe(false);
    expect(fs.statSync(gitFolder).isDirectory()).toBe(true);

    // Pushed by `pr`, through the pointer, to the bare origin, at the run's head; Consola's commits on it.
    expect(git(writing.origin, 'rev-parse', 'fix/SHOP-42')).toBe(done.checkout!.head);
    const subjects = git(writing.origin, 'log', '--format=%s', 'fix/SHOP-42').split('\n');
    expect(subjects).toContain(`fix (attempt 1) of ${AUTOMATION} on SHOP-42`);
    expect(subjects).toContain(`address (attempt 1) of ${AUTOMATION} on SHOP-42`);
    expect(git(writing.origin, 'show', 'fix/SHOP-42:src/app.ts')).toBe('fixed twice');
    // The person's clone: nothing Consola must not write was written (review M10).
    expect(cloneFingerprint(writing.clone)).toEqual(before);

    // `fix` launched as a sandboxed write agent.
    const fixConversation = steps.fix.conversation?.id ?? '';
    const argv = launchLine(writing, fixConversation);
    expect(argv.split(' -- ')[0].trimEnd().endsWith(' --restricted')).toBe(true);
    expect(flagValue(argv, '--tools').split(',')).toContain('Bash');
    const settings = JSON.parse(flagValue(argv, '--settings'));
    expect(settings.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
    const names = envNames(writing, fixConversation);
    expect(names).toContain('CI');
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GH_TOKEN', 'DUMMY_SECRET'])
      expect(names, name).not.toContain(name);

    // The pull request, and the ticket moved.
    const created = lines(writing.files.ghCreated).map((line) => JSON.parse(line));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      head: 'fix/SHOP-42',
      title: 'SHOP-42: Search box clips (SHOP-42)',
    });
    expect(created[0].body).toBe(HANDOVER);
    expect(steps.pr.outputs).toEqual({ url: PR_URL });
    expect(lines(writing.files.acliLog)).toEqual([
      'transition SHOP-42 In Review',
      `comment SHOP-42 PR: ${PR_URL}`,
    ]);

    // The run page says where it worked, and how `fix` was held.
    const panel = await openRun(writing, 'SHOP-42');
    const block = panel.locator('.automations-run-checkout');
    await expect(block).toContainText(`${REPO} · fix/SHOP-42`);
    await expect(block.getByRole('button', { name: 'Open folder' })).toBeVisible();
    await stepNode(panel, 'fix').click();
    await expect(panel.locator('.automations-trace-detail').first()).toContainText(
      'sandboxed · sandbox, enforced',
    );
  } finally {
    await writing.close();
  }
});

test('not ours: the comment is posted and the run stops', async () => {
  test.setTimeout(240_000);
  const writing = await setUpWriting({ sequence: [{ kind: 'feature' }] });
  try {
    await fire(writing, ['SHOP-42']);
    const run = (await runOn(writing, 'SHOP-42'))!;
    await expect.poll(() => standing(writing, run.id), { timeout: 120_000 }).toBe('completed');
    const done = await getRun(writing, run.id);
    await expect((await openRun(writing, 'SHOP-42')).locator('.automations-run-status')).toHaveText(
      'Completed',
    );
    expect(done.summary).toMatch(/stopped after not-ours$/);
    const acli = lines(writing.files.acliLog);
    expect(acli).toHaveLength(1);
    // Its body is triage's handover, as the entry's `env:` names it.
    expect(acli[0]).toMatch(/^comment SHOP-42 ## The fix/);
    expect(stepsOf(done).fix.status).toBe('not-run');
    expect(git(writing.origin, 'branch', '--list', 'fix/*')).toBe('');
  } finally {
    await writing.close();
  }
});

/** The gate a never-clean run waits at: its card on the run page. */
async function polishCard(writing: Writing, key: string): Promise<Locator> {
  const panel = await openRun(writing, key);
  const card = panel.getByRole('region', { name: 'Gate polish' });
  await expect(card).toContainText(
    'The review still has findings after 3 rounds. Open the pull request anyway?',
  );
  return card;
}

test('never clean: the run asks before it opens the pull request, and Reject pushes nothing', async () => {
  test.setTimeout(240_000);
  const writing = await setUpWriting({
    sequence: [...NEVER_CLEAN, ...NEVER_CLEAN],
    writes: [FIXED],
  });
  try {
    await fire(writing, ['SHOP-42']);
    const first = (await runOn(writing, 'SHOP-42'))!;
    await expect
      .poll(() => standing(writing, first.id), { timeout: 180_000 })
      .toBe('waiting at polish');
    // The card shows the review's handover and the branch's changes, `fix`'s among them.
    const card = await polishCard(writing, 'SHOP-42');
    await expect(card.locator('.automations-gate-material-label')).toHaveText([
      'material from the run · review.handover',
      /^material from the run · changes on fix\/SHOP-42 since [0-9a-f]{7}$/,
    ]);
    await expect(card.locator('.automations-gate-material').nth(1)).toContainText('+fixed');
    expect(git(writing.origin, 'branch', '--list', 'fix/*')).toBe('');
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => standing(writing, first.id), { timeout: 60_000 }).toBe('completed');
    expect(git(writing.origin, 'rev-parse', 'fix/SHOP-42')).toBe(
      (await getRun(writing, first.id)).checkout!.head,
    );

    // A second item: Reject at the same gate ends it rejected, and pushes nothing.
    writing.setItems([
      { key: 'SHOP-42', summary: 'Search box clips (SHOP-42)' },
      { key: 'SHOP-43', summary: 'Search box clips (SHOP-43)' },
    ]);
    await checkNow(writing);
    await expect.poll(async () => (await runOn(writing, 'SHOP-43')) !== undefined).toBe(true);
    const second = (await runOn(writing, 'SHOP-43'))!;
    await expect
      .poll(() => standing(writing, second.id), { timeout: 180_000 })
      .toBe('waiting at polish');
    const rejecting = await polishCard(writing, 'SHOP-43');
    await rejecting.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect.poll(() => standing(writing, second.id), { timeout: 30_000 }).toBe('rejected');
    await expect(sidePanel(writing.page).locator('.automations-rejected')).toContainText(
      'rejected at `polish` by you',
    );
    expect(git(writing.origin, 'branch', '--list', 'fix/SHOP-43')).toBe('');
  } finally {
    await writing.close();
  }
});

/** The run folder of a run's step attempt, where `changes.patch` is kept. */
function attemptDir(writing: Writing, runId: string, step: string, attempt: number): string {
  return path.join(writing.factoryDir, writing.workspaceId, 'runs', runId, step, String(attempt));
}

/** Wait until the stub logged `line` `count` times. */
async function logged(writing: Writing, line: string, count = 1): Promise<void> {
  await expect
    .poll(() => lines(writing.files.claudeLog).filter((logged) => logged === line).length, {
      timeout: 120_000,
    })
    .toBe(count);
}

test('a quit while fix writes fails it; Retry starts again from before, keeping what it changed', async () => {
  test.setTimeout(240_000);
  const writing = await setUpWriting({
    // triage, fix (attempt 1, cut off), fix (attempt 2), one clean review.
    sequence: [{ kind: 'bug' }, null, null, { findings: 0 }],
    // Attempt 2 writes nothing, so what it starts from shows while it holds.
    writes: [FIXED, {}],
  });
  // A Write launch holds until this file exists; `triage` passes.
  const hold = writing.files.holdWrite;
  writeStubKnob(writing, 'STUB_CLAUDE_HOLD_WRITE', hold);
  try {
    await fire(writing, ['SHOP-42']);
    const run = (await runOn(writing, 'SHOP-42'))!;
    await logged(writing, 'HOLD waiting');
    const checkout = (await getRun(writing, run.id)).checkout!.cwd;
    expect(fs.readFileSync(path.join(checkout, 'src', 'app.ts'), 'utf8')).toBe('fixed');
    expect(stepsOf(await getRun(writing, run.id)).fix.status).toBe('running');

    // Quit while it writes, and come back on the same profile.
    await writing.app.close();
    const relaunched = await launchElectron({
      strictLaunches: true,
      userDataDir: writing.userDataDir,
      env: writing.env,
    });
    writing.app = relaunched.app;
    writing.page = relaunched.page;
    await expect(
      writing.page.getByRole('navigation', { name: 'Workspaces', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    expect(await standing(writing, run.id)).toBe(`failed: ${INTERRUPTED} (fix: ${INTERRUPTED})`);
    const notices = await writing.app.evaluate(
      () =>
        (
          globalThis as unknown as {
            __consolaTest: { automationNotices: Array<{ title: string }> };
          }
        ).__consolaTest.automationNotices,
    );
    expect(notices.map((notice) => notice.title)).toContain(`${AUTOMATION} stopped while it wrote`);

    // Retry: attempt 1's changes are kept apart, and attempt 2 starts from where attempt 1 began.
    await openAutomations(writing.page);
    const panel = await openRun(writing, 'SHOP-42');
    await panel.getByRole('button', { name: 'Retry from fix' }).click();
    const confirm = panel.getByRole('group', { name: 'Retry from fix' });
    if ((await confirm.count()) > 0) await confirm.getByRole('button', { name: 'Retry' }).click();
    await logged(writing, 'HOLD waiting', 2);
    expect(stepsOf(await getRun(writing, run.id)).fix).toMatchObject({
      attempt: 2,
      status: 'running',
    });
    expect(fs.readFileSync(path.join(checkout, 'src', 'app.ts'), 'utf8')).toBe('broken');
    const patch = fs.readFileSync(
      path.join(attemptDir(writing, run.id, 'fix', 1), 'changes.patch'),
      'utf8',
    );
    expect(patch).toContain('+fixed');
    fs.writeFileSync(hold, '');
    await expect.poll(() => standing(writing, run.id), { timeout: 120_000 }).toBe('completed');
  } finally {
    await writing.close();
  }
});

test('HEAD moved fails fix and pushes nothing; a process left behind is ended', async () => {
  test.setTimeout(300_000);
  const moved = await setUpWriting({
    sequence: CLEAN_ON_ROUND_2,
    writes: [FIXED],
    knobs: { STUB_CLAUDE_MOVE_HEAD: '1' },
  });
  try {
    await fire(moved, ['SHOP-42']);
    const run = (await runOn(moved, 'SHOP-42'))!;
    await expect.poll(() => standing(moved, run.id), { timeout: 120_000 }).toMatch(/^failed: /);
    const steps = stepsOf(await getRun(moved, run.id));
    expect(steps.fix).toMatchObject({
      status: 'failed',
      error: 'the step moved `HEAD` off fix/SHOP-42',
    });
    expect(steps.pr.status).toBe('not-run');
    expect(git(moved.origin, 'branch', '--list', 'fix/*')).toBe('');
  } finally {
    await moved.close();
  }

  const left = await setUpWriting({ sequence: CLEAN_ON_ROUND_2, writes: [FIXED] });
  const pidFile = left.files.leaveProcess;
  writeStubKnob(left, 'STUB_CLAUDE_LEAVE_PROCESS', pidFile);
  let pid = 0;
  try {
    await fire(left, ['SHOP-42']);
    const run = (await runOn(left, 'SHOP-42'))!;
    await expect.poll(() => fs.existsSync(pidFile), { timeout: 120_000 }).toBe(true);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await expect
      .poll(async () => stepsOf(await getRun(left, run.id)).fix?.status, { timeout: 120_000 })
      .toBe('completed');
    // Ended with the step's group, once `fix` ended; the run goes on.
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    await expect.poll(() => standing(left, run.id), { timeout: 120_000 }).toBe('completed');
  } finally {
    if (pid > 0)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone, as it should be.
      }
    await left.close();
  }
});

test("a person's session in the checkout holds the run, and what it leaves is its own commit", async () => {
  test.setTimeout(300_000);
  const writing = await setUpWriting({ sequence: NEVER_CLEAN, writes: [FIXED] });
  const open = writing.files.writesOpen;
  fs.writeFileSync(open, JSON.stringify([{ files: { 'NOTES.md': 'What I checked by hand.\n' } }]));
  writeStubKnob(writing, 'STUB_CLAUDE_WRITES_OPEN', open);
  try {
    await fire(writing, ['SHOP-42']);
    const run = (await runOn(writing, 'SHOP-42'))!;
    await expect
      .poll(() => standing(writing, run.id), { timeout: 180_000 })
      .toBe('waiting at polish');

    // Open `fix`'s session from the run page, and continue it: an interactive launch in the checkout.
    const panel = await openRun(writing, 'SHOP-42');
    await stepNode(panel, 'fix').click();
    await panel.getByRole('button', { name: 'Open session' }).first().click();
    const toolbar = writing.page.locator('.terminal-panel-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 30_000 });
    const continueFull = toolbar.getByRole('button', { name: 'Continue with full tools' });
    await expect(continueFull).toBeDisabled();
    await expect(continueFull).toHaveAttribute(
      'title',
      'Continue with full tools after the run ends',
    );
    await toolbar.getByRole('button', { name: 'Continue', exact: true }).click();
    await logged(writing, 'OPEN waiting');
    const checkout = (await getRun(writing, run.id)).checkout!.cwd;
    expect(fs.readFileSync(path.join(checkout, 'NOTES.md'), 'utf8')).toBe(
      'What I checked by hand.\n',
    );

    // Approve while it is open: the run waits for the person to close it.
    await openAutomations(writing.page);
    const card = await polishCard(writing, 'SHOP-42');
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect
      .poll(async () => (await getRun(writing, run.id)).waitingFor?.session, { timeout: 30_000 })
      .toBeTruthy();
    expect((await getRun(writing, run.id)).status).toBe('running');
    // `fix`'s session, as a step's session is named: its item's title, then the step.
    const session = 'Search box clips (SHOP-42) · fix';
    await expect(sidePanel(writing.page).locator('.automations-held-by')).toHaveText(
      `waiting for you to close \`${session}\`, open in this run's checkout`,
    );
    await closePanel(writing.page);
    await dashboardOf(writing.page).getByRole('tab', { name: 'Activity' }).click();
    await expect(runItems(writing.page).filter({ hasText: 'SHOP-42' })).toContainText(
      `waiting for you to close ${session}`,
    );
    expect(git(writing.origin, 'branch', '--list', 'fix/*')).toBe('');

    // Closed: what it left is committed apart, as the person's, then `pr` runs.
    fs.writeFileSync(`${open}.close`, '');
    await expect.poll(() => standing(writing, run.id), { timeout: 60_000 }).toBe('completed');
    const done = await getRun(writing, run.id);
    expect(done.checkout!.byPerson).toHaveLength(1);
    expect(git(writing.origin, 'log', '--format=%s', 'fix/SHOP-42').split('\n')).toContain(
      `changes by ${session} during ${AUTOMATION}`,
    );
    expect(git(writing.origin, 'show', 'fix/SHOP-42:NOTES.md')).toBe('What I checked by hand.');
    const page = await openRun(writing, 'SHOP-42');
    const people = page.locator('.automations-run-checkout-people');
    await expect(people).toContainText('Changed by you during the run');
    // The session's name as literal text: every RegExp metacharacter escaped, backslash included.
    const literal = session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(people.getByRole('listitem').first()).toContainText(
      new RegExp(`^${literal} · 1 files · [0-9a-f]{7}`),
    );

    // The run ended: its step may now be continued with full tools.
    await page.getByRole('list', { name: 'Steps of this run' }).waitFor();
    await stepNode(page, 'fix').click();
    await page.getByRole('button', { name: 'Open session' }).first().click();
    await expect(
      writing.page
        .locator('.terminal-panel-toolbar')
        .first()
        .getByRole('button', { name: 'Continue with full tools' }),
    ).toBeEnabled({ timeout: 30_000 });
  } finally {
    await writing.close();
  }
});
