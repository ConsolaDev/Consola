import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchElectron, settingsChord } from './helpers/electron';

/**
 * Personal automations, end to end: a factory.yml with a confirm-mode
 * cleanup, run from Settings, previewed, approved — and the one session
 * whose PR merged is gone with its worktree and branch, while the one with
 * unsaved work is kept, untouched.
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

  const factoryFile = path.join(base, 'factory.yml');
  fs.writeFileSync(
    factoryFile,
    `version: 1
automations:
  - name: clean-up-stale-sessions
    on: { cron: "0 9 * * *" }
    run: consola#cleanup_stale_sessions
    with: { pr_states: [merged, closed] }
    mode: confirm
`
  );

  const { app, page } = await launchElectron({
    env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      CONSOLA_WORKTREES_DIR: worktreesDir,
      CONSOLA_FACTORY_FILE: factoryFile,
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

    await page.keyboard.press(settingsChord());
    const settings = page.getByRole('dialog');
    await settings.getByRole('button', { name: 'Automations', exact: true }).click();

    const card = settings.locator('.automations-card', { hasText: 'clean-up-stale-sessions' }).first();
    await expect(card).toContainText('confirm');
    await expect(card).toContainText('Next run');
    await card.getByRole('button', { name: 'Run now' }).click();

    // Confirm mode: a preview waiting for approval, naming what would go.
    const pending = settings.locator('.automations-card-waiting');
    await expect(pending).toContainText('Would remove 1 session; 1 kept.', { timeout: 30_000 });
    await expect(pending).toContainText('Ship feature');
    await expect(pending).toContainText('#7 merged');
    // Nothing has been touched yet.
    expect(fs.existsSync(done.dir)).toBe(true);

    // Approval acts on exactly what was previewed — the one session — so the
    // kept one is not even reconsidered.
    await pending.getByRole('button', { name: 'Approve' }).click();
    await expect(settings.locator('.automations-history-row').first()).toContainText(
      'Removed 1 session.',
      { timeout: 30_000 }
    );

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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automations-bad-'));
  const factoryFile = path.join(base, 'factory.yml');
  fs.writeFileSync(
    factoryFile,
    'version: 1\nautomations:\n  - name: sweep\n    on: { cron: "0 9 * * *" }\n    run: consola#cleanup_stale_sessions\n    mode: sometimes\n'
  );
  const { app, page } = await launchElectron({ env: { CONSOLA_FACTORY_FILE: factoryFile } });
  try {
    await page.keyboard.press(settingsChord());
    const settings = page.getByRole('dialog');
    await settings.getByRole('button', { name: 'Automations', exact: true }).click();
    const issues = settings.locator('.automations-issues');
    await expect(issues).toContainText('line 6');
    await expect(issues).toContainText('automations[0].mode');
    await expect(settings.locator('.automations-card')).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
