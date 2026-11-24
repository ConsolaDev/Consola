import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemDetails } from '../../shared/workItemDetails';
import { INBOX_REFRESH_INTERVAL_MS } from '../../shared/workItems';
import type { WorkItemRef } from '../../shared/workItems';

vi.mock('../services/inboxBridge', () => ({
  inboxBridge: { getDetails: vi.fn() },
}));

import { inboxBridge } from '../services/inboxBridge';
import {
  DETAILS_REFRESH_MS,
  MAX_UNWATCHED_DETAILS,
  MERGE_STATE_POLL_MS,
  detailsKey,
  useWorkItemDetailsStore,
} from './workItemDetailsStore';
import type { DetailsTarget } from './workItemDetailsStore';

const getDetails = vi.mocked(inboxBridge.getDetails);
const MINUTE = 60_000;
const ref: WorkItemRef = {
  provider: 'github',
  repo: 'sprocket/catalog-portal',
  type: 'pr',
  number: 51,
};
const target: DetailsTarget = { workspaceId: 'ws-sprocket', accountLogin: 'JaviDev', ref };
const key = detailsKey(target);

/** Only the fields the store looks at; the rest is the pane's business. */
function details(fields: Partial<WorkItemDetails> = {}): WorkItemDetails {
  return {
    title: 'Extract billing client',
    state: 'open',
    mergeState: 'BLOCKED',
    ...fields,
  } as WorkItemDetails;
}

/** Ends every held read, so a test that stops early leaves none running for the next. */
const held: Array<(error: Error) => void> = [];

/** The next read, answered only when the test says so. */
function deferred() {
  let answer!: (value: WorkItemDetails) => void;
  let fail!: (error: Error) => void;
  getDetails.mockReturnValueOnce(
    new Promise<WorkItemDetails>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    }),
  );
  held.push(fail);
  return { answer, fail };
}

const entry = () => useWorkItemDetailsStore.getState().entries[key];
const load = (target: DetailsTarget, options?: { force?: boolean; quiet?: boolean }) =>
  useWorkItemDetailsStore.getState().load(target, options);

const releases: Array<() => void> = [];
function watch(watched: DetailsTarget = target): () => void {
  const release = useWorkItemDetailsStore.getState().watch(watched);
  releases.push(release);
  return release;
}

beforeEach(() => {
  vi.useFakeTimers();
  getDetails.mockReset();
  getDetails.mockResolvedValue(details());
  useWorkItemDetailsStore.setState({ entries: {} });
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const fail of held.splice(0)) fail(new Error('test over'));
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

describe('workItemDetailsStore', () => {
  it('one read per item, however many viewers ask at once', async () => {
    await Promise.all([load(target), load(target), load(target)]);
    expect(getDetails).toHaveBeenCalledTimes(1);
    expect(getDetails).toHaveBeenCalledWith('ws-sprocket', ref);
    expect(entry()).toMatchObject({ details: details(), loading: false });
  });

  it("a fresh entry is not read again until the Inbox's interval has passed", async () => {
    await load(target);
    vi.advanceTimersByTime(2 * MINUTE);
    await load(target);
    expect(getDetails).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1 * MINUTE);
    await load(target);
    expect(getDetails).toHaveBeenCalledTimes(2);
  });

  it('force joins a loud forced read already running', async () => {
    await load(target);
    await load(target, { force: true });
    expect(getDetails).toHaveBeenCalledTimes(2);

    const read = deferred();
    const refresh = load(target, { force: true });
    const anotherRefresh = load(target, { force: true });
    const quietReread = load(target, { force: true, quiet: true });
    const plain = load(target);
    expect(getDetails).toHaveBeenCalledTimes(3);
    read.answer(details({ title: 'Extract the billing client' }));
    const answers = await Promise.all([refresh, anotherRefresh, quietReread, plain]);
    for (const answer of answers) expect(answer).toBe(answers[0]);
    expect(answers[0].details?.title).toBe('Extract the billing client');
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(3);
  });

  it('force during a quiet poll, or during an unforced read, makes exactly one more read, after the first one lands, and answers with it', async () => {
    // During an unforced read: two forced loads share the one read after it.
    const first = deferred();
    const second = deferred();
    const unforced = load(target);
    const reread = load(target, { force: true });
    const quietReread = load(target, { force: true, quiet: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(1);
    first.answer(details({ title: 'Before the write' }));
    expect((await unforced).details?.title).toBe('Before the write');
    expect(getDetails).toHaveBeenCalledTimes(2);
    second.answer(details({ title: 'After the write' }));
    const [loud, quiet] = await Promise.all([reread, quietReread]);
    expect(quiet).toBe(loud);
    expect(loud.details?.title).toBe('After the write');
    expect(entry().details?.title).toBe('After the write');

    // During a quiet poll: a quiet re-read waits for one more read, and the
    // person's Refresh joins it, showing loading at once and making it loud.
    const poll = deferred();
    const after = deferred();
    const polling = load(target, { force: true, quiet: true });
    const quietAfterWrite = load(target, { force: true, quiet: true });
    expect(entry().loading).toBe(false);
    const refresh = load(target, { force: true });
    expect(entry().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(3);
    poll.answer(details({ title: 'Polled' }));
    expect((await polling).details?.title).toBe('Polled');
    expect(getDetails).toHaveBeenCalledTimes(4);
    expect(entry().loading).toBe(true);
    after.answer(details({ title: 'Refreshed' }));
    const [refreshed, quietly] = await Promise.all([refresh, quietAfterWrite]);
    expect(quietly).toBe(refreshed);
    expect(refreshed.details?.title).toBe('Refreshed');
    expect(entry()).toMatchObject({ loading: false, details: { title: 'Refreshed' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(4);
  });

  it('a watched item is read again once stale, an unwatched one never', async () => {
    const release = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(getDetails).toHaveBeenCalledTimes(2);

    release();
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(getDetails).toHaveBeenCalledTimes(2);
  });

  it('a watched item with details, re-checked at +3 minutes, never sets loading to true', async () => {
    // An empty pane's first read still shows its spinner.
    const first = deferred();
    const release = watch();
    expect(entry().loading).toBe(true);
    first.answer(details());
    await vi.advanceTimersByTimeAsync(0);
    expect(entry().loading).toBe(false);

    // The store's own reads after that are quiet: a pane editing must keep its fields.
    let showedLoading = false;
    const stop = useWorkItemDetailsStore.subscribe((state) => {
      if (state.entries[key]?.loading) showedLoading = true;
    });
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(getDetails).toHaveBeenCalledTimes(2);

    // So is the first read of a viewer coming back to stale details, and its
    // failure is not recorded.
    release();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    getDetails.mockRejectedValueOnce(new Error('rate limited'));
    watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(3);
    stop();
    expect(showedLoading).toBe(false);
    expect(entry().error).toBeUndefined();
    expect(entry().details).toEqual(details());
  });

  it('polls an unknown mergeability at most five times while watched', async () => {
    getDetails.mockResolvedValue(details({ mergeState: 'UNKNOWN' }));
    const release = watch();
    for (let step = 0; step < 6; step++) await vi.advanceTimersByTimeAsync(MERGE_STATE_POLL_MS);
    // The first read, then five polls, and no sixth.
    expect(getDetails).toHaveBeenCalledTimes(6);

    // A new spell of watching starts the count over.
    release();
    const again = watch();
    await vi.advanceTimersByTimeAsync(MERGE_STATE_POLL_MS);
    expect(getDetails).toHaveBeenCalledTimes(7);

    // Released mid-poll, with the next one due, nothing more is read.
    again();
    await vi.advanceTimersByTimeAsync(10 * MERGE_STATE_POLL_MS);
    expect(getDetails).toHaveBeenCalledTimes(7);
  });

  it('a re-check read ends the mergeability poll it finds pending', async () => {
    // Watched a second before its details go stale: the re-check is due
    // before the poll their unknown mergeability asks for.
    getDetails.mockResolvedValueOnce(details({ mergeState: 'UNKNOWN' }));
    await load(target);
    vi.advanceTimersByTime(DETAILS_REFRESH_MS - 1_000);
    watch();
    const recheck = deferred();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getDetails).toHaveBeenCalledTimes(2);

    // The poll would fall due while the re-check runs. The re-check's own
    // answer plans what follows, and GitHub has worked mergeability out.
    await vi.advanceTimersByTimeAsync(MERGE_STATE_POLL_MS);
    recheck.answer(details({ mergeState: 'BLOCKED' }));
    await vi.advanceTimersByTimeAsync(MERGE_STATE_POLL_MS);
    expect(getDetails).toHaveBeenCalledTimes(2);
  });

  it('a quiet read neither shows loading nor records its failure; a loud one does, and keeps the last details', async () => {
    await load(target);
    const last = entry().details;

    const quietRead = deferred();
    const quiet = load(target, { force: true, quiet: true });
    expect(entry().loading).toBe(false);
    quietRead.fail(
      new Error("Error invoking remote method 'inbox:get-details': Error: rate limited"),
    );
    await quiet;
    expect(entry().error).toBeUndefined();
    expect(entry().errorAt).toBeUndefined();
    expect(entry().details).toBe(last);

    const loudRead = deferred();
    const loud = load(target, { force: true });
    expect(entry().loading).toBe(true);
    loudRead.fail(
      new Error("Error invoking remote method 'inbox:get-details': Error: rate limited"),
    );
    const answer = await loud;
    expect(answer).toMatchObject({ loading: false, error: 'rate limited', errorAt: Date.now() });
    expect(answer.details).toBe(last);

    // A success clears it.
    const healed = await load(target, { force: true });
    expect(healed.error).toBeUndefined();
    expect(healed.errorAt).toBeUndefined();
  });

  it('a failed read is as fresh as an answer: a watch within the interval after it reads nothing, Retry reads at once', async () => {
    getDetails.mockRejectedValue(new Error('rate limited'));
    const first = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(1);
    expect(entry().error).toBe('rate limited');
    first();

    // The pane shown again two minutes later.
    vi.advanceTimersByTime(2 * MINUTE);
    const again = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(1);
    again();

    // The person's Retry.
    await load(target, { force: true });
    expect(getDetails).toHaveBeenCalledTimes(2);

    // An interval after that failure, a watch reads.
    vi.advanceTimersByTime(DETAILS_REFRESH_MS - 1);
    const early = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(2);
    early();
    vi.advanceTimersByTime(1);
    watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(3);
  });

  it('a quiet failure counts too, though it says nothing', async () => {
    await load(target);
    vi.advanceTimersByTime(DETAILS_REFRESH_MS);
    getDetails.mockRejectedValueOnce(new Error('rate limited'));
    const first = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(2);
    expect(entry().error).toBeUndefined();
    first();

    vi.advanceTimersByTime(MINUTE);
    watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(2);
  });

  it("the store's own re-check waits an interval after a failure, not after the last answer", async () => {
    watch();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(getDetails).toHaveBeenCalledTimes(1);

    // A Refresh a minute after the first read fails.
    getDetails.mockRejectedValueOnce(new Error('rate limited'));
    await load(target, { force: true });
    expect(getDetails).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(DETAILS_REFRESH_MS - 1_000);
    expect(getDetails).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getDetails).toHaveBeenCalledTimes(3);
  });

  it('keeps the details of at most 20 unwatched items, dropping the least recently read', async () => {
    const item = (number: number): DetailsTarget => ({ ...target, ref: { ...ref, number } });
    const has = (number: number) =>
      useWorkItemDetailsStore.getState().entries[detailsKey(item(number))]?.details !== undefined;
    // Read first, and still on screen.
    watch(item(1));
    await vi.advanceTimersByTimeAsync(0);
    for (let number = 2; number <= 22; number++) {
      vi.advanceTimersByTime(1_000);
      await load(item(number));
    }
    expect(MAX_UNWATCHED_DETAILS).toBe(20);
    expect(has(2)).toBe(false);
    for (let number = 3; number <= 22; number++) expect(has(number)).toBe(true);
    expect(has(1)).toBe(true);
    expect(Object.keys(useWorkItemDetailsStore.getState().entries)).toHaveLength(21);
  });

  it('a failed read counts as a read when the least recently read are dropped, so its failure stays fresh', async () => {
    const item = (number: number): DetailsTarget => ({ ...target, ref: { ...ref, number } });
    const has = (number: number) =>
      useWorkItemDetailsStore.getState().entries[detailsKey(item(number))]?.details !== undefined;
    for (let number = 1; number <= 20; number++) {
      vi.advanceTimersByTime(1_000);
      await load(item(number));
    }
    // The oldest answer is read again, and that read fails.
    vi.advanceTimersByTime(1_000);
    getDetails.mockRejectedValueOnce(new Error('rate limited'));
    await load(item(1), { force: true });
    vi.advanceTimersByTime(1_000);
    await load(item(21));
    expect(has(1)).toBe(true);
    expect(has(2)).toBe(false);

    // Its failure still counts: shown again within the interval, it is not read.
    const reads = getDetails.mock.calls.length;
    watch(item(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(getDetails).toHaveBeenCalledTimes(reads);
  });

  it('never drops an item whose read is running, nor one still watched', async () => {
    const item = (number: number): DetailsTarget => ({ ...target, ref: { ...ref, number } });
    const has = (number: number) =>
      useWorkItemDetailsStore.getState().entries[detailsKey(item(number))]?.details !== undefined;
    for (let number = 1; number <= 20; number++) {
      vi.advanceTimersByTime(1_000);
      await load(item(number));
    }
    // The oldest is being read again when the 21st lands.
    const reread = deferred();
    const pending = load(item(1), { force: true });
    vi.advanceTimersByTime(1_000);
    await load(item(21));
    expect(has(1)).toBe(true);
    expect(has(2)).toBe(false);

    // A watched item stays, however old; released, it can go, oldest first.
    reread.answer(details());
    await pending;
    const release = watch(item(3));
    for (const number of [22, 23]) {
      vi.advanceTimersByTime(1_000);
      await load(item(number));
    }
    expect(has(3)).toBe(true);
    expect(has(4)).toBe(false);
    release();
    expect(has(3)).toBe(false);
    expect(has(5)).toBe(true);
  });

  it('a failed forced read answers with its failure, though the cache then drops the item', async () => {
    const item = (number: number): DetailsTarget => ({ ...target, ref: { ...ref, number } });
    for (let number = 1; number <= 20; number++) {
      vi.advanceTimersByTime(1_000);
      await load(item(number));
    }
    // A read that ends is the newest read, so the cache drops another item
    // first, unless every other one it could drop is being read: here, the
    // person's Refresh of the first item, with every other one read again...
    const refresh = deferred();
    const refreshed = load(item(1), { force: true });
    for (let number = 2; number <= 20; number++) {
      deferred();
      void load(item(number), { force: true });
    }
    // ...and a 21st item's first read landing with a forced read queued
    // behind it, so the store holds one item past its cap until a read ends.
    const first = deferred();
    deferred();
    void load(item(21));
    void load(item(21), { force: true });
    first.answer(details());
    await vi.advanceTimersByTimeAsync(0);

    refresh.fail(
      new Error("Error invoking remote method 'inbox:get-details': Error: rate limited"),
    );
    const answer = await refreshed;
    expect(answer).toMatchObject({ loading: false, error: 'rate limited', details: details() });
    expect(useWorkItemDetailsStore.getState().entries[detailsKey(item(1))]).toBeUndefined();
  });

  it('a forced read updates what every viewer shows', async () => {
    await load(target);
    const renamed = details({ title: 'Extract the billing client' });
    getDetails.mockResolvedValueOnce(renamed);
    await load(target, { force: true });
    expect(entry().details).toBe(renamed);
  });

  it('keys by workspace, account and item', () => {
    expect(detailsKey({ ...target, workspaceId: 'ws-other' })).not.toBe(key);
    expect(detailsKey({ ...target, accountLogin: 'ellen-sprocket' })).not.toBe(key);
    expect(detailsKey({ ...target, ref: { ...ref, number: 52 } })).not.toBe(key);
    expect(detailsKey({ ...target, ref: { ...ref, repo: 'Sprocket/Catalog-Portal' } })).toBe(
      detailsKey({ ...target, ref: { ...ref, repo: 'sprocket/catalog-portal' } }),
    );
  });

  it("DETAILS_REFRESH_MS is the Inbox's own interval", () => {
    expect(DETAILS_REFRESH_MS).toBe(INBOX_REFRESH_INTERVAL_MS);
  });
});
