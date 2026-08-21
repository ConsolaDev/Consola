import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProfileDir, launchElectron } from './helpers/electron';

const STUB_GH_DIR = path.resolve(__dirname, '../fixtures/stub-gh');

/** A local clone whose origin matches the stub payload's sympower/controller-app. */
function initClone(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'e2e@consola.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Consola E2E']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  execFileSync('git', [
    '-C', dir, 'remote', 'add', 'origin',
    'https://github.com/sympower/controller-app.git',
  ]);
}

/**
 * Seed a github-bound v6 workspace directly into the profile. main/index.ts
 * appends ' Test' to the profile dir under NODE_ENV=test (PROFILE_SUFFIX), so
 * the file must land there. Shape per Phase 0's v6 contract -- if Phase 0's
 * on-disk field names drifted, fix this seed against src/shared/workspace.ts.
 */
function seedWorkspaceState(userDataDir: string, repoDir: string): string {
  const effective = `${userDataDir} Test`;
  fs.mkdirSync(effective, { recursive: true });
  const now = Date.now();
  const workspaceId = 'ws-inbox-e2e';
  fs.writeFileSync(
    path.join(effective, 'workspaces.json'),
    JSON.stringify(
      {
        version: 6,
        workspaces: [
          {
            id: workspaceId,
            name: 'Sympower',
            defaultHarnessId: 'default',
            scopes: [
              {
                id: 'scope-controller',
                name: 'controller-app',
                path: repoDir,
                isGitRepo: true,
                createdAt: now,
              },
            ],
            groups: [],
            github: { accountLogin: 'SymJavi', org: 'sympower' },
            sessions: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2
    )
  );
  return workspaceId;
}

interface SeededSession {
  workItem?: { provider: string; repo: string; type: string; number: number };
  cwd?: string;
  scopeId?: string;
}

function sessionsIn(stateFile: string): SeededSession[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return parsed.workspaces?.[0]?.sessions ?? [];
  } catch {
    return []; // mid-write; the poll comes back
  }
}

test('inbox renders, launch cuts a worktree and a session, relaunch re-attaches', async () => {
  test.setTimeout(90_000);

  const userDataDir = createProfileDir();
  const repoDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-inbox-')), 'controller-app');
  initClone(repoDir);
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-worktrees-'));
  seedWorkspaceState(userDataDir, repoDir);
  const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');

  const { app, page } = await launchElectron({
    userDataDir,
    env: {
      CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
      CONSOLA_WORKTREES_DIR: worktreesDir,
      PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  // Hold the seeded workspace through the real switcher UI (windows.spec.ts
  // precedent: a raw IPC call would not update what the window renders).
  await page.getByRole('button', { name: /^Switch workspace/ }).click();
  await page.getByRole('menuitem', { name: /Sympower/ }).click();

  // The pinned Inbox row exists because the workspace is github-bound.
  const inboxRow = page.locator('.sidebar-inbox-row');
  await expect(inboxRow).toBeVisible({ timeout: 10_000 });
  await inboxRow.click();

  // Remote-driven list from the stub's canned GraphQL payload.
  await expect(
    page.locator('.inbox-item-title', { hasText: '#51 Extract billing client' })
  ).toBeVisible({ timeout: 15_000 });

  // The un-cloned repo's issue offers the clone path instead of failing.
  await page.locator('.inbox-tab', { hasText: 'Issues' }).click();
  await expect(
    page.locator('.inbox-item-action.ghost', { hasText: 'Clone into scope' })
  ).toBeVisible();
  await page.locator('.inbox-tab', { hasText: 'PRs' }).click();

  // One click: worktree first, record second, spawn third.
  const item51 = page.locator('.inbox-item', { hasText: 'Extract billing client' });
  await item51.getByRole('button', { name: 'Review' }).click();

  const worktree = path.join(worktreesDir, 'controller-app-pr-51');
  await expect
    .poll(() => fs.existsSync(path.join(worktree, '.git')), { timeout: 20_000 })
    .toBe(true);
  expect(
    execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  ).toBe('stub-pr-51'); // the stub's `gh pr checkout` branch

  await expect.poll(() => sessionsIn(stateFile).length, { timeout: 20_000 }).toBe(1);
  const [session] = sessionsIn(stateFile);
  expect(session.workItem).toMatchObject({
    provider: 'github',
    repo: 'sympower/controller-app',
    type: 'pr',
    number: 51,
  });
  expect(session.cwd).toBe(worktree);
  expect(session.scopeId).toBe('scope-controller');

  // Re-attach: the item now reads "Open session", and clicking it must not
  // mint a second session -- one work item, one session, forever.
  await inboxRow.click();
  await expect(item51.getByRole('button', { name: 'Open session' })).toBeVisible({
    timeout: 10_000,
  });
  await item51.getByRole('button', { name: 'Open session' }).click();
  await page.waitForTimeout(1_500);
  expect(sessionsIn(stateFile)).toHaveLength(1);

  await app.close();
});
