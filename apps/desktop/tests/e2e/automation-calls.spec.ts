import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron } from './helpers/electron';

/**
 * Calls, end to end (phase 5a-2): a `uses:` step calls a factory server's
 * tool. The briefing's shape: `shipped` prints what shipped, `brief` (the stub
 * `claude`) writes the briefing as its handover, and `post` sends it to
 * `slack#chat_post_message`. The server is the repository's stub
 * (`tests/fixtures/stub-mcp.cjs`), started by Node's absolute path; its
 * controls are its arguments, and it writes only the sha-256 of the token it
 * was given, never the value (rule 5a-servers). `SLACK_BOT_TOKEN` is bound to
 * `env:STUB_SLACK_TOKEN`, a fake value in the app's environment that the
 * fixture login shell passes on. No test reads a keychain or 1Password: the
 * stub `security` is the run's keychain program and 1Password has none.
 *
 * Each test launches its own app on its own temp base, and `close()` removes
 * all of it, profile included. The engine ticks every two seconds.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const STUB_GH_DIR = path.join(FIXTURES, 'stub-gh');
const STUB_SECURITY = path.join(FIXTURES, 'stub-security');
const STUB_MCP = path.join(FIXTURES, 'stub-mcp.cjs');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** The engine's tick in these tests, in milliseconds. */
const TICK_MS = 2000;

/** A fake token full of characters that change when printed (Review Focus 1). Never a real token's shape. */
const VALUE = String.raw`stub-slack-secret-9c1e"\back%slash`;
/** The test's own hash of the value: what the stub must report, so no variable carries the expectation. */
const VALUE_SHA256 = createHash('sha256').update(VALUE, 'utf8').digest('hex');

/** What `brief` writes as its handover, and so what `post` sends as `text`. */
const HANDOVER = 'Shipped: empty carts at checkout.';
/** The stub's answer to a post. */
const TS = '1700000000.0001';

const UNBOUND = 'needs `SLACK_BOT_TOKEN` bound on this Mac (Settings › Secrets)';
const STARTED = 'Started for each call and stopped after.';
/** The server's literal `env:`, as the cards, the page and Check server's dialog show it (review S1). */
const ENV_LINE = 'env: `SLACK_TEAM_ID=T0SPROCKET`';
const TRUST_LINE =
  "Where a secret is bound is this Mac's setting, not the file's: changing it does not ask again.";
const MAY_HAVE_TIMED_OUT =
  'It may or may not have happened: the call timed out after 2s. Check, then retry.';
const RETRY_WARNING = 'This call may already have happened; check before calling it again.';
const SURVIVORS = 'Something it started was still running after it was stopped.';

/** The cron is never due (31 February), so only Run now starts a run. */
const NEVER = '"0 0 31 2 *"';

/** Every printed form of a value Consola must never write: raw, JSON-escaped, percent-encoded, base64. */
function formsOf(value: string): string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, 'utf8').toString('base64'),
  ];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A file's lines, none when it does not exist. */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** Every file under `dir`, recursively; none when it does not exist. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  if (fs.statSync(dir).isFile()) return [dir];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(at);
    return entry.isFile() ? [at] : [];
  });
}

/** The files under `dirs` holding any form of `value`, as `<file>: <form>`. */
function leaks(dirs: string[], value: string): string[] {
  const forms = formsOf(value);
  return dirs.flatMap((dir) =>
    filesUnder(dir).flatMap((file) => {
      const text = fs.readFileSync(file).toString('latin1');
      return forms.filter((form) => text.includes(form)).map((form) => `${file}: ${form}`);
    }),
  );
}

/** One line of the stub's `--log`. */
interface StubEvent {
  event: 'list' | 'call' | 'start' | 'work-done';
  tool?: string;
  arguments?: Record<string, unknown>;
  tokenSha256?: string | null;
  at: number;
}

/** How `factory.yml` is written for a test: the server's tool, the entry's mode, and the server's extra args. */
interface FactoryOptions {
  mode?: 'auto' | 'notify' | 'confirm';
  /** `post`'s tool; `slow_post` gets a 2 s timeout and no outputs. */
  tool?: 'chat_post_message' | 'slow_post';
  /** After `--log` and `--pids`. */
  extraArgs?: string[];
}

interface Calls {
  app: ElectronApplication;
  page: Page;
  base: string;
  userDataDir: string;
  workspaceId: string;
  /** The workspace's factory folder, and its runs/. */
  folder: string;
  files: { log: string; pids: string; claudeLog: string };
  /** `factory.yml`'s text for these options. */
  factoryText(options?: FactoryOptions): string;
  /** Writes `factory.yml` whole. */
  writeFactory(text: string): void;
  /** The stub server's events, in order. */
  events(): StubEvent[];
  /** Its `call` events. */
  calls(): StubEvent[];
  /** The pids it wrote as it started. */
  pids(): number[];
  /** The stub `claude`'s launches. */
  launches(): string[];
  /** Binds a name through the window's own API: what Settings › Secrets' Bind sends. */
  bind(name: string, variable: string): Promise<void>;
  snapshot(): Promise<{
    runs: Array<{ id: string; status: string }>;
    /** `version`: the entry's, as its servers' view carries it (what Check server sends back). */
    automations: Array<{ name: string; problem?: string; version?: string }>;
  }>;
  close(): Promise<void>;
}

/**
 * The stub harness's binary: `node` is not on PATH, so a shell wrapper execs
 * the test runner's own Node on slice 1's stub `claude`.
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

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, its default harness the stub `claude` (writing `HANDOVER`), held
 * in this window, with `factory.yml` written by `factoryText(initial)`.
 */
async function setUpCalls(initial: FactoryOptions = {}): Promise<Calls> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-calls-')));
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
    fs.writeFileSync(path.join(clone, 'README.md'), '# catalog-portal\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'init');
    git(clone, 'remote', 'add', 'origin', 'https://github.com/sprocket/catalog-portal.git');

    const worktreesDir = path.join(base, 'worktrees');
    fs.mkdirSync(worktreesDir);
    const factoryDir = path.join(base, 'factories');
    fs.mkdirSync(factoryDir);
    const configDir = path.join(base, 'claude-config');
    fs.mkdirSync(configDir);
    const files = {
      log: path.join(base, 'stub-mcp.log'),
      pids: path.join(base, 'stub-mcp.pids'),
      claudeLog: path.join(base, 'claude.log'),
      handover: path.join(base, 'handover.md'),
      securityItems: path.join(base, 'security-items.json'),
      securityLog: path.join(base, 'security.log'),
    };
    fs.writeFileSync(files.handover, HANDOVER);
    const binaryPath = writeStubClaude(base);

    const env: Record<string, string> = {
      // The stub first on the app's own PATH too: should the login probe fail,
      // its fallback is this environment, and commands still find the stub gh.
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_DIR: factoryDir,
      CONSOLA_AUTOMATIONS_TICK_MS: String(TICK_MS),
      SHELL: path.join(FIXTURES, 'login-shell.sh'),
      STUB_LOGIN_PATH: STUB_GH_DIR,
      STUB_SLACK_TOKEN: VALUE,
      // The same value under another name: a rebinding that changes no value.
      STUB_SLACK_TOKEN_2: VALUE,
      STUB_CLAUDE_LOG: files.claudeLog,
      STUB_CLAUDE_HANDOVER: files.handover,
      // The test run's keychain program is the stub; 1Password has none (an empty stub is no stub).
      CONSOLA_E2E_SECURITY: STUB_SECURITY,
      CONSOLA_E2E_OP: '',
      STUB_SECURITY_ITEMS: files.securityItems,
      STUB_SECURITY_LOG: files.securityLog,
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
    const folder = path.join(factoryDir, workspaceId);
    const writeFactory = (text: string) => {
      fs.mkdirSync(folder, { recursive: true });
      const temporary = path.join(base, '.write-factory.yml');
      fs.writeFileSync(temporary, text);
      fs.renameSync(temporary, path.join(folder, 'factory.yml'));
    };
    const factoryText = (options: FactoryOptions = {}) =>
      briefingFactory({ log: files.log, pids: files.pids, ...options });
    writeFactory(factoryText(initial));
    const railButton = page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Sprocket', exact: true });
    await railButton.click();
    await expect(railButton).toHaveAttribute('aria-current', 'true');

    const events = () => lines(files.log).map((line) => JSON.parse(line) as StubEvent);
    return {
      app,
      page,
      base,
      userDataDir,
      workspaceId,
      folder,
      files,
      factoryText,
      writeFactory,
      events,
      calls: () => events().filter((event) => event.event === 'call'),
      pids: () => lines(files.pids).map(Number),
      launches: () => lines(files.claudeLog).filter((line) => line.includes(' :: ')),
      bind: (name, variable) =>
        page.evaluate(([id, secret, reference]) => window.secretsAPI.bind(id, secret, reference), [
          workspaceId,
          name,
          { kind: 'env' as const, name: variable },
        ] as const),
      snapshot: () =>
        page.evaluate(async (id) => {
          const snapshot = await window.automationsAPI.getSnapshot(id);
          return {
            runs: snapshot.runs.map((run) => ({ id: run.id, status: run.status })),
            automations: snapshot.automations.map((view) => ({
              name: view.name,
              ...(view.problem !== undefined ? { problem: view.problem } : {}),
              ...(view.servers?.[0] !== undefined ? { version: view.servers[0].version } : {}),
            })),
          };
        }, workspaceId),
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** The server's line as the cards and the page say it: Node, the stub, and its arguments. */
function serverLine(calls: Pick<Calls, 'files'>, extraArgs: string[] = []): string {
  const target = [
    process.execPath,
    STUB_MCP,
    '--log',
    calls.files.log,
    '--pids',
    calls.files.pids,
    ...extraArgs,
  ].join(' ');
  return `starts \`${target}\` on this Mac as you, with your files and network, in an empty folder, with HOME, USER, LOGNAME, SHELL, PATH, TERM, LANG, LC_*, TMPDIR, SLACK_TEAM_ID and SLACK_BOT_TOKEN`;
}

/**
 * `factory.yml`: the stub as `slack`, and `support-briefing`, whose `post`
 * sends `brief`'s handover to `C0SUPPORT1`.
 */
function briefingFactory(options: FactoryOptions & { log: string; pids: string }): string {
  const tool = options.tool ?? 'chat_post_message';
  const args = [STUB_MCP, '--log', options.log, '--pids', options.pids];
  if (tool === 'slow_post') args.push('--slow-ms', '4000');
  args.push(...(options.extraArgs ?? []));
  const post =
    tool === 'slow_post'
      ? `      - id: post
        uses: slack#slow_post
        with: { channel: C0SUPPORT1, text: "{{steps.brief.handover}}" }
        timeout: 2s`
      : `      - id: post
        uses: slack#chat_post_message
        with: { channel: C0SUPPORT1, text: "{{steps.brief.handover}}" }
        outputs: { ts: string }`;
  return `version: 1
mcpServers:
  slack:
    command: ${JSON.stringify(process.execPath)}
    args: [${args.map((arg) => JSON.stringify(arg)).join(', ')}]
    env: { SLACK_TEAM_ID: T0SPROCKET }
    secrets: [SLACK_BOT_TOKEN]
automations:
  - name: support-briefing
    on: { cron: ${NEVER} }
    scope: catalog-portal
    mode: ${options.mode ?? 'auto'}
    steps:
      - id: shipped
        run: |
          printf '[{"key":"CAT-1","summary":"Checkout copes with empty carts"}]'
        outputs: { from: stdout, format: json }
        dry_run: run
      - id: brief
        prompt: Write the 2nd-line briefing.
        reads: [shipped.output]
${post}
`;
}

/** The Automations dashboard. */
function dashboardOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Automations', exact: true });
}

/** Open the dashboard from the sidebar row, on its Automations tab. */
async function openAutomations(page: Page): Promise<Locator> {
  await page
    .locator('.home-navigation')
    .getByRole('button', { name: /^Automations/ })
    .click();
  const dashboard = dashboardOf(page);
  await expect(dashboard.getByRole('heading', { name: 'Automations · Sprocket' })).toBeVisible();
  await dashboard.getByRole('tab', { name: 'Automations' }).click();
  return dashboard;
}

/** An automation's row in the Automations tab. */
function rowOf(page: Page, name: string): Locator {
  return dashboardOf(page).locator('.automations-row', { hasText: name });
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

/** The Settings dialog. */
function settingsOf(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

/** The run waiting for approval, opened from the dashboard's waiting card. */
async function openWaitingRun(page: Page): Promise<Locator> {
  const waiting = dashboardOf(page).locator('.automations-waiting-card');
  await expect(waiting).toHaveCount(1, { timeout: 30_000 });
  await waiting.getByRole('button', { name: 'Review…' }).click();
  const approval = sidePanel(page).getByRole('region', { name: 'Waiting for your approval' });
  await expect(approval).toBeVisible();
  return approval;
}

/** Run now on `support-briefing`, once it is enabled. */
async function runNow(calls: Calls): Promise<void> {
  const button = rowOf(calls.page, 'support-briefing').getByRole('button', { name: 'Run now' });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
}

/** Waits for the workspace's runs to read `statuses`, in its order (newest first). */
async function runsAre(calls: Calls, statuses: string[], timeout = 60_000): Promise<string[]> {
  await expect
    .poll(async () => (await calls.snapshot()).runs.map((run) => run.status), { timeout })
    .toEqual(statuses);
  return (await calls.snapshot()).runs.map((run) => run.id);
}

/** The newest run's page, from Activity, and its trace. */
async function openLatestRun(page: Page): Promise<Locator> {
  await closePanel(page);
  const dashboard = dashboardOf(page);
  await dashboard.getByRole('tab', { name: 'Activity' }).click();
  await dashboard.locator('.automations-run-item').first().click();
  const run = sidePanel(page);
  await expect(run.getByRole('list', { name: 'Steps of this run' })).toBeVisible();
  return run;
}

/** A step's row in a run's trace, by its head button. */
function stepHead(run: Locator, id: string): Locator {
  return run
    .getByRole('list', { name: 'Steps of this run' })
    .getByRole('button', { name: new RegExp(`^${id}: `) });
}

/** Every page of the window as a person reads it, and the markup under it. */
async function pageTexts(page: Page): Promise<string> {
  return page.evaluate(() => `${document.body.innerText}\n${document.documentElement.outerHTML}`);
}

/** Whether a process is alive (`kill -0`). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('Unbound: a call whose server’s secret is not bound runs nothing, and starts no server', async () => {
  test.setTimeout(120_000);
  const calls = await setUpCalls();
  try {
    await openAutomations(calls.page);
    const row = rowOf(calls.page, 'support-briefing');
    await expect(row).toContainText(`Not running: ${UNBOUND}`, { timeout: 15_000 });
    await expect(row.getByRole('button', { name: 'Run now' })).toBeDisabled();
    // Run now's answer from main is the same words.
    const refused = await calls.page.evaluate(
      (id) =>
        window.automationsAPI.runNow(id, 'support-briefing').then(
          () => 'ran',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      calls.workspaceId,
    );
    expect(refused).toContain(`support-briefing cannot run: ${UNBOUND}`);
    // Two ticks: still nothing.
    await calls.page.waitForTimeout(2 * TICK_MS + 500);
    expect((await calls.snapshot()).runs).toEqual([]);
    // No server started, no command ran, no agent launched.
    expect(fs.existsSync(calls.files.log)).toBe(false);
    expect(fs.existsSync(calls.files.pids)).toBe(false);
    expect(filesUnder(path.join(calls.folder, 'runs'))).toEqual([]);
    expect(calls.launches()).toEqual([]);
  } finally {
    await calls.close();
  }
});

test('Bound, first run asks once: the card shows the server, as you, each argument with its trust, and where the secret goes', async () => {
  test.setTimeout(150_000);
  const calls = await setUpCalls();
  try {
    await openAutomations(calls.page);
    const row = rowOf(calls.page, 'support-briefing');
    await expect(row).toContainText(`Not running: ${UNBOUND}`, { timeout: 15_000 });
    // Settings › Secrets, through the row's Bind…: 5a-1's dialog, an env: reference.
    await row.getByRole('button', { name: 'Bind…', exact: true }).click();
    const modal = settingsOf(calls.page);
    await expect(modal).toBeVisible();
    const secretRow = modal.getByRole('listitem', { name: 'SLACK_BOT_TOKEN', exact: true });
    await secretRow.getByRole('button', { name: 'Bind…', exact: true }).click();
    const dialog = calls.page.getByRole('dialog', { name: 'Bind SLACK_BOT_TOKEN', exact: true });
    await dialog.getByRole('radio', { name: 'Environment variable', exact: true }).check();
    await dialog.getByLabel('Variable', { exact: true }).fill('STUB_SLACK_TOKEN');
    await dialog.getByRole('button', { name: 'Bind', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(secretRow).toContainText('your login environment (STUB_SLACK_TOKEN)');
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toHaveCount(0);

    await runNow(calls);
    const approval = await openWaitingRun(calls.page);
    // The server, once, below the steps: what it starts, as you, with what.
    const servers = approval.getByRole('region', { name: 'Servers', exact: true });
    await expect(servers.getByText(serverLine(calls), { exact: true })).toBeVisible();
    // Its definition in full: the literal env: as written (review S1).
    await expect(servers.getByText(ENV_LINE, { exact: true })).toBeVisible();
    await expect(servers.getByText(STARTED, { exact: true })).toBeVisible();
    // The post step: a Tool, its arguments as written with their trust, its outputs.
    const post = approval
      .getByRole('listitem')
      .filter({ hasText: 'Calls `slack#chat_post_message`' });
    await expect(post).toHaveCount(1);
    await expect(post.getByText('Tool', { exact: true })).toBeVisible();
    await expect(post.getByText('`channel` = C0SUPPORT1 (literal)', { exact: true })).toBeVisible();
    await expect(
      post.getByText("`text` ← `brief`'s handover (untrusted material)", { exact: true }),
    ).toBeVisible();
    await expect(post.getByText('Outputs: ts', { exact: true })).toBeVisible();
    // Where the secret goes: the server, as its environment; where this Mac binds it.
    const secrets = approval.locator('.automations-secret-lines');
    await expect(secrets.locator('p').nth(1)).toHaveText(
      /^`SLACK_BOT_TOKEN` → server `slack`, as its environment · bound on this Mac to your login environment \(STUB_SLACK_TOKEN\), last changed \d{1,2} [A-Z][a-z]{2}$/,
    );
    await expect(secrets.locator('p').last()).toHaveText(TRUST_LINE);
    // Asking started nothing, and no value is on the page.
    expect(fs.existsSync(calls.files.log)).toBe(false);
    const shown = await pageTexts(calls.page);
    for (const form of formsOf(VALUE)) expect(shown).not.toContain(form);
  } finally {
    await calls.close();
  }
});

test('Approved: the post happens once, its server is gone after, and the token is nowhere', async () => {
  test.setTimeout(180_000);
  const calls = await setUpCalls();
  try {
    await openAutomations(calls.page);
    await calls.bind('SLACK_BOT_TOKEN', 'STUB_SLACK_TOKEN');
    await runNow(calls);
    const approval = await openWaitingRun(calls.page);
    await approval.getByRole('button', { name: 'Start', exact: true }).click();
    const [runId] = await runsAre(calls, ['completed']);

    // One call, with the handover as text and the bound value as its token (by its hash).
    const posted = calls.calls();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      tool: 'chat_post_message',
      arguments: { channel: 'C0SUPPORT1', text: HANDOVER },
      tokenSha256: VALUE_SHA256,
    });
    // Its server is gone: the pid it wrote is no longer alive.
    const pids = calls.pids();
    expect(pids).toHaveLength(1);
    await expect.poll(() => alive(pids[0]), { timeout: 10_000 }).toBe(false);

    // The run page: post is a Tool, with what it sent, what came back, and ts.
    const run = await openLatestRun(calls.page);
    const head = stepHead(run, 'post');
    await expect(head.locator('.automations-trace-kind')).toHaveText('Tool');
    await head.click();
    const detail = run.getByRole('region', { name: 'Step post' });
    await expect(detail).toContainText(
      `started \`${[process.execPath, STUB_MCP, '--log', calls.files.log, '--pids', calls.files.pids].join(' ')}\` on this Mac`,
    );
    const args = detail.locator('.automations-call-arg');
    await expect(args).toHaveText([
      '`channel` = C0SUPPORT1 (literal)',
      `\`text\` = {{steps.brief.handover}} → ${HANDOVER} (untrusted material)`,
    ]);
    await expect(detail).toContainText(JSON.stringify({ ts: TS }, null, 2));
    await expect(detail).toContainText(`ts = ${TS}`);
    await expect(detail).not.toContainText(SURVIVORS);

    // Nothing Consola wrote or shows holds the token in any form. The scan can find one.
    const decoy = path.join(calls.base, 'decoy');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'file'), encodeURIComponent(VALUE));
    expect(leaks([decoy], VALUE)).toEqual([
      `${path.join(decoy, 'file')}: ${encodeURIComponent(VALUE)}`,
    ]);
    const profile = `${calls.userDataDir} Test`;
    expect(filesUnder(path.join(calls.folder, 'runs', runId, 'post')).length).toBeGreaterThan(0);
    expect(filesUnder(profile).some((file) => file.endsWith('automation-runs.json'))).toBe(true);
    expect(leaks([calls.folder, profile], VALUE)).toEqual([]);
    const record = JSON.stringify(
      await calls.page.evaluate((id) => window.automationsAPI.getRun(id), runId),
    );
    for (const form of formsOf(VALUE)) expect(record).not.toContain(form);
    const shown = await pageTexts(calls.page);
    for (const form of formsOf(VALUE)) expect(shown).not.toContain(form);
  } finally {
    await calls.close();
  }
});

test('A dry run (notify) would have called the tool, and starts no server', async () => {
  test.setTimeout(180_000);
  const calls = await setUpCalls({ mode: 'notify' });
  try {
    await openAutomations(calls.page);
    await calls.bind('SLACK_BOT_TOKEN', 'STUB_SLACK_TOKEN');
    await runNow(calls);
    const approval = await openWaitingRun(calls.page);
    await approval.getByRole('button', { name: 'Start', exact: true }).click();
    const [runId] = await runsAre(calls, ['completed']);
    const record = await calls.page.evaluate((id) => window.automationsAPI.getRun(id), runId);
    expect(record?.steps?.map((step) => [step.id, step.status])).toEqual([
      ['shipped', 'completed'],
      ['brief', 'completed'],
      ['post', 'reported'],
    ]);
    // `brief` ran, read-only; `post` started nothing.
    expect(calls.launches()).toHaveLength(1);
    expect(fs.existsSync(calls.files.log)).toBe(false);
    expect(fs.existsSync(calls.files.pids)).toBe(false);

    const run = await openLatestRun(calls.page);
    const head = stepHead(run, 'post');
    await expect(head).toContainText('Would have called `slack#chat_post_message`');
    await head.click();
    const detail = run.getByRole('region', { name: 'Step post' });
    await expect(detail.getByRole('heading', { name: 'Would have called' })).toBeVisible();
    await expect(detail.locator('.automations-call-arg')).toHaveText([
      '`channel` = C0SUPPORT1 (literal)',
      `\`text\` = {{steps.brief.handover}} → ${HANDOVER} (untrusted material)`,
    ]);
  } finally {
    await calls.close();
  }
});

test('A call that may have landed: a timed-out call is never repeated by itself, and Retry warns', async () => {
  test.setTimeout(240_000);
  const calls = await setUpCalls({ tool: 'slow_post' });
  try {
    await openAutomations(calls.page);
    await calls.bind('SLACK_BOT_TOKEN', 'STUB_SLACK_TOKEN');
    await runNow(calls);
    const approval = await openWaitingRun(calls.page);
    await approval.getByRole('button', { name: 'Start', exact: true }).click();
    const [runId] = await runsAre(calls, ['failed']);
    const record = await calls.page.evaluate((id) => window.automationsAPI.getRun(id), runId);
    const post = record?.steps?.find((step) => step.id === 'post');
    expect(post?.status).toBe('failed');
    expect(post?.error).toBe(MAY_HAVE_TIMED_OUT);
    expect(post?.call?.intentAt).toBeDefined();
    expect(post?.call?.survivors).toBeUndefined();
    // It settled within the timeout and the close's grace (2 s, then at most 5 s to SIGKILL).
    const took = Date.parse(post?.finishedAt ?? '') - Date.parse(post?.startedAt ?? '');
    expect(took).toBeLessThan(20_000);

    // The stub's work landed after Consola gave up on it: start, then work-done 4 s on.
    await expect
      .poll(() => calls.events().map((event) => event.event), { timeout: 20_000 })
      .toEqual(['list', 'call', 'start', 'work-done']);
    const [, call, start, done] = calls.events();
    expect(call.tool).toBe('slow_post');
    expect(done.at - start.at).toBeGreaterThanOrEqual(3500);
    expect(done.at).toBeGreaterThan(Date.parse(post?.call?.intentAt ?? '') + 2000);
    // Nothing calls it again by itself.
    await calls.page.waitForTimeout(2 * TICK_MS + 1000);
    expect(calls.calls()).toHaveLength(1);

    // The run page: no line saying something it started was still running; Retry warns first.
    const run = await openLatestRun(calls.page);
    const detail = run.getByRole('region', { name: 'Step post' });
    await expect(detail).toContainText(MAY_HAVE_TIMED_OUT);
    await expect(detail).not.toContainText(SURVIVORS);
    await run.getByRole('button', { name: 'Retry from post' }).click();
    const warning = run.getByRole('group', { name: 'Retry from post' });
    await expect(warning).toContainText(RETRY_WARNING);
    await warning.getByRole('button', { name: 'Retry', exact: true }).click();
    // The retry calls once more, and only once.
    await expect.poll(() => calls.calls().length, { timeout: 30_000 }).toBe(2);
    await expect
      .poll(
        async () =>
          (await calls.page.evaluate((id) => window.automationsAPI.getRun(id), runId))?.steps?.find(
            (step) => step.id === 'post',
          )?.attempt,
        { timeout: 30_000 },
      )
      .toBe(2);
    await runsAre(calls, ['failed']);
    await calls.page.waitForTimeout(2 * TICK_MS + 1000);
    expect(calls.calls()).toHaveLength(2);
  } finally {
    await calls.close();
  }
});

test('An edit to the server asks again; a rebinding does not', async () => {
  test.setTimeout(240_000);
  const calls = await setUpCalls();
  try {
    const dashboard = await openAutomations(calls.page);
    await calls.bind('SLACK_BOT_TOKEN', 'STUB_SLACK_TOKEN');
    await runNow(calls);
    await (await openWaitingRun(calls.page))
      .getByRole('button', { name: 'Start', exact: true })
      .click();
    await runsAre(calls, ['completed']);
    expect(calls.calls()).toHaveLength(1);
    await closePanel(calls.page);

    // `--quiet` (which the stub ignores) changes the server's definition: the next run asks.
    const before = (await calls.snapshot()).automations[0].version;
    calls.writeFactory(calls.factoryText({ extraArgs: ['--quiet'] }));
    await expect
      .poll(async () => (await calls.snapshot()).automations[0].version, { timeout: 15_000 })
      .not.toBe(before);
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await runNow(calls);
    const asked = await openWaitingRun(calls.page);
    const servers = asked.getByRole('region', { name: 'Servers', exact: true });
    await expect(servers.getByText(serverLine(calls, ['--quiet']), { exact: true })).toBeVisible();
    await asked.getByRole('button', { name: 'Start', exact: true }).click();
    await runsAre(calls, ['completed', 'completed']);
    expect(calls.calls()).toHaveLength(2);
    await closePanel(calls.page);

    // Rebound to another variable holding the same value: Run now runs at once.
    await calls.bind('SLACK_BOT_TOKEN', 'STUB_SLACK_TOKEN_2');
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await runNow(calls);
    await runsAre(calls, ['completed', 'completed', 'completed']);
    await expect(dashboard.locator('.automations-waiting-card')).toHaveCount(0);
    expect(calls.calls().map((event) => event.tokenSha256)).toEqual([
      VALUE_SHA256,
      VALUE_SHA256,
      VALUE_SHA256,
    ]);
  } finally {
    await calls.close();
  }
});

test('Check server starts the server once, lists its tools and calls none', async () => {
  test.setTimeout(150_000);
  const calls = await setUpCalls({ mode: 'confirm' });
  try {
    await openAutomations(calls.page);
    await calls.bind('SLACK_BOT_TOKEN', 'STUB_SLACK_TOKEN');
    const row = rowOf(calls.page, 'support-briefing');
    await expect(row).not.toContainText('Not running', { timeout: 15_000 });
    await row.getByRole('button', { name: 'support-briefing', exact: true }).click();
    const panel = sidePanel(calls.page);
    await expect(
      panel.getByRole('heading', { name: 'support-briefing', exact: true }),
    ).toBeVisible();

    // The page lists slack with its lines and Check server, though the entry asks before each run.
    const server = panel.getByRole('listitem', { name: 'Server slack', exact: true });
    await expect(server.getByText(serverLine(calls), { exact: true })).toBeVisible();
    await expect(server.getByText(ENV_LINE, { exact: true })).toBeVisible();
    await expect(server.getByText(STARTED, { exact: true })).toBeVisible();
    await server.getByRole('button', { name: 'Check server', exact: true }).click();
    const dialog = calls.page.getByRole('dialog', { name: 'Check `slack`?', exact: true });
    await expect(dialog.getByText(serverLine(calls), { exact: true })).toBeVisible();
    // The confirmation shows the server's definition in full (review S1).
    await expect(dialog.getByText(ENV_LINE, { exact: true })).toBeVisible();
    await expect(
      dialog.getByText('Consola starts it once, lists its tools and stops it. It calls no tool.', {
        exact: true,
      }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Start it once', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });

    await expect(
      server.getByText(/^Checked \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}: 4 tools\.$/),
    ).toBeVisible();
    await expect(
      server.getByText('`post`: `chat_post_message` is there, and its literal values fit', {
        exact: true,
      }),
    ).toBeVisible();
    // It listed the tools and called none; no run was recorded; its process is gone.
    expect(calls.events().map((event) => event.event)).toEqual(['list']);
    expect((await calls.snapshot()).runs).toEqual([]);
    const pids = calls.pids();
    expect(pids).toHaveLength(1);
    await expect.poll(() => alive(pids[0]), { timeout: 10_000 }).toBe(false);
  } finally {
    await calls.close();
  }
});

test('Refused at their lines: unsafe servers and an entry’s uses: are refused, and the folder keeps its last version', async () => {
  test.setTimeout(120_000);
  const calls = await setUpCalls();
  try {
    const dashboard = await openAutomations(calls.page);
    // The version that applies first: the briefing, as every test writes it.
    await expect(rowOf(calls.page, 'support-briefing')).toHaveCount(1, { timeout: 15_000 });

    // The briefing stays in the file (a removal would apply); its server and two more go wrong, and an entry names uses:.
    const written = calls.factoryText();
    const broken = `version: 1
mcpServers:
  slack:
    command: ./stub-mcp.cjs
    secrets: [SLACK_BOT_TOKEN]
  tracker:
    url: https://mcp.tracker.sprocket.example/mcp
    headersHelper: x
  wiki:
    url: https://mcp.wiki.sprocket.example/mcp
    headers: { Authorization: "Bearer abc123" }
${written.slice(written.indexOf('automations:\n'))}  - name: entry-uses
    on: { cron: ${NEVER} }
    scope: catalog-portal
    mode: auto
    uses: slack#chat_post_message
    steps:
      - id: greet
        run: echo hello
`;
    calls.writeFactory(broken);
    // A line's number in the file, by the line exactly as written.
    const lineOf = (text: string) => {
      const at = broken.split('\n').indexOf(text);
      expect(at, text).toBeGreaterThanOrEqual(0);
      return at + 1;
    };

    // The folder does not apply: the version from before keeps running, under the banner.
    const banner = dashboard.locator('.automations-standing');
    await expect(banner).toHaveCount(1, { timeout: 15_000 });
    await expect(banner.locator('.automations-standing-text')).toHaveText(
      /^Your changes didn't apply: .+ keeps running\.$/,
    );
    await expect(rowOf(calls.page, 'support-briefing')).toHaveCount(1);

    const issues = dashboard.locator('.automations-issues-file').filter({
      has: calls.page.locator('.automations-issues-file-head code', { hasText: 'factory.yml' }),
    });
    const issue = (line: number, words: string) =>
      issues
        .locator('li')
        .filter({ hasText: words })
        .filter({ hasText: `line ${line}` });
    await expect(
      issue(
        lineOf('    command: ./stub-mcp.cjs'),
        '`./stub-mcp.cjs` would run whatever is at that path in the folder the server starts in. Use an absolute path, or a program on your `PATH`.',
      ),
    ).toHaveCount(1);
    await expect(
      issue(
        lineOf('    headersHelper: x'),
        'A helper is a command Consola would run on your machine to make headers, and it would be outside what you approved. Put the token in `secrets:` and use it in `headers:`.',
      ),
    ).toHaveCount(1);
    await expect(
      issue(
        lineOf('    headers: { Authorization: "Bearer abc123" }'),
        'This looks like a credential written into the file. Name it in `secrets:` and bind it on each runner.',
      ),
    ).toHaveCount(1);
    await expect(
      issue(
        lineOf('    uses: slack#chat_post_message'),
        '`uses:` is a step: put it under `steps:`.',
      ),
    ).toHaveCount(1);
    // Nothing started: no server, no run.
    expect(fs.existsSync(calls.files.log)).toBe(false);
    expect((await calls.snapshot()).runs).toEqual([]);
  } finally {
    await calls.close();
  }
});

test("A poll entry's Allow card names its call and its server, and nothing starts before Allow", async () => {
  test.setTimeout(120_000);
  const calls = await setUpCalls();
  try {
    await openAutomations(calls.page);
    // The briefing's server, and an entry whose check would fire a call to it (review M6).
    const [servers] = calls.factoryText().split('automations:\n');
    calls.writeFactory(`${servers}automations:
  - name: watch-posts
    on:
      poll:
        every: 1h
        run: printf '[]'
        key: .id
    scope: catalog-portal
    mode: auto
    steps:
      - id: post
        uses: slack#chat_post_message
        with: { channel: C0SUPPORT1, text: "Something new." }
        outputs: { ts: string }
`);
    await calls.bind('SLACK_BOT_TOKEN', 'STUB_SLACK_TOKEN');
    const row = rowOf(calls.page, 'watch-posts');
    await expect(row).toContainText('Needs your OK', { timeout: 15_000 });
    await row.getByRole('button', { name: 'watch-posts', exact: true }).click();
    const card = sidePanel(calls.page).getByRole('region', { name: 'Allow watch-posts' });
    await expect(card).toBeVisible();
    // Its call, as the version Allow accepts holds it: the ref and each argument with its trust.
    const toolCalls = card.getByRole('region', { name: 'Tool calls', exact: true });
    await expect(
      toolCalls.getByText('Calls `slack#chat_post_message`', { exact: true }),
    ).toBeVisible();
    await expect(
      toolCalls.getByText('`channel` = C0SUPPORT1 (literal)', { exact: true }),
    ).toBeVisible();
    // Its server once: what it starts, as you, with what, and its literal env: (review S1).
    const server = toolCalls.getByRole('region', { name: 'Servers', exact: true });
    await expect(server.getByText(serverLine(calls), { exact: true })).toBeVisible();
    await expect(server.getByText(ENV_LINE, { exact: true })).toBeVisible();
    await expect(server.getByText(STARTED, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    // Showing the card started nothing: no check, no server.
    expect(fs.existsSync(calls.files.log)).toBe(false);
    expect((await calls.snapshot()).runs).toEqual([]);
  } finally {
    await calls.close();
  }
});
