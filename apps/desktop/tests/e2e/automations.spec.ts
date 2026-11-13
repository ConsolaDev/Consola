import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron } from './helpers/electron';

/**
 * Personal automations, end to end: a workspace's own factory.yml with a
 * confirm-mode cleanup, run from the Automations dashboard, previewed,
 * approved — and the one session whose PR merged is gone with its worktree
 * and branch, while the one with unsaved work is kept, untouched.
 */

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

/** A worktree on `branch` that tracks it on origin, without needing a reachable origin. */
function worktree(clone: string, root: string, name: string, branch: string): { dir: string; head: string } {
  const dir = path.join(root, name);
  git(clone, 'worktree', 'add', '-q', '-b', branch, dir);
  fs.writeFileSync(path.join(dir, `${name}.txt`), name);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', name);
  git(dir, 'config', `branch.${branch}.remote`, 'origin');
  git(dir, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
  return { dir: fs.realpathSync(dir), head: git(dir, 'rev-parse', 'HEAD') };
}

/** Where Consola reads a workspace's automations, under the test's factory dir. */
function writeFactoryFile(factoryDir: string, workspaceId: string, yaml: string): void {
  fs.mkdirSync(path.join(factoryDir, workspaceId), { recursive: true });
  fs.writeFileSync(path.join(factoryDir, workspaceId, 'factory.yml'), yaml);
}

/** Hold the workspace in this window and open its Automations dashboard from the sidebar row. */
async function openAutomations(page: Page, workspaceName: string) {
  const railButton = page
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: workspaceName, exact: true });
  await railButton.click();
  await expect(railButton).toHaveAttribute('aria-current', 'true');
  await page.locator('.home-navigation').getByRole('button', { name: /^Automations/ }).click();
  return page.getByRole('region', { name: 'Automations', exact: true });
}

/** The side panel, over the dashboard. */
function sidePanel(page: Page) {
  return page.locator('.automations-side-panel');
}

function mergedPull(number: number, branch: string, head: string) {
  return {
    number,
    state: 'closed',
    merged_at: '2026-11-01T10:00:00Z',
    html_url: `https://github.com/acme/app/pull/${number}`,
    created_at: '2026-10-30T10:00:00Z',
    head: { sha: head, ref: branch },
  };
}

test('a confirm-mode cleanup previews, waits for approval, and removes only what is safe', async () => {
  test.setTimeout(120_000);

  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automations-')));
  const clone = path.join(base, 'app');
  const worktreesDir = path.join(base, 'worktrees');
  fs.mkdirSync(worktreesDir);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  fs.writeFileSync(path.join(clone, 'README'), 'app');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'init');
  // Never contacted: every PR head below is already local.
  git(clone, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');

  const done = worktree(clone, worktreesDir, 'app-session-done', 'consola/session-done');
  const dirty = worktree(clone, worktreesDir, 'app-session-dirty', 'consola/session-dirty');
  fs.writeFileSync(path.join(dirty.dir, 'unsaved.txt'), 'work in progress');

  const pulls = path.join(base, 'pulls.txt');
  const endpoint = (branch: string) =>
    `repos/acme/app/pulls?state=all&per_page=20&head=${encodeURIComponent(`acme:${branch}`)}`;
  fs.writeFileSync(
    pulls,
    [
      `${endpoint('consola/session-done')} ${JSON.stringify([mergedPull(7, 'consola/session-done', done.head)])}`,
      `${endpoint('consola/session-dirty')} ${JSON.stringify([mergedPull(8, 'consola/session-dirty', dirty.head)])}`,
    ].join('\n')
  );

  const factoryDir = path.join(base, 'factories');

  const { app, page } = await launchElectron({
    env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_DIR: factoryDir,
      STUB_GH_PULLS: pulls,
    },
  });

  try {
    const workspaceId = await page.evaluate(
      async ([folder]) => {
        const workspace = await window.workspaceAPI.createWorkspace('Acme', folder, true);
        await window.workspaceAPI.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'JaviDev' });
        return workspace.id;
      },
      [clone] as const
    );
    await page.evaluate(
      async ([id, doneDir, dirtyDir]) => {
        const { workspaces } = await window.workspaceAPI.getSnapshot();
        const scopeId = workspaces.find((workspace) => workspace.id === id)!.scopes[0].id;
        for (const [name, cwd] of [
          ['Ship feature', doneDir],
          ['Half-done refactor', dirtyDir],
        ]) {
          await window.workspaceAPI.createSession(id, {
            name,
            workspaceId: id,
            instanceId: `workspace-${id}-session-${name.replace(/\W/g, '')}`,
            harnessId: 'default',
            scopeId,
            cwd,
          });
        }
      },
      [workspaceId, done.dir, dirty.dir] as const
    );
    // The workspace's own file, picked up by the watcher.
    writeFactoryFile(
      factoryDir,
      workspaceId,
      `version: 1
automations:
  - name: clean-up-stale-sessions
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
    mode: confirm
`
    );

    // The dashboard opens on the Automations tab.
    const dashboard = await openAutomations(page, 'Acme');

    const card = dashboard.locator('.automations-row', { hasText: 'clean-up-stale-sessions' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('confirm');
    await expect(card).toContainText('Next run');
    await card.getByRole('button', { name: 'Run now' }).click();

    // Confirm mode: a preview waiting for approval, in "Waiting for you" above
    // the table; Review… opens it, naming what would go.
    const waiting = dashboard.getByRole('region', { name: 'Waiting for you' });
    await expect(waiting).toContainText('Would remove 1 session; 1 kept.', { timeout: 30_000 });
    await waiting.getByRole('button', { name: 'Review…' }).click();
    const pending = sidePanel(page);
    await expect(pending).toContainText('Would remove 1 session; 1 kept.');
    await expect(pending).toContainText('Ship feature');
    await expect(pending).toContainText('#7 merged');
    // Nothing has been touched yet.
    expect(fs.existsSync(done.dir)).toBe(true);

    // Approval acts on exactly what was previewed — the one session — so the
    // kept one is not even reconsidered.
    await pending.getByRole('button', { name: 'Approve' }).click();
    await expect(pending).toContainText('Removed 1 session.', { timeout: 30_000 });
    await dashboard.getByRole('tab', { name: 'Activity' }).click();
    await expect(dashboard.locator('.automations-run-item').first()).toContainText('Completed');

    const remaining = await page.evaluate(async () => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      return workspaces.flatMap((workspace) => workspace.sessions.map((session) => session.name));
    });
    expect(remaining).toEqual(['Half-done refactor']);
    expect(fs.existsSync(done.dir)).toBe(false);
    expect(git(clone, 'branch', '--list', 'consola/session-done')).toBe('');
    // The session with unsaved work kept everything.
    expect(fs.readFileSync(path.join(dirty.dir, 'unsaved.txt'), 'utf8')).toBe('work in progress');
    expect(git(clone, 'branch', '--list', 'consola/session-dirty')).toContain('consola/session-dirty');
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a broken factory.yml is reported with its line, and nothing is scheduled', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automations-bad-')));
  const folder = path.join(base, 'app');
  fs.mkdirSync(folder);
  const factoryDir = path.join(base, 'factories');
  const { app, page } = await launchElectron({ env: { CONSOLA_FACTORY_DIR: factoryDir } });
  try {
    const workspaceId = await page.evaluate(
      async ([dir]) => (await window.workspaceAPI.createWorkspace('Broken', dir, true)).id,
      [folder] as const
    );
    writeFactoryFile(
      factoryDir,
      workspaceId,
      'version: 1\nautomations:\n  - name: sweep\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#cleanup_stale_sessions }\n    mode: sometimes\n'
    );
    const dashboard = await openAutomations(page, 'Broken');
    const issues = dashboard.locator('.automations-issues');
    await expect(issues).toContainText('line 6', { timeout: 15_000 });
    await expect(issues).toContainText('automations[0].mode');
    // Where the dashboard opens: the problem, no rows, and no offer to start from nothing.
    await expect(dashboard.getByRole('tab', { name: 'Automations' })).toHaveAttribute('aria-selected', 'true');
    await expect(dashboard.locator('.automations-row')).toHaveCount(0);
    await expect(dashboard.locator('.automations-empty-state')).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** One open PR in the Inbox's GraphQL shape, asking the person directly for a review. */
function requestedPull(number: number) {
  return {
    __typename: 'PullRequest',
    title: `Add retries #${number}`,
    number,
    state: 'OPEN',
    url: `https://github.com/acme/app/pull/${number}`,
    updatedAt: new Date().toISOString(),
    repository: { nameWithOwner: 'acme/app' },
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

test('a review request starts a read-only session in its worktree; one already waiting starts nothing', async () => {
  test.setTimeout(150_000);

  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-review-requests-')));
  const clone = path.join(base, 'app');
  const worktreesDir = path.join(base, 'worktrees');
  fs.mkdirSync(worktreesDir);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  fs.writeFileSync(path.join(clone, 'README'), 'app');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');

  // The agent CLI: records where it ran and with what, one line per launch.
  // In print mode it answers and exits, as Claude's -p does; otherwise it
  // shows an empty composer and waits.
  const launches = path.join(base, 'launches.log');
  const agent = path.join(base, 'agent.sh');
  fs.writeFileSync(
    agent,
    [
      '#!/bin/sh',
      `printf '%s' "$PWD :: $*" | tr '\\n' ' ' >> '${launches}'`,
      `printf '\\n' >> '${launches}'`,
      `if [ "$1" = "-p" ]; then printf 'FINDINGS: looks good\\n'; exit 0; fi`,
      `printf '\\342\\235\\257 '`,
      'exec sleep 300',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  const inboxFile = path.join(base, 'inbox.json');
  writeInbox(inboxFile, [1]);
  const factoryDir = path.join(base, 'factories');

  const { app, page, userDataDir } = await launchElectron({
    env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      GRAPHQL_INBOX_FIXTURE: inboxFile,
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_DIR: factoryDir,
    },
  });
  let relaunched: typeof app | undefined;

  try {
    const workspaceId = await page.evaluate(
      async ([folder, binaryPath]) => {
        await window.harnessStateAPI.addHarness({ id: 'stub', driverId: 'claude', name: 'Stub', accentColor: '#555555', binaryPath });
        const workspace = await window.workspaceAPI.createWorkspace('Acme', folder, true, 'stub');
        // Binding seeds the default actions, Review among them.
        await window.workspaceAPI.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'JaviDev' });
        return workspace.id;
      },
      [clone, agent] as const
    );
    writeFactoryFile(
      factoryDir,
      workspaceId,
      `version: 1
automations:
  - name: review-requests
    on: { github: [pull_request.review_requested, pull_request.assigned] }
    run: { action: Review }
    mode: auto
`
    );

    const dashboard = await openAutomations(page, 'Acme');
    const automationsTab = dashboard.getByRole('tab', { name: 'Automations' });
    const activityTab = dashboard.getByRole('tab', { name: 'Activity' });
    const card = dashboard.locator('.automations-row', { hasText: 'review-requests' }).first();
    await expect(card).toContainText('When a pull request asks for your review or is assigned to you', { timeout: 15_000 });
    await expect(card).toContainText('Review action');
    await expect(card).toContainText('Agent session, read-only');
    const checkNow = card.getByRole('button', { name: 'Check now' });

    // Turned on with #1 already waiting: that is the baseline, not an event.
    await checkNow.click();
    await expect(checkNow).toBeEnabled();

    // #2 asks. A new `auto` automation asks once before running on its own.
    writeInbox(inboxFile, [1, 2]);
    await checkNow.click();
    const waiting = dashboard.locator('.automations-waiting-card');
    await expect(waiting).toContainText('acme/app#2 “Add retries #2” by @alice', { timeout: 30_000 });
    await expect(waiting).toHaveCount(1);
    expect(fs.existsSync(launches)).toBe(false);
    await waiting.getByRole('button', { name: 'Review…' }).click();
    const panel = sidePanel(page);
    await panel.getByRole('button', { name: 'Start', exact: true }).click();

    // A headless session in #2's own worktree: one unattended turn, restricted,
    // with Consola's MCP only, and its prompt as the argument after `--`.
    const launched = () => (fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n') : []);
    await expect.poll(launched, { timeout: 30_000 }).toHaveLength(1);
    const [first] = launched();
    expect(first.startsWith(`${path.join(worktreesDir, 'app-pr-2')} :: -p --session-id `)).toBe(true);
    for (const flag of ['--restricted', '--strict-mcp-config', '--permission-mode dontAsk', '--tools Read,Grep,Glob --allowedTools mcp__consola__consola_work_item_context']) {
      expect(first).toContain(flag);
    }
    expect(first).toContain(' -- This session was started by the automation "review-requests" for pull request #2');

    // The turn printed its findings and exited: the run is completed.
    await activityTab.click();
    const row = dashboard.locator('.automations-run-item', { hasText: 'Add retries #2' }).first();
    await expect(row).toContainText('Completed', { timeout: 30_000 });

    const sessions = await page.evaluate(async () => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      return workspaces.flatMap((workspace) =>
        workspace.sessions.map((session) => ({
          name: session.name,
          number: session.workItem?.number,
          action: session.workItemAction,
          toolPolicy: session.toolPolicy,
          automation: session.automation?.name,
        }))
      );
    });
    expect(sessions).toEqual([
      { name: 'Add retries #2', number: 2, action: 'Review', toolPolicy: 'read-only', automation: 'review-requests' },
    ]);

    // Approved once: #3 — asking for a review and assigned — starts on its own, once.
    writeInbox(inboxFile, [1, 2, 3], [3]);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await automationsTab.click();
    await checkNow.click();
    await expect.poll(launched, { timeout: 30_000 }).toHaveLength(2);
    expect(launched()[1].startsWith(`${path.join(worktreesDir, 'app-pr-3')} :: -p `)).toBe(true);
    await checkNow.click();
    await expect(checkNow).toBeEnabled();
    expect(launched().filter((line) => line.includes('app-pr-3'))).toHaveLength(1);
    await expect(dashboard.locator('.automations-waiting-card')).toHaveCount(0);
    await activityTab.click();
    // #1, waiting before the automation was turned on, never started.
    expect(launched().some((line) => line.includes('app-pr-1'))).toBe(false);

    // The findings are in #2's tab.
    const review = await page.evaluate(async () => {
      const { workspaces } = await window.workspaceAPI.getSnapshot();
      return workspaces.flatMap((workspace) => workspace.sessions).find((session) => session.name === 'Add retries #2')!;
    });
    await row.click();
    await panel.getByRole('button', { name: 'Open session' }).click();
    const replay = await page.evaluate(
      async (session) =>
        (
          await window.terminalAPI.create({
            instanceId: session.instanceId,
            workspaceId: session.workspaceId,
            cwd: session.cwd!,
            claudeSessionId: session.claudeSessionId,
            resume: true,
          })
        ).replay,
      review
    );
    expect(replay).toContain('FINDINGS: looks good');
    const toolbar = page.locator('.terminal-panel-toolbar');
    await expect(toolbar).toContainText('Read-only · started by review-requests');

    // Continue: the same conversation, interactive now, and still restricted.
    await toolbar.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(launched, { timeout: 30_000 }).toHaveLength(3);
    expect(launched()[2]).toMatch(new RegExp(` :: --resume ${review.claudeSessionId} .*--permission-mode dontAsk .*--restricted`));
    expect(launched()[2]).not.toContain(' -p ');

    // Continue with full tools: a fork under a new id, with nothing restricted.
    await toolbar.getByRole('button', { name: 'Continue with full tools' }).click();
    await expect.poll(launched, { timeout: 30_000 }).toHaveLength(4);
    expect(launched()[3]).toMatch(new RegExp(` :: --resume ${review.claudeSessionId} --fork-session --session-id \\S+`));
    expect(launched()[3]).not.toContain('--restricted');
    await expect(page.locator('.terminal-panel-toolbar')).toHaveCount(0);

    // Relaunched, and the session opened from the sidebar: the window asks for
    // its terminal, and it resumes exactly as restricted as it started.
    await app.close();
    const again = await launchElectron({
      userDataDir,
      env: {
        CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
        GRAPHQL_INBOX_FIXTURE: inboxFile,
        CONSOLA_WORKTREES_DIR: worktreesDir,
        CONSOLA_FACTORY_DIR: factoryDir,
      },
    });
    relaunched = again.app;
    await again.page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'Acme', exact: true }).click();
    const before = launched().length;
    // The review and its full-tools fork share a label; only the review wears the lock.
    const reviewRows = again.page.locator('.session-nav-item').filter({ hasText: 'PR #2 · Review' });
    await expect(reviewRows).toHaveCount(2);
    const lockedRow = reviewRows.filter({ has: again.page.locator('.session-nav-item-read-only') });
    await expect(lockedRow).toHaveCount(1);
    await lockedRow.click();
    const resumed = new RegExp(` :: --resume ${review.claudeSessionId} .*--permission-mode dontAsk .*--restricted`);
    await expect.poll(() => launched().slice(before).some((line) => resumed.test(line)), { timeout: 30_000 }).toBe(true);
  } finally {
    await (relaunched ?? app).close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
