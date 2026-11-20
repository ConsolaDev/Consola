import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartedByHandError } from '@consola/automation-engine';
import type { Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import { chainWorktreeStep, itemActionLaunchKey } from '../providers/launchWorkItem';
import { HeadCheckoutError, WorktreeService } from '../WorktreeService';
import { automationCheckoutPort, type AutomationCheckoutDeps } from './automationCheckout';

const STUB_GH = path.resolve(__dirname, '../../../tests/fixtures/stub-gh/gh');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-automation-checkout-'));
  process.env.CONSOLA_GH_PATH = STUB_GH;
});
afterEach(() => {
  delete process.env.CONSOLA_GH_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

const itemRef = {
  provider: 'github',
  repo: 'sprocket/catalog-portal',
  type: 'pr' as const,
  number: 51,
};
const workItem = { ...itemRef, provider: 'github' as const };
const CLONE = '/code/catalog-portal';
const CHECKOUT = '/worktrees/catalog-portal-pr-51-automation';

function workspace(sessions: Partial<Session>[] = []): Workspace {
  return {
    id: 'ws-1',
    name: 'Sprocket',
    defaultHarnessId: 'default',
    provider: { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' },
    scopes: [
      { id: 'scope-code', name: 'code', path: '/code', isGitRepo: false, createdAt: 0 },
      {
        id: 'scope-catalog-portal',
        name: 'catalog-portal',
        path: CLONE,
        isGitRepo: true,
        createdAt: 0,
      },
    ],
    groups: [],
    labels: [],
    actions: [],
    sectionDefaults: {},
    sessions: sessions as Session[],
    createdAt: 0,
    updatedAt: 0,
  } as Workspace;
}

function fakes(overrides: Partial<AutomationCheckoutDeps> = {}) {
  const getWorkspace = overrides.getWorkspace ?? (() => workspace());
  return {
    getWorkspace,
    // One workspace unless a test says otherwise.
    allSessions: () => getWorkspace('ws-1')?.sessions ?? [],
    resolveDriver: () => ({}) as GitProviderDriver,
    resolveRepo: () => CLONE,
    composeEnv: async () => ({ GH_TOKEN: 'gho_test' }),
    automationCheckoutPathFor: () => CHECKOUT,
    syncCheckout: vi.fn(async () => ({ dir: CHECKOUT, head: '5f3a9c1' })),
    ...overrides,
  };
}

const request = { workspaceId: 'ws-1', workItem: itemRef };
const hooksOff = expect.objectContaining({
  GH_TOKEN: 'gho_test',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
});

describe('automationCheckoutPort', () => {
  it('refuses with the full-tools message, naming the session', async () => {
    const d = fakes({
      getWorkspace: () =>
        workspace([{ id: 's-1', name: 'Fix it myself', cwd: CHECKOUT, workItem }]),
    });
    await expect(automationCheckoutPort(d).prepare(request)).rejects.toThrow(
      "A full-tools session was launched in this item's automation checkout (“Fix it myself”), so Consola will not move it. Delete that session, then retry.",
    );
    expect(d.syncCheckout).not.toHaveBeenCalled();
  });

  it('refuses for a full-tools session another workspace launched in the same folder', async () => {
    // Bound to the same clone, both workspaces share the item's one automation checkout.
    const elsewhere = {
      id: 's-9',
      workspaceId: 'ws-2',
      name: 'Fixing it from Sprocket Web',
      cwd: CHECKOUT,
      workItem,
    } as Session;
    const d = fakes({ allSessions: () => [...workspace().sessions, elsewhere] });
    await expect(automationCheckoutPort(d).prepare(request)).rejects.toThrow(
      "A full-tools session was launched in this item's automation checkout (“Fixing it from Sprocket Web”), so Consola will not move it. Delete that session, then retry.",
    );
    expect(d.syncCheckout).not.toHaveBeenCalled();
  });

  it('a read-only session there does not refuse', async () => {
    const d = fakes({
      getWorkspace: () =>
        workspace([
          { id: 's-1', name: 'Earlier review', cwd: CHECKOUT, toolPolicy: 'read-only', workItem },
          // Full tools, but launched elsewhere: it only visited.
          { id: 's-2', name: 'Mine', cwd: CLONE, agentCwd: CHECKOUT },
        ]),
    });
    await expect(automationCheckoutPort(d).prepare(request)).resolves.toEqual({
      cwd: CHECKOUT,
      scopeId: 'scope-catalog-portal',
      head: '5f3a9c1',
    });
    // Every git and gh call it makes gets the bound account's env, with hooks off.
    expect(d.syncCheckout).toHaveBeenCalledWith(CLONE, workItem, hooksOff);
  });

  it('a session started by hand since refuses with StartedByHandError', async () => {
    const since = new Date(1_000).toISOString();
    const sessions: Partial<Session>[] = [
      // The automation's own session, and one the person started before, do not count.
      {
        id: 'auto',
        name: 'Review',
        automation: { name: 'review-assigned-prs', runId: 'run-0' },
        workItem,
        workItemAction: 'Review',
        createdAt: 2_000,
      },
      { id: 'old', name: 'Before', workItem, workItemAction: 'Review', createdAt: 500 },
    ];
    const d = fakes({ getWorkspace: () => workspace(sessions) });
    const byHand = { ...request, startedByHand: { label: 'Review', since } };
    await expect(automationCheckoutPort(d).prepare(byHand)).resolves.toMatchObject({
      head: '5f3a9c1',
    });

    sessions.push({
      id: 'mine',
      name: 'My review',
      workItem,
      workItemAction: 'Review',
      createdAt: 3_000,
    });
    const refused = automationCheckoutPort(d).prepare(byHand);
    await expect(refused).rejects.toBeInstanceOf(StartedByHandError);
    await expect(refused).rejects.toMatchObject({ sessionName: 'My review' });
    expect(d.syncCheckout).toHaveBeenCalledTimes(1);
  });

  it('the item lock is taken before the worktree chain', async () => {
    const order: string[] = [];
    const d = fakes({
      syncCheckout: vi.fn(async () => {
        order.push('sync');
        return { dir: CHECKOUT, head: '5f3a9c1' };
      }),
    });
    let releaseClick!: () => void;
    let releaseFolder!: () => void;
    // An Inbox click on the same item and action, holding the lock.
    const click = chainWorktreeStep(
      itemActionLaunchKey('ws-1', workItem, 'Review'),
      () => new Promise<void>((resolve) => (releaseClick = resolve)),
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    const prepared = automationCheckoutPort(d).prepare({
      ...request,
      startedByHand: { label: 'Review', since: new Date(0).toISOString() },
    });
    await settle();
    // Waiting on the item lock, it has not taken the folder's chain: a
    // preparation of the same folder (another workspace's, say) gets it first.
    const other = chainWorktreeStep(`automation-checkout:${CHECKOUT}`, () => {
      order.push('other');
      return new Promise<void>((resolve) => (releaseFolder = resolve));
    });
    await settle();
    expect(order).toEqual(['other']);

    // Past the item lock, the sync waits on that folder's chain, whichever workspace holds it.
    releaseClick();
    await settle();
    expect(order).toEqual(['other']);

    releaseFolder();
    await Promise.all([click, other, prepared]);
    expect(order).toEqual(['other', 'sync']);
  });

  it('pathFor matches automationCheckoutPathFor', () => {
    const service = new WorktreeService(root);
    const port = automationCheckoutPort(
      fakes({ automationCheckoutPathFor: (ref) => service.automationCheckoutPathFor(ref) }),
    );
    expect(port.pathFor('ws-1', itemRef)).toBe(service.automationCheckoutPathFor(workItem));
    expect(port.pathFor('ws-1', itemRef)).toBe(path.join(root, 'catalog-portal-pr-51-automation'));
  });

  it('says to clone a repo it cannot find, and touches nothing', async () => {
    const d = fakes({ resolveRepo: () => null });
    await expect(automationCheckoutPort(d).prepare(request)).rejects.toThrow(
      'Clone sprocket/catalog-portal into one of this workspace’s scopes to review its pull requests automatically.',
    );
    await expect(
      automationCheckoutPort(d).prepare({
        ...request,
        workItem: { ...itemRef, type: 'issue', number: 87 },
      }),
    ).rejects.toThrow(
      'Clone sprocket/catalog-portal into one of this workspace’s scopes to work on its issues automatically.',
    );
    expect(d.syncCheckout).not.toHaveBeenCalled();
  });

  it('says why the head could not be fetched, and that nothing was read', async () => {
    const d = fakes({
      syncCheckout: vi.fn(async () =>
        Promise.reject(new HeadCheckoutError('gh: canned failure (STUB_GH_FAIL=1)')),
      ),
    });
    await expect(automationCheckoutPort(d).prepare(request)).rejects.toThrow(
      'Could not bring the automation checkout to the head of sprocket/catalog-portal#51: gh: canned failure (STUB_GH_FAIL=1). Nothing was read; retry once it can be fetched.',
    );
  });

  it('passes any other failure through with its own reason', async () => {
    const stuck = `fatal: '${CHECKOUT}' already exists`;
    const d = fakes({ syncCheckout: vi.fn(async () => Promise.reject(new Error(stuck))) });
    const refused = automationCheckoutPort(d).prepare(request);
    await expect(refused).rejects.toThrow(stuck);
    await expect(refused).rejects.not.toThrow(/retry once it can be fetched/);
  });
});

describe('automationCheckoutPort, with real git', () => {
  function git(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    execFileSync('git', ['-C', dir, ...args], {
      stdio: 'ignore',
      env: {
        ...env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  }

  it("the pull request's own hooks never run", async () => {
    const clone = path.join(root, 'catalog-portal');
    execFileSync('git', ['init', '-q', '-b', 'main', clone]);
    const marker = path.join(root, 'hook-ran');
    // As husky has it: the hooks path points into the checked-out tree.
    fs.mkdirSync(path.join(clone, '.husky'));
    fs.writeFileSync(
      path.join(clone, '.husky', 'post-checkout'),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o755 },
    );
    git(clone, ['config', 'core.hooksPath', '.husky']);
    git(clone, ['add', '.']);
    git(clone, ['commit', '-q', '-m', 'init']);
    // An issue fetches origin's HEAD: here, the clone itself.
    git(clone, ['remote', 'add', 'origin', clone]);

    const service = new WorktreeService(path.join(root, 'worktrees'));
    const port = automationCheckoutPort(
      fakes({
        resolveRepo: () => clone,
        composeEnv: async () => ({ ...process.env, GH_TOKEN: 'gho_test' }),
        automationCheckoutPathFor: (ref) => service.automationCheckoutPathFor(ref),
        syncCheckout: (clonePath, ref, env) => service.syncAutomationCheckout(clonePath, ref, env),
      }),
    );

    // Made (`worktree add`, then `gh pr checkout --detach`), then prepared again over it.
    const first = await port.prepare(request);
    const second = await port.prepare(request);
    expect(second.cwd).toBe(first.cwd);
    // An issue's `fetch` and `checkout --detach FETCH_HEAD`, likewise.
    await port.prepare({ ...request, workItem: { ...itemRef, type: 'issue', number: 87 } });
    expect(fs.existsSync(marker)).toBe(false);

    // The same checkout without the prepared env runs the tree's hook.
    git(first.cwd, ['checkout', '-q', '--detach', 'HEAD']);
    expect(fs.existsSync(marker)).toBe(true);
  }, 30_000);
});
