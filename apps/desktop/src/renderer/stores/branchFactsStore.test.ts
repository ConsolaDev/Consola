import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchFacts } from '../../shared/branchFacts';

vi.mock('../services/gitBridge', () => ({
  gitBridge: { getBranchFacts: vi.fn() },
}));

import { gitBridge } from '../services/gitBridge';
import { branchFactsKey, useBranchFactsStore } from './branchFactsStore';

const getBranchFacts = vi.mocked(gitBridge.getBranchFacts);

const facts = (ahead: number): BranchFacts => ({
  upstream: { ref: 'origin/feat/search-pagination', ahead, behind: 0 },
  base: { ref: 'origin/main', files: 3, additions: 9, deletions: 0 },
});

/** Holds main's next answer until the test gives it. */
function heldRead(): (facts: BranchFacts) => void {
  let answer!: (facts: BranchFacts) => void;
  getBranchFacts.mockReturnValueOnce(
    new Promise<BranchFacts>((resolve) => {
      answer = resolve;
    }),
  );
  return answer;
}

/** Lets every settled promise's callbacks run. */
const settle = () => new Promise<void>((done) => setTimeout(done, 0));

beforeEach(() => {
  getBranchFacts.mockReset();
  useBranchFactsStore.setState({ entries: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('branchFactsStore', () => {
  it('one read per folder and base at a time', async () => {
    const answerFirst = heldRead();
    const answerSecond = heldRead();
    const { load } = useBranchFactsStore.getState();

    const loads = [load('/r'), load('/r'), load('/r')];
    expect(getBranchFacts).toHaveBeenCalledTimes(1);

    // Asked while a read ran, they may follow a commit that read missed: one
    // more read answers them all, and only once the first is done.
    answerFirst(facts(2));
    await settle();
    expect(getBranchFacts).toHaveBeenCalledTimes(2);
    expect(useBranchFactsStore.getState().entries[branchFactsKey('/r')]).toEqual(facts(2));

    answerSecond(facts(3));
    await Promise.all(loads);
    expect(getBranchFacts).toHaveBeenCalledTimes(2);
    expect(useBranchFactsStore.getState().entries[branchFactsKey('/r')]).toEqual(facts(3));
  });

  it('keeps the last answer when a read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getBranchFacts.mockResolvedValueOnce(facts(2));
    await useBranchFactsStore.getState().load('/r');

    getBranchFacts.mockRejectedValueOnce(new Error('ipc closed'));
    await useBranchFactsStore.getState().load('/r');
    expect(useBranchFactsStore.getState().entries[branchFactsKey('/r')]).toEqual(facts(2));
    expect(warn).toHaveBeenCalledTimes(1);

    // No git API at all answers nothing, which is no reason to forget either.
    getBranchFacts.mockResolvedValueOnce(null);
    await useBranchFactsStore.getState().load('/r');
    expect(useBranchFactsStore.getState().entries[branchFactsKey('/r')]).toEqual(facts(2));
  });

  it('keys by base too', async () => {
    expect(branchFactsKey('/r', 'main')).not.toBe(branchFactsKey('/r'));

    const againstMain: BranchFacts = {
      upstream: null,
      base: { ref: 'origin/main', files: 1, additions: 1, deletions: 0 },
    };
    getBranchFacts.mockImplementation(async (_dir, baseBranch) =>
      baseBranch === 'main' ? againstMain : facts(2),
    );
    const { load } = useBranchFactsStore.getState();
    // One folder against two bases is two reads, neither waiting on the other.
    await Promise.all([load('/r'), load('/r', 'main')]);
    expect(getBranchFacts).toHaveBeenCalledTimes(2);
    expect(getBranchFacts).toHaveBeenCalledWith('/r', 'main');
    const { entries } = useBranchFactsStore.getState();
    expect(entries[branchFactsKey('/r')]).toEqual(facts(2));
    expect(entries[branchFactsKey('/r', 'main')]).toEqual(againstMain);
  });
});
