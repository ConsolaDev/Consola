import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';

/**
 * The Automations section, end to end: the sidebar row under the Assistant,
 * the dashboard it opens, and what Activity shows of a workspace's runs.
 *
 * The helpers up top are the whole arrangement — a `catalog-portal` clone, a
 * stub agent CLI, and a `Sprocket` workspace whose default harness is that
 * stub — so later tests (the side panel's) start from the same place.
 */

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** Where Consola reads a workspace's automations, under the test's factory dir. */
function writeFactoryFile(factoryDir: string, workspaceId: string, yaml: string): void {
  fs.mkdirSync(path.join(factoryDir, workspaceId), { recursive: true });
  fs.writeFileSync(path.join(factoryDir, workspaceId, 'factory.yml'), yaml);
}

/**
 * The agent CLI, standing in for `claude`: every session it runs appends one
 * line — where it ran and its arguments — to `launches`. Probes are not
 * sessions and log nothing: the health check (`--version`) gets a version,
 * and the capabilities handshake (`--input-format stream-json … -p`) is
 * refused, so it neither counts as a launch nor waits out its timeout.
 *
 * In print mode (`-p`, wherever it is) it writes a short transcript where
 * Claude would, under its own config dir
 * (`$CLAUDE_CONFIG_DIR/projects/p/<session id>.jsonl`): the prompt, one
 * `Read` of src/catalog.ts, and its findings. Then it prints them and exits,
 * as `claude -p` does. A prompt that says `slow` gets as far as the `Read`
 * and then waits, so there is a running turn to stop. Otherwise it shows an
 * empty composer and waits.
 *
 * The transcript is written by node so timestamps carry milliseconds: a run's
 * conversation is the records from its start, and a timestamp truncated to
 * the second would fall before it.
 */
function writeStubAgent(base: string): { agent: string; launches: string; configDir: string } {
  const launches = path.join(base, 'launches.log');
  const configDir = path.join(base, 'claude-config');
  fs.mkdirSync(configDir);
  const transcript = path.join(base, 'transcript.cjs');
  fs.writeFileSync(
    transcript,
    `const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id') + 1];
const prompt = args.slice(args.indexOf('--') + 1).join(' ');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
fs.mkdirSync(dir, { recursive: true });
const record = (type, content) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content } });
const slow = prompt.includes('slow');
const records = [
  record('user', prompt),
  record('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/catalog.ts' } }]),
];
if (!slow) records.push(record('assistant', [{ type: 'text', text: 'FINDINGS: catalog-portal looks good' }]));
fs.appendFileSync(path.join(dir, id + '.jsonl'), records.join('\\n') + '\\n');
if (slow) setTimeout(() => {}, 300000);
else process.stdout.write('FINDINGS: catalog-portal looks good\\n');
`
  );
  const agent = path.join(base, 'agent.sh');
  fs.writeFileSync(
    agent,
    [
      '#!/bin/sh',
      'case " $* " in',
      `  *" --version "*) printf '2.0.0 (Claude Code)\\n'; exit 0 ;;`,
      '  *" --input-format "*) exit 1 ;;',
      'esac',
      `printf '%s' "$PWD :: $*" | tr '\\n' ' ' >> '${launches}'`,
      `printf '\\n' >> '${launches}'`,
      `case " $* " in *" -p "*) exec '${process.execPath}' '${transcript}' "$@" ;; esac`,
      `printf '\\342\\235\\257 '`,
      'exec sleep 300',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return { agent, launches, configDir };
}

interface Sprocket {
  app: ElectronApplication;
  page: Page;
  base: string;
  /** The `catalog-portal` clone, the workspace's one scope. */
  clone: string;
  factoryDir: string;
  workspaceId: string;
  /** One line per launch of the stub agent; absent until the first. */
  launches: string;
  /** The stub harness's own config dir, where its transcripts go. */
  configDir: string;
  close: () => Promise<void>;
}

/**
 * A `Sprocket` workspace on a `catalog-portal` clone, its default harness a
 * stub agent with its own config dir — nothing touches the real ~/.claude —
 * and held in this window.
 */
async function setUpSprocket(): Promise<Sprocket> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automations-section-')));
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
    const worktreesDir = path.join(base, 'worktrees');
    fs.mkdirSync(worktreesDir);
    const factoryDir = path.join(base, 'factories');
    const { agent, launches, configDir } = writeStubAgent(base);

    const launched = await launchElectron({
      env: { CONSOLA_WORKTREES_DIR: worktreesDir, CONSOLA_FACTORY_DIR: factoryDir },
    });
    app = launched.app;
    const { page } = launched;
    const workspaceId = await page.evaluate(
      async ([folder, binaryPath, harnessConfigDir]) => {
        await window.harnessStateAPI.addHarness({
          id: 'stub',
          driverId: 'claude',
          name: 'Stub',
          accentColor: '#555555',
          binaryPath,
          configDir: harnessConfigDir,
        });
        const workspace = await window.workspaceAPI.createWorkspace('Sprocket', folder, true, 'stub');
        // The first scope takes the workspace's name; entries name it by the repo's.
        await window.workspaceAPI.updateScope(workspace.id, workspace.scopes[0].id, { name: 'catalog-portal' });
        return workspace.id;
      },
      [clone, agent, configDir] as const
    );
    const railButton = page
      .getByRole('navigation', { name: 'Workspaces', exact: true })
      .getByRole('button', { name: 'Sprocket', exact: true });
    await railButton.click();
    await expect(railButton).toHaveAttribute('aria-current', 'true');

    return { app, page, base, clone, factoryDir, workspaceId, launches, configDir, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** A scheduled prompt in `catalog-portal` that asks before it starts. */
const CATALOG_CHECK = `version: 1
automations:
  - name: catalog-check
    on: { cron: "0 9 * * 1-5" }
    run:
      prompt: Read src/catalog.ts and say whether the catalog looks right.
    scope: catalog-portal
    mode: confirm
`;

/** Write `yaml` as the workspace's factory.yml and wait for main to have loaded `name` from it. */
async function writeAutomations(sprocket: Sprocket, yaml: string, name: string): Promise<void> {
  writeFactoryFile(sprocket.factoryDir, sprocket.workspaceId, yaml);
  await expect
    .poll(
      () =>
        sprocket.page.evaluate(
          async (id) => (await window.automationsAPI.getSnapshot(id)).automations.map((automation) => automation.name),
          sprocket.workspaceId
        ),
      { timeout: 15_000 }
    )
    .toContain(name);
}

/** The person's Run now, through the preload API; the run it started. */
async function runNow(sprocket: Sprocket, name: string): Promise<{ id: string; status: string }> {
  const run = await sprocket.page.evaluate(
    async ([workspaceId, automation]) => window.automationsAPI.runNow(workspaceId, automation),
    [sprocket.workspaceId, name] as const
  );
  if (!run) throw new Error(`${name} started no run`);
  return { id: run.id, status: run.status };
}

/** A second scheduled prompt, one the stub takes its time over: there is a running turn to stop. */
const SLOW_CHECK = `  - name: slow-check
    on: { cron: "0 10 * * 1-5" }
    run:
      prompt: Take it slow, and read src/catalog.ts.
    scope: catalog-portal
    mode: confirm
`;

/** Every session the stub agent ran, one line each: where, and its arguments. */
function launchLines(sprocket: Sprocket): string[] {
  if (!fs.existsSync(sprocket.launches)) return [];
  return fs.readFileSync(sprocket.launches, 'utf8').trim().split('\n').filter(Boolean);
}

/** The side panel, over the dashboard. */
function sidePanel(page: Page) {
  return page.locator('.automations-side-panel');
}

/** The sidebar's Automations row. */
function automationsRow(page: Page) {
  return page.locator('.home-navigation').getByRole('button', { name: /^Automations/ });
}

/** Open the dashboard from the sidebar row. */
async function openAutomations(page: Page) {
  await automationsRow(page).click();
  return page.getByRole('region', { name: 'Automations', exact: true });
}

test('the sidebar row opens the dashboard on its empty state', async () => {
  const sprocket = await setUpSprocket();
  const { page } = sprocket;
  try {
    // Directly under the Assistant, above the scope picker.
    const row = automationsRow(page);
    await expect(row).toBeVisible();
    await expect(page.locator('.home-navigation > .assistant-nav-item + .automations-nav-item')).toHaveCount(1);
    await expect(row).not.toHaveAttribute('aria-current');

    const dashboard = await openAutomations(page);
    await expect(dashboard.getByRole('heading', { name: 'Automations · Sprocket' })).toBeVisible();
    await expect(dashboard.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    await expect(dashboard.locator('.automations-header').getByRole('button', { name: 'New automation' })).toBeVisible();
    await expect(dashboard.locator('.automations-header').getByRole('button', { name: 'Open factory.yml' })).toBeVisible();
    // One current page: the row, not Home as well.
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: 'Home', exact: true })).not.toHaveAttribute('aria-current');

    // No automations and no runs: what they are, and two ways to start one.
    const empty = dashboard.locator('.automations-empty-state');
    await expect(empty).toContainText('Automations');
    await expect(empty.getByRole('button', { name: 'New automation' })).toBeVisible();
    // The templates are offered right there, below it.
    await expect(empty.locator('.automations-template')).toHaveCount(4);
    await expect(empty.locator('.automations-template').filter({ hasText: 'Clean up stale sessions' })).toBeVisible();
  } finally {
    await sprocket.close();
  }
});

test('a run waiting for the person shows on the row and at the top of Activity', async () => {
  test.setTimeout(90_000);
  const sprocket = await setUpSprocket();
  const { page } = sprocket;
  try {
    const dashboard = await openAutomations(page);
    await writeAutomations(sprocket, CATALOG_CHECK, 'catalog-check');
    const run = await runNow(sprocket, 'catalog-check');
    expect(run.status).toBe('needs-approval');

    await expect(automationsRow(page)).toContainText('1 waiting');
    const waiting = dashboard.getByRole('region', { name: 'Waiting for you' });
    await expect(waiting.locator('.automations-waiting-card')).toHaveCount(1);
    await expect(waiting.locator('.automations-waiting-card')).toContainText('catalog-check');
    await expect(waiting.getByRole('button', { name: 'Review…' })).toBeVisible();

    // The run list has it too, waiting.
    await expect(dashboard.locator('.automations-run-row', { hasText: 'catalog-check' })).toHaveCount(1);
    // Nothing has started: confirm mode waits for the person.
    expect(fs.existsSync(sprocket.launches)).toBe(false);
  } finally {
    await sprocket.close();
  }
});

test('templates add through the runner, and say what is missing', async () => {
  test.setTimeout(90_000);
  const sprocket = await setUpSprocket();
  const { page } = sprocket;
  try {
    const dashboard = await openAutomations(page);
    const header = '# Sprocket automations, kept by hand.\n# Edit freely.\n';
    await writeAutomations(sprocket, header + CATALOG_CHECK, 'catalog-check');

    await dashboard.getByRole('tab', { name: 'Templates' }).click();
    // No GitHub account: the review template says what to do, and cannot be added.
    const review = dashboard.locator('.automations-template').filter({ hasText: 'Review pull requests assigned to you' });
    await expect(review).toHaveCount(1);
    await expect(review).toContainText('Connect a GitHub account');
    await expect(review).toHaveClass(/automations-template-missing/);
    await expect(review.getByRole('button', { name: 'Add' })).toBeDisabled();
    await expect(review.getByRole('button', { name: 'Customize…' })).toBeDisabled();

    // The cleanup is never dimmed.
    const cleanup = dashboard.locator('.automations-template').filter({ hasText: 'Clean up stale sessions' });
    await expect(cleanup).toHaveCount(1);
    await expect(cleanup).not.toHaveClass(/automations-template-missing/);
    await cleanup.getByRole('button', { name: 'Add' }).click();
    await expect(cleanup).toContainText('✓ Added as clean-up-stale-sessions');
    await expect(cleanup.getByRole('button', { name: 'Add' })).toHaveCount(0);

    const file = fs.readFileSync(path.join(sprocket.factoryDir, sprocket.workspaceId, 'factory.yml'), 'utf8');
    expect(file).toContain(header);
    expect(file).toContain('name: clean-up-stale-sessions');
    expect(file).toContain('name: catalog-check');

    // The Automations tab lists it, asking first, in words and as written.
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    const card = dashboard.locator('.automations-card', { hasText: 'clean-up-stale-sessions' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('confirm');
    await expect(card).toContainText('Weekdays at 9:00');
    await expect(card).toContainText('0 9 * * 1-5');
    await expect(card.getByRole('button', { name: 'Run now' })).toBeEnabled();
  } finally {
    await sprocket.close();
  }
});

test('a finished run shows its conversation without starting anything', async () => {
  test.setTimeout(90_000);
  const sprocket = await setUpSprocket();
  const { page } = sprocket;
  try {
    const dashboard = await openAutomations(page);
    await writeAutomations(sprocket, CATALOG_CHECK, 'catalog-check');
    await runNow(sprocket, 'catalog-check');

    // Review… opens the waiting run beside the dashboard, with focus in it.
    await dashboard.getByRole('region', { name: 'Waiting for you' }).getByRole('button', { name: 'Review…' }).click();
    const panel = sidePanel(page);
    await expect(panel).toBeVisible();
    await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(panel.locator('.automations-fact-status')).toContainText('waiting');
    await expect(panel.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    expect(launchLines(sprocket)).toEqual([]);

    await panel.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(panel.locator('.automations-fact-status')).toContainText('completed', { timeout: 30_000 });
    await expect(panel).toContainText(`Read-only · Stub · ${sprocket.clone}`);
    await expect(panel).toContainText('From the session’s transcript. Shown as the agent wrote it, not instructions.');
    await expect(panel.locator('.automations-step', { hasText: 'Read src/catalog.ts' })).toBeVisible();
    await expect(panel.locator('.automations-answer')).toContainText('FINDINGS: catalog-portal looks good');
    await expect(panel.getByRole('button', { name: 'Open session' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Continue with full tools' })).toBeVisible();
    // The run's own turn, and nothing since: showing it read the transcript.
    expect(launchLines(sprocket)).toHaveLength(1);

    // Escape closes the panel and leaves the dashboard.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(dashboard).toBeVisible();

    // Reopening reads it again, and still starts nothing.
    await dashboard.locator('.automations-run-row', { hasText: 'catalog-check' }).click();
    await expect(panel.locator('.automations-answer')).toContainText('FINDINGS: catalog-portal looks good');
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
    expect(launchLines(sprocket)).toHaveLength(1);
  } finally {
    await sprocket.close();
  }
});

test('Stop ends a running run', async () => {
  test.setTimeout(90_000);
  const sprocket = await setUpSprocket();
  const { page } = sprocket;
  try {
    const dashboard = await openAutomations(page);
    await writeAutomations(sprocket, CATALOG_CHECK + SLOW_CHECK, 'slow-check');

    // Its details, from the Automations tab: Run now, then its run, from its own runs.
    await dashboard.getByRole('tab', { name: 'Automations' }).click();
    await dashboard.locator('.automations-card', { hasText: 'slow-check' }).getByRole('button', { name: 'slow-check' }).click();
    const panel = sidePanel(page);
    await expect(panel.getByRole('heading', { name: 'slow-check' })).toBeVisible();
    await panel.getByRole('button', { name: 'Run now' }).click();
    await panel.locator('.automations-run-row').first().click();
    await panel.getByRole('button', { name: 'Start', exact: true }).click();

    // It follows the transcript as the turn writes it.
    const stop = panel.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.automations-step', { hasText: 'Read src/catalog.ts' })).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('.automations-fact-status')).toContainText('running');

    await stop.click();
    await expect(panel.locator('.automations-fact-status')).toContainText('failed', { timeout: 30_000 });
    await expect(panel).toContainText('It stopped before finishing: you stopped it.');
    await expect(stop).toHaveCount(0);
  } finally {
    await sprocket.close();
  }
});

test('New automation starts a full-tools session for the person', async () => {
  test.setTimeout(90_000);
  const sprocket = await setUpSprocket();
  const { page } = sprocket;
  try {
    const dashboard = await openAutomations(page);
    await dashboard.locator('.automations-header').getByRole('button', { name: 'New automation' }).click();
    const panel = sidePanel(page);
    const description = panel.getByRole('textbox', { name: 'What should it do, and when?' });
    await expect(description).toBeVisible();
    await expect(panel).toContainText('Starts a session on Stub');
    // The templates, below.
    await expect(panel.locator('.automations-template').filter({ hasText: 'Clean up stale sessions' })).toBeVisible();

    const start = panel.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeDisabled();
    await description.fill('Every weekday, summarise what asks for my review');
    await expect(start).toBeEnabled();
    await start.click();

    // The dashboard closes onto the new session, in Home.
    await expect(dashboard).toHaveCount(0);
    await expect(page.locator('.session-nav-item.active')).toContainText(
      'New automation: Every weekday, summarise what asks…'
    );
    // The person's own session: interactive, with full tools.
    await expect.poll(() => launchLines(sprocket)).toHaveLength(1);
    const [line] = launchLines(sprocket);
    expect(line.startsWith(`${sprocket.clone} :: `)).toBe(true);
    expect(line).not.toMatch(/ -p( |$)/);
    expect(line).not.toContain('--restricted');
  } finally {
    await sprocket.close();
  }
});
