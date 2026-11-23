import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchPullRequestAnswer } from '../../shared/branchPullRequest';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import { INBOX_REFRESH_INTERVAL_MS, type WorkItemRef } from '../../shared/workItems';
import { createSessionRecord, createWorkspaceRecord, type Workspace } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import {
  defaultLayout,
  openKind,
  setVisible,
  splitWithTab,
  toggleMaximize,
} from '../sidePanel/layout';

vi.mock('../services/providerBridge', () => ({
  providerBridge: { findBranchPullRequest: vi.fn() },
}));

import { providerBridge } from '../services/providerBridge';
import {
  type BranchLookupAsk,
  type BranchPullRequestEntry,
  branchLookupAsk,
  branchLookupKey,
  foundPullRequestOf,
  keepAsking,
  looksAtPullRequest,
  useBranchPullRequestStore,
} from './branchPullRequestStore';
import { useCheckoutStore } from './checkoutStore';

const findBranchPullRequest = vi.mocked(providerBridge.findBranchPullRequest);

const pr51: WorkItemRef = {
  provider: 'github',
  repo: 'sprocket/catalog-portal',
  type: 'pr',
  number: 51,
};
const found = (branch: string): BranchPullRequestAnswer => ({
  kind: 'found',
  branch,
  pullRequest: {
    ref: pr51,
    status: 'open',
    url: 'https://github.com/sprocket/catalog-portal/pull/51',
  },
});
const failed = (branch: string): BranchPullRequestAnswer => ({
  kind: 'failed',
  branch,
  error: 'gh: Not Found (HTTP 404)',
});

/** Holds main's next answer until the test gives it. */
function heldAnswer(): (answer: BranchPullRequestAnswer) => void {
  let answer!: (answer: BranchPullRequestAnswer) => void;
  findBranchPullRequest.mockReturnValueOnce(
    new Promise<BranchPullRequestAnswer>((resolve) => {
      answer = resolve;
    }),
  );
  return answer;
}

/** Lets every settled promise's callbacks run. */
const settle = () => new Promise<void>((done) => setTimeout(done, 0));

const KEY = branchLookupKey('w1', '/repos/catalog-portal');
const entry = () => useBranchPullRequestStore.getState().entries[KEY];
const { find } = useBranchPullRequestStore.getState();
const reloadCheckout = vi.fn(async (_path: string) => {});

beforeEach(() => {
  findBranchPullRequest.mockReset();
  reloadCheckout.mockClear();
  useBranchPullRequestStore.setState({ entries: {} });
  useCheckoutStore.setState({ load: reloadCheckout });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('branchPullRequestStore', () => {
  it('asks main once per checkout at a time', async () => {
    const answer = heldAnswer();
    const finds = [
      find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' }),
      find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' }),
      find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' }),
    ];
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);
    expect(findBranchPullRequest).toHaveBeenCalledWith('w1', '/repos/catalog-portal', {
      force: false,
    });
    expect(entry()).toMatchObject({ loading: true });
    expect(entry().answer).toBeUndefined();

    answer(found('feat/search-pagination'));
    await Promise.all(finds);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ loading: false, answer: found('feat/search-pagination') });
    expect(entry().askedAt).toBeGreaterThan(0);

    // Another checkout is asked about apart, at the same time.
    findBranchPullRequest.mockImplementation(async (_workspaceId, dir) =>
      dir.endsWith('-docs')
        ? { kind: 'none', branch: 'docs/readme' }
        : found('feat/search-pagination'),
    );
    await Promise.all([
      find('w1', '/repos/catalog-portal-docs', { branch: 'docs/readme' }),
      find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' }),
    ]);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(3);
  });

  it('an answer for a branch the checkout has left never ends the lookup', async () => {
    const answerOld = heldAnswer();
    const answerNew = heldAnswer();
    const first = find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    // The branch changed while main was still looking for the old one: the
    // running lookup cannot answer for it, so one more is asked once it ends.
    const second = find('w1', '/repos/catalog-portal', { branch: 'spike/other' });
    const third = find('w1', '/repos/catalog-portal', { branch: 'spike/other' });
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);

    answerOld(found('feat/search-pagination'));
    await first;
    await settle();
    expect(findBranchPullRequest).toHaveBeenCalledTimes(2);
    // The old answer is kept, but counts for nothing on the new branch.
    expect(foundPullRequestOf(entry(), 'spike/other')).toBeUndefined();
    expect(entry().loading).toBe(true);

    answerNew(failed('spike/other'));
    await Promise.all([second, third]);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(2);
    expect(entry()).toMatchObject({ loading: false, answer: failed('spike/other') });
    // Main answered for the branch it was asked about: nothing to read again.
    expect(reloadCheckout).not.toHaveBeenCalled();
  });

  it('main naming a branch the renderer does not know yet reads the checkout again', async () => {
    findBranchPullRequest.mockResolvedValueOnce(failed('spike/other'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    // Asking again would only be answered for the same branch: what is out
    // of date is the renderer's checkout, so that is read again.
    expect(reloadCheckout).toHaveBeenCalledTimes(1);
    expect(reloadCheckout).toHaveBeenCalledWith('/repos/catalog-portal');
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);
  });

  it("a forced find never takes a quiet lookup's answer", async () => {
    const answerQuiet = heldAnswer();
    const answerForced = heldAnswer();
    const quiet = find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    // The person's Retry, while a lookup main may answer from its cache runs.
    const retry = find('w1', '/repos/catalog-portal', {
      branch: 'feat/search-pagination',
      force: true,
    });
    const again = find('w1', '/repos/catalog-portal', {
      branch: 'feat/search-pagination',
      force: true,
    });
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);

    answerQuiet(failed('feat/search-pagination'));
    await quiet;
    await settle();
    expect(findBranchPullRequest).toHaveBeenCalledTimes(2);
    expect(findBranchPullRequest).toHaveBeenLastCalledWith('w1', '/repos/catalog-portal', {
      force: true,
    });

    // A forced lookup running answers every find, forced or not.
    const joins = find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    const forcedJoins = find('w1', '/repos/catalog-portal', {
      branch: 'feat/search-pagination',
      force: true,
    });
    answerForced(found('feat/search-pagination'));
    await Promise.all([retry, again, joins, forcedJoins]);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(2);
    expect(entry().answer).toEqual(found('feat/search-pagination'));
  });

  it('a lookup waiting for the one running keeps its branch when a later find names none', async () => {
    const answerRunning = heldAnswer();
    void find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    // The branch changed while main looked: one more lookup waits, for the new branch.
    const queued = find('w1', '/repos/catalog-portal', { branch: 'spike/other' });
    // The person's Retry, with the checkout not read again yet, names none.
    const retry = find('w1', '/repos/catalog-portal', { force: true });
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);

    findBranchPullRequest.mockResolvedValueOnce({ kind: 'none', branch: null });
    answerRunning(found('feat/search-pagination'));
    await Promise.all([queued, retry]);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(2);
    expect(findBranchPullRequest).toHaveBeenLastCalledWith('w1', '/repos/catalog-portal', {
      force: true,
    });
    // Main read no branch: the branch the lookup waited for failed, so Retry is offered.
    expect(entry().answer).toEqual({
      kind: 'failed',
      branch: 'spike/other',
      error: 'git could not read the branch',
    });
  });

  it('a find main cannot answer is a failed lookup of the branch it asked about', async () => {
    findBranchPullRequest.mockRejectedValueOnce(new Error('ipc closed'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination', force: true });
    expect(entry()).toMatchObject({
      loading: false,
      answer: { kind: 'failed', branch: 'feat/search-pagination', error: 'ipc closed' },
    });
  });

  it('a failed lookup keeps the pull request already found for the branch', async () => {
    findBranchPullRequest.mockResolvedValueOnce(found('feat/search-pagination'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });

    // A transient gh failure once main's cache has expired, and one of IPC:
    // neither says the branch lost its pull request.
    findBranchPullRequest.mockResolvedValueOnce(failed('feat/search-pagination'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    expect(entry()).toMatchObject({ loading: false, answer: found('feat/search-pagination') });
    findBranchPullRequest.mockRejectedValueOnce(new Error('ipc closed'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination', force: true });
    expect(entry()).toMatchObject({ loading: false, answer: found('feat/search-pagination') });
    expect(foundPullRequestOf(entry(), 'feat/search-pagination')).toEqual(pr51);

    // A real answer that there is none replaces it.
    findBranchPullRequest.mockResolvedValueOnce({ kind: 'none', branch: 'feat/search-pagination' });
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination', force: true });
    expect(entry().answer).toEqual({ kind: 'none', branch: 'feat/search-pagination' });
    expect(foundPullRequestOf(entry(), 'feat/search-pagination')).toBeUndefined();
  });

  it('main reading no branch keeps the answer for the branch asked about, or fails it', async () => {
    // Git failed or timed out, or HEAD was detached for a moment: with
    // nothing known for the branch, the lookup failed, and can be retried.
    findBranchPullRequest.mockResolvedValueOnce({ kind: 'none', branch: null });
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    expect(entry()).toMatchObject({
      loading: false,
      answer: {
        kind: 'failed',
        branch: 'feat/search-pagination',
        error: 'git could not read the branch',
      },
    });

    // With the branch's pull request known, it is kept.
    findBranchPullRequest.mockResolvedValueOnce(found('feat/search-pagination'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination', force: true });
    findBranchPullRequest.mockResolvedValueOnce({ kind: 'none', branch: null });
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });
    expect(entry()).toMatchObject({ loading: false, answer: found('feat/search-pagination') });
  });

  it('foundPullRequestOf uses an answer only for the branch it was found for', () => {
    const answered = (answer: BranchPullRequestAnswer): BranchPullRequestEntry => ({
      answer,
      loading: false,
      askedAt: 1,
    });
    const foundOnBranch = answered(found('feat/search-pagination'));
    expect(foundPullRequestOf(foundOnBranch, 'feat/search-pagination')).toEqual(pr51);
    expect(foundPullRequestOf(foundOnBranch, 'docs/readme')).toBeUndefined();
    expect(foundPullRequestOf(foundOnBranch, undefined)).toBeUndefined();

    expect(
      foundPullRequestOf(
        answered({ kind: 'none', branch: 'feat/search-pagination' }),
        'feat/search-pagination',
      ),
    ).toBeUndefined();
    expect(
      foundPullRequestOf(answered(failed('feat/search-pagination')), 'feat/search-pagination'),
    ).toBeUndefined();
    expect(
      foundPullRequestOf({ loading: true, askedAt: 1 }, 'feat/search-pagination'),
    ).toBeUndefined();
    expect(foundPullRequestOf(undefined, 'feat/search-pagination')).toBeUndefined();
  });
});

describe('useBranchPullRequestLookup', () => {
  const noAccount = createWorkspaceRecord(
    'catalog-portal',
    '/repos/catalog-portal',
    true,
    'default',
  );
  const workspace: Workspace = {
    ...noAccount,
    provider: { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' },
  };
  const session = createSessionRecord({
    name: 'Paginate the catalog search',
    workspaceId: workspace.id,
    instanceId: 'i1',
    harnessId: 'default',
    scopeId: workspace.scopes[0].id,
  });
  const onBranch: CheckoutInfo = {
    kind: 'main',
    root: '/repos/catalog-portal',
    mainCheckout: '/repos/catalog-portal',
    branch: 'feat/search-pagination',
  };
  const removedWorktree: RemovedWorktree = {
    path: '/tmp/wt',
    mainRepo: '/repos/catalog-portal',
    commit: 'a'.repeat(40),
    branch: 'feat/search-pagination',
    keepRef: 'refs/consola/worktrees/wt',
    trigger: 'settled',
    removedAt: 0,
  };
  const ask: BranchLookupAsk = {
    workspaceId: workspace.id,
    accountLogin: 'JaviDev',
    dir: '/repos/catalog-portal',
    branch: 'feat/search-pagination',
  };

  it('asks for an unlinked session with an account, a checkout path and a branch, while someone looks', () => {
    expect(branchLookupAsk(workspace, session, onBranch, true)).toEqual(ask);
    // Nobody looks.
    expect(branchLookupAsk(workspace, session, onBranch, false)).toBeNull();
    // Linked: the session's own item is read, and no branch is looked up.
    expect(branchLookupAsk(workspace, { ...session, workItem: pr51 }, onBranch, true)).toBeNull();
    // No account to ask with.
    expect(branchLookupAsk(noAccount, session, onBranch, true)).toBeNull();
    // No branch: a detached HEAD, a folder outside git, a checkout not read yet.
    const detached: CheckoutInfo = { ...onBranch, branch: undefined, head: 'abc1234' };
    expect(branchLookupAsk(workspace, session, detached, true)).toBeNull();
    expect(branchLookupAsk(workspace, session, { kind: 'none' }, true)).toBeNull();
    expect(branchLookupAsk(workspace, session, undefined, true)).toBeNull();
    // No checkout path: the worktree is removed.
    expect(
      branchLookupAsk(workspace, { ...session, cwd: '/tmp/wt', removedWorktree }, onBranch, true),
    ).toBeNull();
    // Nothing yet to ask about.
    expect(branchLookupAsk(undefined, session, onBranch, true)).toBeNull();
    expect(branchLookupAsk(workspace, undefined, onBranch, true)).toBeNull();
  });

  it('someone looks while the info panel shows the Pull request section, or the Pull request tab is in front on screen', () => {
    const opened = (...kinds: string[]) => kinds.reduce(openKind, defaultLayout());
    expect(looksAtPullRequest(true, defaultLayout())).toBe(true);
    expect(looksAtPullRequest(false, opened('changes', 'pull-request'))).toBe(true);
    expect(looksAtPullRequest(false, defaultLayout())).toBe(false);
    // A Pull request tab behind another, or in a hidden side panel, is not looked at.
    expect(looksAtPullRequest(false, opened('pull-request', 'changes'))).toBe(false);
    expect(looksAtPullRequest(false, setVisible(opened('pull-request'), false))).toBe(false);
    // In a group of its own, in front there, it counts until Maximize hides that group.
    const split = splitWithTab(opened('changes', 'pull-request'), 'g1', 'pull-request', 'bottom');
    expect(looksAtPullRequest(false, split)).toBe(true);
    expect(looksAtPullRequest(false, toggleMaximize(split, 'g1'))).toBe(false);
  });

  it('asks at once, then every interval, until it stops', async () => {
    vi.useFakeTimers();
    findBranchPullRequest.mockResolvedValue(found('feat/search-pagination'));
    const stop = keepAsking(ask);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);
    expect(findBranchPullRequest).toHaveBeenCalledWith(workspace.id, '/repos/catalog-portal', {
      force: false,
    });

    await vi.advanceTimersByTimeAsync(INBOX_REFRESH_INTERVAL_MS - 1);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3 * INBOX_REFRESH_INTERVAL_MS);
    expect(findBranchPullRequest).toHaveBeenCalledTimes(2);
  });
});
