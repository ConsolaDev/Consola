import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectron, settingsChord } from './helpers/electron';

/**
 * Secrets, end to end (phase 5a-1): an entry that names a secret runs
 * nothing until this Mac binds the name; Settings › Secrets binds it; a run
 * reads its value once, gives it to the one command that names it, and
 * masks it in everything Consola writes; a check command gets its own; and
 * the places a secret may not go are refused at their lines.
 *
 * No test reads a keychain or 1Password (rule 5a-secrets). A value comes
 * from the app's own environment, through the fixture login shell, by an
 * `env:` binding; a `keychain:` binding is read by the stub `security`
 * (`tests/fixtures/stub-security`), which `CONSOLA_E2E_SECURITY` names in the
 * app's launch environment. `CONSOLA_E2E_OP` is empty, so 1Password has no
 * program at all. The engine ticks every two seconds.
 *
 * Each test launches its own app on its own temp base, and `close()` removes
 * all of it, profile included.
 */

const FIXTURES = path.resolve(__dirname, '../fixtures');
const STUB_GH_DIR = path.join(FIXTURES, 'stub-gh');
const STUB_SECURITY = path.join(FIXTURES, 'stub-security');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** The engine's tick in these tests, in milliseconds. */
const TICK_MS = 2000;

/** A fake value full of characters that change when printed (Review Focus 1). Never a real token's shape. */
const VALUE = 'stub-pager-secret-7f3a"\\back%slash';
/** What the stub keychain holds for the workspace's default item. */
const KEYCHAIN_VALUE = 'stub-keychain-secret-2b';

/** Every printed form of a value Consola must never write: raw, JSON-escaped, percent-encoded, base64. */
function formsOf(value: string): string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, 'utf8').toString('base64'),
  ];
}

/** `text` as a RegExp source that matches it literally: every metacharacter escaped, backslash included. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UNBOUND = 'needs `PAGER_TOKEN` bound on this Mac (Settings › Secrets)';
const ENV_LABEL = 'your login environment (STUB_PAGER_TOKEN)';
const ENV_NOTE =
  'An env: binding hides nothing from agents or from commands that do not name it: every session on host, and every command, starts with your whole login environment.';
const TRUST_LINE =
  "Where a secret is bound is this Mac's setting, not the file's: changing it does not ask again.";
const AGENT_SECRETS_REASON =
  'A secret given to an agent can reach its model, its transcript and its pane. Give it to the command or server that needs it.';
const ENTRY_SECRETS_REASON = '`secrets:` goes on the step that needs it.';
const GH_TOKEN_REASON =
  "`GH_TOKEN` is the workspace's bound GitHub account's to set (decision 37): commands act as that account. To act as another, bind it to the workspace.";
const TEMPLATE_REASON =
  'A secret reaches a command only as its own variable: add `secrets: [PAGER_TOKEN]` and use `$PAGER_TOKEN`.';

/** The cron is never due (31 February), so only Run now starts it. */
const NEVER = '"0 0 31 2 *"';

/**
 * `page-on-call`: one command, given `PAGER_TOKEN`, that writes the value
 * under a name of its own (`.seen`), as an output to `$CONSOLA_OUTPUT`, and
 * to stdout. Only what Consola writes is masked: `.seen` is the command's.
 */
const PAGE_ON_CALL = `- name: page-on-call
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: page
      run: |
        printf '%s' "$PAGER_TOKEN" > "$CONSOLA_OUTPUT.seen"
        printf 'note=%s\\n' "$PAGER_TOKEN" >> "$CONSOLA_OUTPUT"
        printenv PAGER_TOKEN
        echo done
      outputs: { note: string }
      secrets: [PAGER_TOKEN]`;

/** `watch-tickets`: a check command that prints its secret on stderr and fails. */
const WATCH_TICKETS = `- name: watch-tickets
  on:
    poll:
      every: 1h
      run: echo "token $TRACKER_TOKEN" >&2; exit 1
      key: .id
      secrets: [TRACKER_TOKEN]
  scope: catalog-portal
  mode: auto
  steps:
    - id: note
      run: echo seen`;

/** An entry that names no secret: the version a broken folder keeps running. */
const HELLO = `- name: hello
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: greet
      run: echo hello`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A file's lines, none when it does not exist. */
function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** Every file under `dir`, recursively (`dir` itself when it is a file); none when it does not exist. */
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
function leaks(dirs: string[], value: string, except: (file: string) => boolean): string[] {
  const forms = formsOf(value);
  return dirs.flatMap((dir) =>
    filesUnder(dir)
      .filter((file) => !except(file))
      .flatMap((file) => {
        const text = fs.readFileSync(file).toString('latin1');
        return forms.filter((form) => text.includes(form)).map((form) => `${file}: ${form}`);
      }),
  );
}

interface Secrets {
  app: ElectronApplication;
  page: Page;
  base: string;
  userDataDir: string;
  factoryDir: string;
  workspaceId: string;
  /** The workspace's data folder: its factory.yml, agents/, and its runs/. */
  folder: string;
  files: { securityItems: string; securityLog: string };
  /** Every line the stub `security` logged: one argv per call. */
  securityLog(): string[];
  /** The workspace's factory folder holds exactly these entries (and these other files). */
  writeFactory(entries: string[], others?: Record<string, string>): void;
  /** Binds a name through the window's own API: what Settings › Secrets' Bind sends. */
  bind(name: string, reference: { kind: 'env'; name: string }): Promise<void>;
  snapshot(): Promise<{
    runs: Array<{ id: string; status: string; automation: string }>;
    automations: Array<{ name: string; problem?: string; unbound?: string[] }>;
  }>;
  close(): Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, bound to GitHub as
 * JaviDev, held in this window, with `factory.yml` holding `entries`.
 * `STUB_PAGER_TOKEN` is in the app's environment, so the login shell passes
 * it on, and the stub `security` is the test run's keychain program.
 */
async function setUpSecrets(
  entries: string[],
  options: {
    /** Runs before the app launches, with the folder main keeps its state in (`${userDataDir} Test`). */
    beforeLaunch?: (profile: string) => void;
  } = {},
): Promise<Secrets> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-secrets-')));
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
    const files = {
      securityItems: path.join(base, 'security-items.json'),
      securityLog: path.join(base, 'security.log'),
    };
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
      STUB_PAGER_TOKEN: VALUE,
      // The test run's keychain program is the stub; 1Password has none (an empty stub is no stub).
      CONSOLA_E2E_SECURITY: STUB_SECURITY,
      CONSOLA_E2E_OP: '',
      STUB_SECURITY_ITEMS: files.securityItems,
      STUB_SECURITY_LOG: files.securityLog,
    };
    const userDataDir = path.join(base, 'profile');
    if (options.beforeLaunch) {
      fs.mkdirSync(`${userDataDir} Test`, { recursive: true });
      options.beforeLaunch(`${userDataDir} Test`);
    }
    const launched = await launchElectron({ userDataDir, env, strictLaunches: true });
    app = launched.app;
    const { page } = launched;
    const workspaceId = await page.evaluate(async (folder) => {
      const workspace = await window.workspaceAPI.createWorkspace('Sprocket', folder, true);
      // The first scope takes the workspace's name; entries name it by the repo's.
      await window.workspaceAPI.updateScope(workspace.id, workspace.scopes[0].id, {
        name: 'catalog-portal',
      });
      await window.workspaceAPI.setProviderBinding(workspace.id, {
        id: 'github',
        accountLogin: 'JaviDev',
      });
      return workspace.id;
    }, clone);
    const folder = path.join(factoryDir, workspaceId);
    const write = (relative: string, text: string) => {
      const file = path.join(folder, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = path.join(base, `.write-${path.basename(relative)}`);
      fs.writeFileSync(temporary, text);
      fs.renameSync(temporary, file);
    };
    const writeFactory = (list: string[], others: Record<string, string> = {}) => {
      for (const [relative, text] of Object.entries(others)) write(relative, text);
      write('factory.yml', `version: 1\nautomations:\n${list.join('\n').replace(/^/gm, '  ')}\n`);
    };
    writeFactory(entries);
    const railButton = page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Sprocket', exact: true });
    await railButton.click();
    await expect(railButton).toHaveAttribute('aria-current', 'true');

    return {
      app,
      page,
      base,
      userDataDir,
      factoryDir,
      workspaceId,
      folder,
      files,
      securityLog: () => lines(files.securityLog),
      writeFactory,
      bind: (name, reference) =>
        page.evaluate(([id, secret, ref]) => window.secretsAPI.bind(id, secret, ref), [
          workspaceId,
          name,
          reference,
        ] as const),
      snapshot: () =>
        page.evaluate(async (id) => {
          const snapshot = await window.automationsAPI.getSnapshot(id);
          return {
            runs: snapshot.runs.map((run) => ({
              id: run.id,
              status: run.status,
              automation: run.automation,
            })),
            automations: snapshot.automations.map((view) => ({
              name: view.name,
              ...(view.problem !== undefined ? { problem: view.problem } : {}),
              ...(view.unbound !== undefined ? { unbound: view.unbound } : {}),
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

/** One name's row on Settings › Secrets. */
function secretRow(page: Page, name: string): Locator {
  return settingsOf(page).getByRole('listitem', { name, exact: true });
}

/** Close the Settings dialog. */
async function closeSettings(page: Page): Promise<void> {
  const modal = settingsOf(page);
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

/** Bind… or Change… on a row, then the Bind dialog's kind, a field, and Bind. */
async function bindInSettings(
  page: Page,
  name: string,
  action: 'Bind…' | 'Change…',
  kind: 'Keychain' | 'Environment variable',
  variable?: string,
): Promise<void> {
  await secretRow(page, name).getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Bind ${name}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: kind, exact: true }).check();
  if (variable !== undefined) await dialog.getByLabel('Variable', { exact: true }).fill(variable);
  await dialog.getByRole('button', { name: 'Bind', exact: true }).click();
  await expect(dialog).toHaveCount(0);
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

/** Waits for the workspace to hold `count` runs, every one settled `completed`. */
async function runsCompleted(secrets: Secrets, count: number): Promise<string[]> {
  await expect
    .poll(async () => (await secrets.snapshot()).runs.map((run) => run.status), { timeout: 60_000 })
    .toEqual(Array(count).fill('completed'));
  return (await secrets.snapshot()).runs.map((run) => run.id);
}

/** A run's attempt folder for step `page`'s first attempt. */
function attemptDir(secrets: Secrets, runId: string, step = 'page'): string {
  return path.join(secrets.folder, 'runs', runId, step, '1');
}

/** Every page of the window as a person reads it, and the markup under it. */
async function pageTexts(page: Page): Promise<string> {
  return page.evaluate(() => `${document.body.innerText}\n${document.documentElement.outerHTML}`);
}

test('Unbound: an entry that needs a secret says so, offers Bind…, and runs nothing', async () => {
  test.setTimeout(120_000);
  const secrets = await setUpSecrets([PAGE_ON_CALL]);
  try {
    await openAutomations(secrets.page);
    const row = rowOf(secrets.page, 'page-on-call');
    await expect(row).toContainText(`Not running: ${UNBOUND}`, { timeout: 15_000 });
    await expect(row.getByRole('button', { name: 'Bind…', exact: true })).toBeVisible();
    // Run now: the row's is off, and main's answer is the same words.
    await expect(row.getByRole('button', { name: 'Run now' })).toBeDisabled();
    const refused = await secrets.page.evaluate(
      (id) =>
        window.automationsAPI.runNow(id, 'page-on-call').then(
          () => 'ran',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      secrets.workspaceId,
    );
    expect(refused).toContain(`page-on-call cannot run: ${UNBOUND}`);
    const snapshot = await secrets.snapshot();
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.automations).toEqual([
      { name: 'page-on-call', problem: UNBOUND, unbound: ['PAGER_TOKEN'] },
    ]);
    // Nothing ran: no run folder, and nothing asked the keychain.
    expect(filesUnder(path.join(secrets.folder, 'runs'))).toEqual([]);
    expect(secrets.securityLog()).toEqual([]);
  } finally {
    await secrets.close();
  }
});

test('Bind in Settings: Bind… opens Settings › Secrets, binds an env: reference, and the entry runs again', async () => {
  test.setTimeout(120_000);
  const secrets = await setUpSecrets([PAGE_ON_CALL]);
  try {
    await openAutomations(secrets.page);
    const row = rowOf(secrets.page, 'page-on-call');
    await expect(row).toContainText(`Not running: ${UNBOUND}`, { timeout: 15_000 });
    await row.getByRole('button', { name: 'Bind…', exact: true }).click();

    const modal = settingsOf(secrets.page);
    await expect(modal).toBeVisible();
    await expect(modal.locator('.settings-modal-nav-item.active')).toHaveText('Secrets');
    const secretPage = secretRow(secrets.page, 'PAGER_TOKEN');
    await expect(secretPage).toContainText('not bound');
    await expect(secretPage).toContainText('`page-on-call` · step `page`');
    await expect(secretPage.getByRole('button', { name: 'Bind…', exact: true })).toBeVisible();

    await bindInSettings(
      secrets.page,
      'PAGER_TOKEN',
      'Bind…',
      'Environment variable',
      'STUB_PAGER_TOKEN',
    );
    await expect(secretPage).toContainText(ENV_LABEL);
    await expect(secretPage).toContainText(/last changed \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}/);
    await expect(secretPage).toContainText(ENV_NOTE);
    await expect(secretPage.getByRole('button', { name: 'Change…', exact: true })).toBeVisible();
    await expect(secretPage.getByRole('button', { name: 'Unbind', exact: true })).toBeVisible();
    await closeSettings(secrets.page);

    // Bound: the entry resolves cleanly again.
    await expect(row).not.toContainText('Not running', { timeout: 15_000 });
    await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled();

    // The bindings file holds the reference, never the value.
    const file = path.join(`${secrets.userDataDir} Test`, 'secret-bindings.json');
    const text = fs.readFileSync(file, 'utf8');
    const stored = JSON.parse(text) as {
      workspaces: Record<string, { factories: Record<string, Record<string, { ref: string }>> }>;
    };
    expect(stored.workspaces[secrets.workspaceId].factories.personal.PAGER_TOKEN.ref).toBe(
      'env:STUB_PAGER_TOKEN',
    );
    for (const form of formsOf(VALUE)) expect(text).not.toContain(form);

    // Unbind: the name reads unbound again, and so does the entry.
    await openSecretsSettings(secrets.page);
    await secretPage.getByRole('button', { name: 'Unbind', exact: true }).click();
    await expect(secretPage).toContainText('not bound');
    await expect(secretPage.getByRole('button', { name: 'Bind…', exact: true })).toBeVisible();
    await closeSettings(secrets.page);
    await expect(row).toContainText(`Not running: ${UNBOUND}`, { timeout: 15_000 });
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof stored;
    expect(after.workspaces[secrets.workspaceId]?.factories.personal?.PAGER_TOKEN).toBeUndefined();
  } finally {
    await secrets.close();
  }
});

test('Run, masked: the command gets its secret, and nothing Consola writes or shows holds it', async () => {
  test.setTimeout(180_000);
  const secrets = await setUpSecrets([PAGE_ON_CALL]);
  try {
    const dashboard = await openAutomations(secrets.page);
    await secrets.bind('PAGER_TOKEN', { kind: 'env', name: 'STUB_PAGER_TOKEN' });
    const row = rowOf(secrets.page, 'page-on-call');
    await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Run now' }).click();

    // `auto` asks once: the card says where the secret goes and where it is bound, and no value.
    const approval = await openWaitingRun(secrets.page);
    const lines = approval.locator('.automations-secret-lines');
    await expect(lines).toContainText('Secrets');
    await expect(lines.locator('p').nth(1)).toHaveText(
      new RegExp(
        `^\`PAGER_TOKEN\` → command \`page\`, as its environment variable · bound on this Mac to ${literal(ENV_LABEL)}, last changed \\d{1,2} [A-Z][a-z]{2}$`,
      ),
    );
    await expect(lines.locator('p').last()).toHaveText(TRUST_LINE);
    for (const form of formsOf(VALUE)) expect(await approval.innerText()).not.toContain(form);
    await approval.getByRole('button', { name: 'Start', exact: true }).click();
    const [runId] = await runsCompleted(secrets, 1);

    // The step's detail: the secret by name and where it was bound; its log masked.
    await closePanel(secrets.page);
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await dashboard.locator('.automations-run-item').first().click();
    const run = sidePanel(secrets.page);
    await expect(run.getByRole('list', { name: 'Steps of this run' })).toBeVisible();
    const node = run
      .getByRole('list', { name: 'Steps of this run' })
      .getByRole('button', { name: /^page: / });
    // A completed step stays folded until it is opened.
    await node.click();
    const detail = run.getByRole('region', { name: 'Step page' });
    await expect(
      detail.locator('.automations-vars > li').filter({ hasText: /^PAGER_TOKEN = / }),
    ).toHaveText(`PAGER_TOKEN = secret, from ${ENV_LABEL}`);
    const stdout = detail.locator('.automations-log-stdout');
    await expect(stdout).toBeVisible();
    expect((await stdout.textContent())?.trimEnd()).toBe('***\ndone');

    // The command had the value: it wrote it under a name of its own.
    const dir = attemptDir(secrets, runId);
    expect(fs.readFileSync(path.join(dir, 'outputs.env.seen'), 'utf8')).toBe(VALUE);
    // What Consola names and writes is masked: its $CONSOLA_OUTPUT, the outputs, the log.
    expect(fs.readFileSync(path.join(dir, 'outputs.env'), 'utf8')).toBe('note=***\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'outputs.json'), 'utf8'))).toEqual({
      note: '***',
    });
    expect(fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8')).toBe('***\ndone\n');
    const command = JSON.parse(fs.readFileSync(path.join(dir, 'command.json'), 'utf8')) as {
      secrets?: unknown;
    };
    expect(command.secrets).toEqual([{ name: 'PAGER_TOKEN', secret: true, bound: ENV_LABEL }]);

    // No other file of the run, the run record or its history, the profile, and nothing on the page.
    const profile = `${secrets.userDataDir} Test`;
    const seen = path.join(dir, 'outputs.env.seen');
    // The scan finds the one file the command wrote under its own name, so it can find a leak.
    expect(leaks([dir], VALUE, () => false)).toEqual([`${seen}: ${VALUE}`]);
    expect(leaks([secrets.folder, profile], VALUE, (file) => file === seen)).toEqual([]);
    expect(filesUnder(profile).some((file) => file.endsWith('automation-runs.json'))).toBe(true);
    const record = await secrets.page.evaluate((id) => window.automationsAPI.getRun(id), runId);
    const recorded = JSON.stringify(record);
    for (const form of formsOf(VALUE)) expect(recorded).not.toContain(form);
    expect(recorded).toContain('"secretNames":["PAGER_TOKEN"]');
    const shown = await pageTexts(secrets.page);
    for (const form of formsOf(VALUE)) expect(shown).not.toContain(form);
  } finally {
    await secrets.close();
  }
});

test('A keychain binding read through the stub, once per run, and a rebinding that does not ask again', async () => {
  test.setTimeout(180_000);
  const secrets = await setUpSecrets([PAGE_ON_CALL]);
  try {
    const service = `consola/${secrets.workspaceId}/personal`;
    fs.writeFileSync(
      secrets.files.securityItems,
      JSON.stringify({ [`${service}/PAGER_TOKEN`]: KEYCHAIN_VALUE }),
    );
    const dashboard = await openAutomations(secrets.page);
    await secrets.bind('PAGER_TOKEN', { kind: 'env', name: 'STUB_PAGER_TOKEN' });
    const row = rowOf(secrets.page, 'page-on-call');
    await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Run now' }).click();
    const approval = await openWaitingRun(secrets.page);
    await approval.getByRole('button', { name: 'Start', exact: true }).click();
    const [first] = await runsCompleted(secrets, 1);
    expect(fs.readFileSync(path.join(attemptDir(secrets, first), 'stdout.log'), 'utf8')).toBe(
      '***\ndone\n',
    );
    expect(secrets.securityLog()).toEqual([]);
    await closePanel(secrets.page);

    // Change… to the keychain, at the default service and account the dialog offers.
    await openSecretsSettings(secrets.page);
    await bindInSettings(secrets.page, 'PAGER_TOKEN', 'Change…', 'Keychain');
    await expect(secretRow(secrets.page, 'PAGER_TOKEN')).toContainText(
      `the keychain (${service} · PAGER_TOKEN)`,
    );
    await closeSettings(secrets.page);

    // Run now runs at once: where a name is bound is not part of what was approved.
    await row.getByRole('button', { name: 'Run now' }).click();
    const second = (await runsCompleted(secrets, 2)).find((id) => id !== first) ?? '';
    await expect(dashboard.locator('.automations-waiting-card')).toHaveCount(0);
    expect(fs.readFileSync(path.join(attemptDir(secrets, second), 'stdout.log'), 'utf8')).toBe(
      '***\ndone\n',
    );
    expect(
      fs.readFileSync(path.join(attemptDir(secrets, second), 'outputs.env.seen'), 'utf8'),
    ).toBe(KEYCHAIN_VALUE);
    expect(secrets.securityLog()).toEqual([
      `find-generic-password -s ${service} -a PAGER_TOKEN -w`,
    ]);

    // One read per run.
    await row.getByRole('button', { name: 'Run now' }).click();
    await runsCompleted(secrets, 3);
    expect(secrets.securityLog()).toEqual([
      `find-generic-password -s ${service} -a PAGER_TOKEN -w`,
      `find-generic-password -s ${service} -a PAGER_TOKEN -w`,
    ]);
    const profile = `${secrets.userDataDir} Test`;
    expect(
      leaks([path.join(secrets.folder, 'runs'), profile], KEYCHAIN_VALUE, (file) =>
        file.endsWith('outputs.env.seen'),
      ),
    ).toEqual([]);
  } finally {
    await secrets.close();
  }
});

test('A check names a secret: the Allow card says where it goes, and its failure is masked', async () => {
  test.setTimeout(120_000);
  const secrets = await setUpSecrets([WATCH_TICKETS]);
  try {
    await openAutomations(secrets.page);
    await secrets.bind('PAGER_TOKEN', { kind: 'env', name: 'STUB_PAGER_TOKEN' });
    await secrets.bind('TRACKER_TOKEN', { kind: 'env', name: 'STUB_PAGER_TOKEN' });
    const row = rowOf(secrets.page, 'watch-tickets');
    await expect(row).toContainText('Needs your OK', { timeout: 15_000 });
    await row.getByRole('button', { name: 'watch-tickets', exact: true }).click();
    const panel = sidePanel(secrets.page);
    const card = panel.getByRole('region', { name: 'Allow watch-tickets' });
    await expect(card).toBeVisible();
    const lines = card.locator('.automations-secret-lines');
    await expect(lines).toContainText(
      new RegExp(
        `\`TRACKER_TOKEN\` → this automation's check, as its environment variable · bound on this Mac to ${literal(ENV_LABEL)}, last changed \\d{1,2} [A-Z][a-z]{2}`,
      ),
    );
    await expect(lines).toContainText('`PAGER_TOKEN` and `TRACKER_TOKEN` are the same variable');
    await expect(lines.locator('p').last()).toHaveText(TRUST_LINE);
    await card.getByRole('button', { name: 'Allow', exact: true }).click();

    // The check ran with its secret, failed, and its status line is masked.
    await expect(panel).toContainText('Last check failed: exit 1: token ***', {
      timeout: 30_000,
    });
    const shown = await pageTexts(secrets.page);
    for (const form of formsOf(VALUE)) expect(shown).not.toContain(form);
    expect(leaks([secrets.folder, `${secrets.userDataDir} Test`], VALUE, () => false)).toEqual([]);
  } finally {
    await secrets.close();
  }
});

test('Refused at their lines: an agent file, an entry, a GH_TOKEN and a template, while the last applied version runs', async () => {
  test.setTimeout(120_000);
  const secrets = await setUpSecrets([HELLO]);
  try {
    const dashboard = await openAutomations(secrets.page);
    await expect(rowOf(secrets.page, 'hello')).toHaveCount(1, { timeout: 15_000 });

    secrets.writeFactory(
      [
        HELLO,
        `- name: brief
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: tell
      agent: briefer`,
        `- name: entry-secrets
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  secrets: [PAGER_TOKEN]
  steps:
    - id: page
      run: echo page`,
        `- name: gh-token
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: page
      run: echo page
      env: { GH_TOKEN: x }`,
        `- name: template-secret
  on: { cron: ${NEVER} }
  scope: catalog-portal
  mode: auto
  steps:
    - id: page
      run: echo page
      env:
        TOKEN: "{{secrets.PAGER_TOKEN}}"`,
      ],
      {
        'agents/briefer.md':
          '---\nsecrets: [SLACK_BOT_TOKEN]\n---\nBrief the team on what changed.\n',
      },
    );

    // The folder does not apply: the version from before keeps running, under the banner.
    const banner = dashboard.locator('.automations-standing');
    await expect(banner).toHaveCount(1, { timeout: 15_000 });
    await expect(banner.locator('.automations-standing-text')).toHaveText(
      /^Your changes didn't apply: .+ keeps running\.$/,
    );
    await expect(rowOf(secrets.page, 'hello')).toHaveCount(1);

    const issues = (file: string) =>
      dashboard.locator('.automations-issues-file').filter({
        has: secrets.page.locator('.automations-issues-file-head code', { hasText: file }),
      });
    await expect(issues('agents/briefer.md')).toContainText(AGENT_SECRETS_REASON);
    const yml = issues('factory.yml');
    await expect(yml).toContainText(ENTRY_SECRETS_REASON);
    await expect(yml).toContainText(GH_TOKEN_REASON);
    await expect(yml).toContainText(TEMPLATE_REASON);
  } finally {
    await secrets.close();
  }
});

test('A bindings file that does not read: no name reads as bound, the tab says why, and a fix shows at the next look', async () => {
  test.setTimeout(120_000);
  const BROKEN = 'not json {';
  const secrets = await setUpSecrets([PAGE_ON_CALL], {
    beforeLaunch: (profile) => fs.writeFileSync(path.join(profile, 'secret-bindings.json'), BROKEN),
  });
  try {
    const file = path.join(`${secrets.userDataDir} Test`, 'secret-bindings.json');
    await openAutomations(secrets.page);
    const row = rowOf(secrets.page, 'page-on-call');
    await expect(row).toContainText(`Not running: ${UNBOUND}`, { timeout: 15_000 });
    await row.getByRole('button', { name: 'Bind…', exact: true }).click();
    const modal = settingsOf(secrets.page);
    await expect(modal).toContainText(
      "Consola couldn't read secret-bindings.json (it isn't readable JSON), so no secret reads as bound; fix or remove the file, then reopen this tab.",
    );
    await expect(
      secretRow(secrets.page, 'PAGER_TOKEN').getByRole('button', { name: 'Bind…', exact: true }),
    ).toBeDisabled();
    // Nothing wrote over what it could not read: the workspace's creation and edits pruned nothing (review S5).
    expect(fs.readFileSync(file, 'utf8')).toBe(BROKEN);
    await closeSettings(secrets.page);

    // Fixed by hand, binding the name: the tab reads it at its next look, and every workspace reloads (review S4).
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        workspaces: {
          [secrets.workspaceId]: {
            factories: {
              personal: {
                PAGER_TOKEN: { ref: 'env:STUB_PAGER_TOKEN', boundAt: '2026-11-20T12:00:00.000Z' },
              },
            },
          },
        },
      }),
    );
    await openSecretsSettings(secrets.page);
    await expect(secretRow(secrets.page, 'PAGER_TOKEN')).toContainText(ENV_LABEL);
    await expect(settingsOf(secrets.page)).not.toContainText("couldn't read secret-bindings.json");
    await closeSettings(secrets.page);
    await expect(row).not.toContainText('Not running', { timeout: 15_000 });
    await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled();
  } finally {
    await secrets.close();
  }
});

/** Settings › Secrets, through the Settings chord and its list: a bound name's row offers no Bind…. */
async function openSecretsSettings(page: Page): Promise<void> {
  await page.keyboard.press(settingsChord());
  const modal = settingsOf(page);
  await expect(modal).toBeVisible();
  await modal
    .getByRole('navigation', { name: 'Settings sections', exact: true })
    .getByRole('button', { name: 'Secrets', exact: true })
    .click();
  await expect(modal.locator('.settings-modal-nav-item.active')).toHaveText('Secrets');
}
