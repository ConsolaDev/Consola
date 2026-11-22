import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchPullRequestAnswer } from '../../shared/branchPullRequest';
import type { WorkItemRef } from '../../shared/workItems';

vi.mock('../services/providerBridge', () => ({
  providerBridge: { findBranchPullRequest: vi.fn() },
}));

import { providerBridge } from '../services/providerBridge';
import {
  type BranchPullRequestEntry,
  branchLookupKey,
  foundPullRequestOf,
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

  it('a find main cannot answer is a failed lookup of the branch it asked about', async () => {
    findBranchPullRequest.mockResolvedValueOnce(found('feat/search-pagination'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination' });

    findBranchPullRequest.mockRejectedValueOnce(new Error('ipc closed'));
    await find('w1', '/repos/catalog-portal', { branch: 'feat/search-pagination', force: true });
    expect(entry()).toMatchObject({
      loading: false,
      answer: { kind: 'failed', branch: 'feat/search-pagination', error: 'ipc closed' },
    });
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
