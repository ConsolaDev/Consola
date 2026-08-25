import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator } from '@playwright/test';
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
            // A hand-made session, never launched from an item: no workItem,
            // so sessionLabel reads it as a plain name and the sidebar's
            // Link/Unlink flow (finding 2a) has something to link.
            sessions: [
              {
                id: 'session-handmade',
                name: 'Local notes',
                workspaceId,
                instanceId: `workspace-${workspaceId}-session-handmade`,
                claudeSessionId: 'uuid-handmade',
                hasStarted: false,
                harnessId: 'default',
                scopeId: 'scope-controller',
                cwd: repoDir,
                kind: 'interactive',
                createdAt: now,
                lastActiveAt: now,
              },
            ],
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
  id?: string;
  workItem?: { provider: string; repo: string; type: string; number: number };
  workItemAction?: string;
  cwd?: string;
  scopeId?: string;
  kind?: string;
}

/**
 * Click an action in the pane. When another session on the item is still
 * working, the button turns into the spec's inline "Start anyway" confirm
 * and wants a second click — that is the concurrency warning doing its job,
 * not a failure, so take it when it appears and move on when it does not.
 */
async function startAction(pane: Locator, name: string): Promise<void> {
  await pane.getByRole('button', { name, exact: true }).click();
  const confirm = pane.getByRole('button', { name: /Start anyway/ });
  try {
    await confirm.waitFor({ state: 'visible', timeout: 1_500 });
    await confirm.click();
  } catch {
    // No confirm appeared: nothing was working on the item.
  }
}

function sessionsIn(stateFile: string): SeededSession[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return parsed.workspaces?.[0]?.sessions ?? [];
  } catch {
    return []; // mid-write; the poll comes back
  }
}

/**
 * Just the sessions an action launched, excluding the fixture's hand-made
 * session (finding 2a) — which never carries a workItem — so the existing
 * "one launch, then a second" counts stay exact regardless of what else the
 * fixture seeds.
 */
function launchedSessionsIn(stateFile: string): SeededSession[] {
  return sessionsIn(stateFile).filter((session) => session.workItem !== undefined);
}

test('inbox renders, an action cuts a worktree and a session, a second action shares the worktree', async () => {
  test.setTimeout(90_000);

  const userDataDir = createProfileDir();
  const cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-inbox-'));
  const repoDir = path.join(cloneRoot, 'controller-app');
  initClone(repoDir);
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-worktrees-'));
  seedWorkspaceState(userDataDir, repoDir);
  const stateFile = path.join(`${userDataDir} Test`, 'workspaces.json');

  let app: ElectronApplication | undefined;
  try {
    const launched = await launchElectron({
      userDataDir,
      env: {
        CONSOLA_GH_PATH: path.join(STUB_GH_DIR, 'gh'),
        CONSOLA_WORKTREES_DIR: worktreesDir,
        PATH: `${STUB_GH_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    app = launched.app;
    const { page } = launched;

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

    // The header's gear opens Workspace Settings for this workspace and
    // leaves the Inbox where it was.
    await page.locator('.inbox-settings-button').click();
    const workspaceSettings = page.getByRole('dialog', { name: 'Sympower', exact: true });
    await expect(workspaceSettings).toBeVisible();
    await workspaceSettings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(workspaceSettings).toBeHidden();
    await expect(inboxRow).toHaveClass(/active/);

    // The un-cloned repo's issue offers only the clone path, in the pane.
    await page.locator('.inbox-tab', { hasText: 'Issues' }).click();
    await page.locator('.inbox-item', { hasText: 'Rate limit returns 500' }).click();
    const pane = page.locator('[data-testid="inbox-pane"]');
    await expect(pane.locator('.inbox-pane-clone', { hasText: 'Clone into scope' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(pane.locator('[data-action-id]')).toHaveCount(0);
    // Esc closes the pane; selecting the row again would too.
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    await page.locator('.inbox-tab', { hasText: 'PRs' }).click();

    // Select the row: the pane opens with the section default highlighted,
    // and "Review" is the seeded default for a PR awaiting your review.
    const item51 = page.locator('.inbox-item', { hasText: 'Extract billing client' });
    await item51.click();
    await expect(pane).toBeVisible();
    await expect(pane.locator('.inbox-pane-action--default')).toHaveText('Review');

    // One click: worktree first, record second, spawn third.
    await startAction(pane, 'Review');

    const worktree = path.join(worktreesDir, 'controller-app-pr-51');
    await expect
      .poll(() => fs.existsSync(path.join(worktree, '.git')), { timeout: 20_000 })
      .toBe(true);
    expect(
      execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    ).toBe('stub-pr-51'); // the stub's `gh pr checkout` branch

    await expect.poll(() => launchedSessionsIn(stateFile).length, { timeout: 20_000 }).toBe(1);
    const [first] = launchedSessionsIn(stateFile);
    expect(first.workItem).toMatchObject({
      provider: 'github',
      repo: 'sympower/controller-app',
      type: 'pr',
      number: 51,
    });
    expect(first.workItemAction).toBe('Review');
    expect(first.cwd).toBe(worktree);
    expect(first.scopeId).toBe('scope-controller');
    expect(first.kind).toBe('interactive');

    // The launch opened the session; back to the Inbox, the pane now lists
    // it. A second "Review" is a SECOND session — always a new session —
    // and it shares the item's worktree rather than cutting another.
    await inboxRow.click();
    await item51.click();
    await expect(pane.locator('.inbox-pane-session-row')).toHaveCount(1, { timeout: 10_000 });
    await startAction(pane, 'Review');

    await expect.poll(() => launchedSessionsIn(stateFile).length, { timeout: 20_000 }).toBe(2);
    const [older, newer] = launchedSessionsIn(stateFile);
    expect(newer.id).not.toBe(older.id);
    expect(newer.cwd).toBe(worktree);
    expect(newer.workItemAction).toBe('Review');
    expect(newer.workItem).toMatchObject({ repo: 'sympower/controller-app', type: 'pr', number: 51 });

    // Finding 2a: the sidebar's Link/Unlink door on a hand-made session,
    // from the opposite end of the same relation the actions above exercise.
    // The row's accessible name carries its status word, so match on the
    // name text alone — it is unaffected by "ready" vs. later states.
    const handmadeRow = page.locator('.session-nav-item', { hasText: 'Local notes' });
    await expect(handmadeRow).toBeVisible();
    // The ⋯ trigger is visibility:hidden until the row is hovered or
    // focused — hovering first is what makes the click actionable at all.
    await handmadeRow.hover();
    await handmadeRow.getByLabel('Session actions').click();
    await page.getByRole('menuitem', { name: 'Link to work item...' }).click();

    const linkDialog = page.getByRole('dialog', {
      name: 'Link "Local notes" to a work item',
      exact: true,
    });
    await expect(linkDialog).toBeVisible();
    // Not exact: the option's accessible name is its label plus its
    // context (the repo), same as the command palette's rows.
    await linkDialog.getByRole('option', { name: '#51 Extract billing client' }).click();
    await linkDialog.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(linkDialog).toBeHidden();

    // Linking is metadata only, from the sidebar's end: the item pane now
    // lists all three sessions on #51, and the sidebar row's name switches
    // to the hand-made-session glyph. Starting the second Review activated
    // its own session, so navigate back to the Inbox and the item first.
    await inboxRow.click();
    await item51.click();
    await expect(pane.locator('.inbox-pane-session-row')).toHaveCount(3, { timeout: 10_000 });
    await expect(handmadeRow.locator('.session-nav-item-name')).toHaveText(/^⑂ /);

    await handmadeRow.hover();
    await handmadeRow.getByLabel('Session actions').click();
    await page.getByRole('menuitem', { name: 'Unlink' }).click();

    // Unlinking is metadata-only too: the record loses the relation but
    // keeps exactly the cwd it already had.
    await expect
      .poll(
        () => sessionsIn(stateFile).find((session) => session.id === 'session-handmade')?.workItem,
        { timeout: 10_000 }
      )
      .toBeUndefined();
    const handmade = sessionsIn(stateFile).find((session) => session.id === 'session-handmade');
    expect(handmade?.workItemAction).toBeUndefined();
    expect(handmade?.cwd).toBe(repoDir);
  } finally {
    // Guaranteed even if an assertion above throws: a mid-test failure must
    // not leave a real Electron process running for the rest of the worker,
    // nor leave its profile/clone/worktree directories behind in the OS temp
    // dir forever.
    await app?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(`${userDataDir} Test`, { recursive: true, force: true });
    fs.rmSync(cloneRoot, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});
