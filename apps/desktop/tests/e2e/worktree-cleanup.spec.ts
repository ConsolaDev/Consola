import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProfileDir, launchElectron } from './helpers/electron';
import { createBuiltInHarness } from '../../src/shared/harness';

/**
 * Worktrees removed when their work is done: deleting a session takes its
 * worktree with it, unless the worktree holds something; and a session whose
 * worktree a rule removed gets it back, at the same commit, when opened.
 */

const WORKSPACE_NAME = 'Sprocket';
const DAY = 24 * 60 * 60_000;

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let base: string;
let repo: string;
let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** A worktree under Consola's root on `branch`, one commit ahead, pushed. */
function worktree(name: string, branch: string): string {
  const dir = path.join(root, name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir);
  fs.writeFileSync(path.join(dir, `${name}.txt`), name);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', name);
  git(dir, 'push', '-q', '-u', 'origin', branch);
  return dir;
}

const trees = { done: '', dirty: '', settled: '' };

function seed(): void {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-cleanup-e2e-')));
  repo = path.join(base, 'catalog-portal');
  root = path.join(base, 'worktrees');
  const origin = path.join(base, 'origin.git');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(repo, 'README.md'), '# catalog-portal\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'push', '-q', 'origin', 'main');
  trees.done = worktree('catalog-portal-session-done', 'consola/session-done');
  trees.dirty = worktree('catalog-portal-session-dirty', 'consola/session-dirty');
  fs.writeFileSync(path.join(trees.dirty, 'notes.md'), 'not committed anywhere');
  trees.settled = worktree('catalog-portal-session-settled', 'consola/session-settled');

  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  // A CLI that paints an empty composer and waits: enough to open a session.
  const stubPath = path.join(base, 'idle-cli.sh');
  fs.writeFileSync(stubPath, "#!/bin/sh\nprintf '\\342\\235\\257 '\nsleep 300\n", { mode: 0o755 });
  const stub = {
    ...createBuiltInHarness(),
    id: 'stub',
    name: 'Stub',
    isBuiltIn: false,
    binaryPath: stubPath,
    configDir: path.join(base, 'claude-profile'),
  };
  fs.writeFileSync(
    path.join(effective, 'harnesses.json'),
    JSON.stringify({ version: 1, harnesses: [createBuiltInHarness(), stub] }),
  );
  const old = now - 5 * DAY;
  const session = (id: string, name: string, cwd: string) => ({
    id,
    name,
    workspaceId: 'ws-cleanup-e2e',
    instanceId: `inst-${id}`,
    claudeSessionId: `claude-${id}`,
    hasStarted: false,
    harnessId: 'stub',
    scopeId: 'scope-app',
    kind: 'interactive',
    cwd,
    createdAt: old,
    lastActiveAt: old,
  });
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify({
      version: 8,
      workspaces: [
        {
          id: 'ws-cleanup-e2e',
          name: WORKSPACE_NAME,
          defaultHarnessId: 'stub',
          scopes: [
            {
              id: 'scope-app',
              name: 'catalog-portal',
              path: repo,
              isGitRepo: true,
              createdAt: old,
            },
          ],
          groups: [],
          labels: [],
          actions: [],
          sectionDefaults: {},
          sessions: [
            session('s-done', 'Ship the redirect', trees.done),
            session('s-dirty', 'Draft the notes', trees.dirty),
            session('s-settled', 'Old experiment', trees.settled),
          ],
          createdAt: old,
          updatedAt: old,
        },
      ],
    }),
  );
  // Only the old experiment has been on the Settled shelf, for three days.
  fs.writeFileSync(
    path.join(effective, 'attention-ledger.json'),
    JSON.stringify({
      records: {
        's-settled': {
          sessionId: 's-settled',
          workspaceId: 'ws-cleanup-e2e',
          lastActiveAt: old,
          settledAt: now - 3 * DAY,
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(effective, 'preferences.json'),
    JSON.stringify({
      autoSettleDays: 0,
      hasExplainedAutoSettle: true,
      pendingAutoSettle: [],
      worktreeCleanup: {
        prFinished: false,
        sessionDeleted: true,
        settledDays: 1,
        runFinished: { enabled: false, afterMinutes: 60 },
      },
    }),
  );
}

async function holdWorkspace(target: Page): Promise<void> {
  const button = target
    .getByRole('navigation', { name: 'Workspaces', exact: true })
    .getByRole('button', { name: WORKSPACE_NAME, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
}

const row = (target: Page, name: string) =>
  target.locator('.session-nav-item').filter({ hasText: name });

async function askToDelete(name: string) {
  await row(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  return page.getByRole('dialog', { name: 'Delete session' });
}

test.describe('worktree cleanup', () => {
  test.beforeEach(async () => {
    userDataDir = createProfileDir();
    seed();
    ({ app, page } = await launchElectron({
      userDataDir,
      env: { CONSOLA_WORKTREES_DIR: root },
    }));
    await holdWorkspace(page);
  });

  test.afterEach(async () => {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('deleting a session takes its worktree and branch, and says so first', async () => {
    test.setTimeout(60_000);
    const asked = await askToDelete('Ship the redirect');
    await expect(asked).toContainText(
      'Its worktree and branch consola/session-done will be removed too.',
    );
    await asked.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(row(page, 'Ship the redirect')).toHaveCount(0);
    await expect.poll(() => fs.existsSync(trees.done), { timeout: 15_000 }).toBe(false);
    // The branch goes right after the folder.
    await expect.poll(() => git(repo, 'branch', '--list', 'consola/session-done')).toBe('');
    await expect(
      page.getByText('Deleted “Ship the redirect”, its worktree and branch'),
    ).toBeVisible();
  });

  test('a worktree holding uncommitted work stays, and the dialog says why', async () => {
    test.setTimeout(60_000);
    const asked = await askToDelete('Draft the notes');
    await expect(asked).toContainText('Its worktree stays: 1 file has uncommitted changes.');
    await asked.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(asked).toBeHidden();
    expect(fs.existsSync(path.join(trees.dirty, 'notes.md'))).toBe(true);
  });

  test('a settled session’s worktree is removed, and rebuilt where it was when opened', async () => {
    test.setTimeout(90_000);
    const head = git(trees.settled, 'rev-parse', 'HEAD');
    // The first sweep runs once the window has said what it shows.
    await expect.poll(() => fs.existsSync(trees.settled), { timeout: 30_000 }).toBe(false);

    await page.getByRole('button', { name: /^Settled/ }).click();
    const settled = row(page, 'Old experiment');
    // One line on the shelf: a mark whose tooltip says it, and the row's name for screen readers.
    const mark = settled.locator('.session-nav-item-worktree-removed-mark');
    await expect(mark).toHaveAttribute('title', 'Worktree removed · rebuilt when opened');
    await expect(settled).toHaveAttribute('aria-label', /worktree removed, rebuilt when opened/);
    // The others had no rule that applies: untouched.
    expect(fs.existsSync(trees.done) && fs.existsSync(trees.dirty)).toBe(true);

    await settled.click();
    // What the pane shows, read from main's own screen model (the view draws
    // to a canvas): the notice is written there, above the CLI.
    const screen = () =>
      page.evaluate(
        (cwd) =>
          window.terminalAPI.create({
            instanceId: 'inst-s-settled',
            workspaceId: 'ws-cleanup-e2e',
            cwd,
            claudeSessionId: 'claude-s-settled',
            resume: false,
            cols: 120,
            rows: 30,
          }),
        trees.settled,
      );
    await expect
      .poll(async () => (await screen()).replay, { timeout: 20_000 })
      .toContain("Consola rebuilt this session's worktree on consola/session-settled");
    expect(fs.existsSync(trees.settled)).toBe(true);
    expect(git(trees.settled, 'rev-parse', 'HEAD')).toBe(head);
    await expect(
      row(page, 'Old experiment').locator('.session-nav-item-worktree-removed-mark'),
    ).toHaveCount(0);
  });
});
