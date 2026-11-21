import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemDetails } from '../../shared/workItemDetails';
import { INBOX_REFRESH_INTERVAL_MS, type WorkItemRef } from '../../shared/workItems';

vi.mock('../services/inboxBridge', () => ({
  inboxBridge: { getDetails: vi.fn() },
}));

import { inboxBridge } from '../services/inboxBridge';
import {
  DETAILS_REFRESH_MS,
  MERGE_STATE_POLL_MS,
  type DetailsTarget,
  detailsKey,
  useWorkItemDetailsStore,
} from './workItemDetailsStore';

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
function watch(): () => void {
  const release = useWorkItemDetailsStore.getState().watch(target);
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

  it('force reads again, but joins a read already running', async () => {
    await load(target);
    await load(target, { force: true });
    expect(getDetails).toHaveBeenCalledTimes(2);

    const read = deferred();
    const first = load(target, { force: true });
    const joined = load(target, { force: true });
    const plain = load(target);
    expect(getDetails).toHaveBeenCalledTimes(3);
    read.answer(details({ title: 'Extract the billing client' }));
    const [a, b, c] = await Promise.all([first, joined, plain]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a.details?.title).toBe('Extract the billing client');
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
