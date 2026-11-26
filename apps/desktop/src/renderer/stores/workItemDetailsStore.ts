import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { WorkItemDetails } from '../../shared/workItemDetails';
import { INBOX_REFRESH_INTERVAL_MS, workItemKey } from '../../shared/workItems';
import type { WorkItemRef } from '../../shared/workItems';
import { inboxBridge } from '../services/inboxBridge';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

/** How long a read stays fresh: the Inbox's own interval, so the two agree on what is current. */
export const DETAILS_REFRESH_MS = INBOX_REFRESH_INTERVAL_MS;
/** GitHub works mergeability out lazily; UNKNOWN means "ask again shortly". */
export const MERGE_STATE_POLL_MS = 3000;
export const MERGE_STATE_POLLS = 5;
/**
 * How many items no viewer watches keep their details. Details carry every
 * patch, and the pane that read them used to drop them on unmount.
 */
export const MAX_UNWATCHED_DETAILS = 20;

/** An item, and who reads it: the workspace's account. */
export interface DetailsTarget {
  workspaceId: string;
  accountLogin: string;
  ref: WorkItemRef;
}

/** Another workspace or another login reads the item apart: what it may see can differ. */
export function detailsKey(target: DetailsTarget): string {
  return `${target.workspaceId}:${target.accountLogin.toLowerCase()}:${workItemKey(target.ref)}`;
}

export interface DetailsEntry {
  details?: WorkItemDetails;
  /** When a read last succeeded: 0 until one has. */
  fetchedAt: number;
  /** A read that shows itself, one not quiet, is running. */
  loading: boolean;
  /** Why the last read that showed itself failed, until a read succeeds. */
  error?: string;
  errorAt?: number;
  /**
   * When a read last failed, quiet or loud, until a read succeeds. A failure
   * is as fresh as an answer: only a forced load reads the item again before
   * `DETAILS_REFRESH_MS` has passed since it.
   */
  failedAt?: number;
}

interface LoadOptions {
  force?: boolean;
  quiet?: boolean;
}

interface WorkItemDetailsState {
  entries: Record<string, DetailsEntry>;
  /**
   * The item's entry, read again once it is stale. `force` reads a fresh one
   * too: the person's Refresh or Retry, or the re-read after a write. `quiet`
   * neither shows loading nor records a failure.
   *
   * One read per item runs at a time. A load that does not force joins the
   * one running. A forced load joins it only if a loud forced load started
   * it; any other read may have started before a write, so the forced load
   * waits for it, then gets one more read, shared by every forced load that
   * asks meanwhile.
   */
  load(target: DetailsTarget, options?: LoadOptions): Promise<DetailsEntry>;
  /** An active viewer. Returns its release. */
  watch(target: DetailsTarget): () => void;
}

const NEVER_READ: DetailsEntry = { fetchedAt: 0, loading: false };

/** The read running for an item. */
interface Flight {
  promise: Promise<DetailsEntry>;
  /** Started by a loud forced load, so its answer postdates whatever asked for it. */
  loudForced: boolean;
}

/** The one forced read waiting for the read running, for every forced load that asked meanwhile. */
interface NextRead {
  target: DetailsTarget;
  /** Quiet until a loud load asks for it. */
  quiet: boolean;
  promise: Promise<DetailsEntry>;
  resolve: (entry: DetailsEntry) => void;
}

const inFlight = new Map<string, Flight>();
const nextReads = new Map<string, NextRead>();

/** A spell of watching one item: from its first viewer to the last release. */
interface Watch {
  target: DetailsTarget;
  viewers: number;
  polls: number;
  recheck?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setTimeout>;
}

const watches = new Map<string, Watch>();

/**
 * Every item's details, shared by everything that shows them: the Inbox's
 * pane, the Pull request tab and the info panel. Each read spends the
 * account's request budget, so an item is read only for a viewer that can be
 * seen (`watch`), once at a time however many ask, and no more than once per
 * `DETAILS_REFRESH_MS` unless someone forces it, a failed read counting as
 * one: asking again at once would only spend the budget again. At most
 * `MAX_UNWATCHED_DETAILS` items nobody watches keep their details.
 *
 * Kept in the renderer rather than main: main allows one window per
 * workspace, so no two windows would share an entry anyway.
 */
export const useWorkItemDetailsStore = create<WorkItemDetailsState>((_, get) => ({
  entries: {},

  load: (target, { force = false, quiet = false } = {}) => {
    const key = detailsKey(target);
    const running = inFlight.get(key);
    if (running) {
      if (!force || running.loudForced) return running.promise;
      return readNext(key, target, quiet);
    }
    const known = get().entries[key];
    if (!force && known && Date.now() - lastReadAt(known) < DETAILS_REFRESH_MS) {
      return Promise.resolve(known);
    }
    return read(key, target, { force, quiet });
  },

  watch: (target) => {
    const key = detailsKey(target);
    const watching = watches.get(key);
    if (watching) {
      watching.viewers++;
    } else {
      watches.set(key, { target, viewers: 1, polls: 0 });
      check(key);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const watch = watches.get(key);
      if (!watch || --watch.viewers > 0) return;
      clearTimeout(watch.recheck);
      clearTimeout(watch.poll);
      watches.delete(key);
      prune();
    };
  },
}));

function entryOf(key: string): DetailsEntry {
  return useWorkItemDetailsStore.getState().entries[key] ?? NEVER_READ;
}

/** When the item was last read, answered or failed: what its freshness is timed from. */
function lastReadAt(entry: DetailsEntry | undefined): number {
  return Math.max(entry?.fetchedAt ?? 0, entry?.failedAt ?? 0);
}

function patch(key: string, change: Partial<DetailsEntry>): void {
  useWorkItemDetailsStore.setState((state) => ({
    entries: { ...state.entries, [key]: { ...(state.entries[key] ?? NEVER_READ), ...change } },
  }));
}

/** Starts the item's one read. When it ends, the forced read waiting for it, if any, starts. */
function read(
  key: string,
  target: DetailsTarget,
  { force, quiet }: Required<LoadOptions>,
): Promise<DetailsEntry> {
  if (!quiet) patch(key, { loading: true });
  const promise = (async () => {
    try {
      const details = await inboxBridge.getDetails(target.workspaceId, target.ref);
      patch(key, {
        details,
        fetchedAt: Date.now(),
        error: undefined,
        errorAt: undefined,
        failedAt: undefined,
        ...(quiet ? {} : { loading: false }),
      });
    } catch (error) {
      // A failure keeps the last details: what the item was is still worth showing.
      const failedAt = Date.now();
      patch(
        key,
        quiet
          ? { failedAt }
          : { loading: false, error: ipcErrorMessage(error), errorAt: failedAt, failedAt },
      );
    }
    // Taken before anything after it can change the entry: pruning may drop it.
    const answer = entryOf(key);
    const next = nextReads.get(key);
    if (next) {
      nextReads.delete(key);
      void read(key, next.target, { force: true, quiet: next.quiet }).then(next.resolve);
    } else {
      inFlight.delete(key);
      prune();
      follow(key);
    }
    return answer;
  })();
  inFlight.set(key, { promise, loudForced: force && !quiet });
  return promise;
}

/** The forced read that runs once the read running ends, shared by every forced load until it starts. */
function readNext(key: string, target: DetailsTarget, quiet: boolean): Promise<DetailsEntry> {
  // A loud load shows loading at once, not only once the read it waits for ends.
  if (!quiet) patch(key, { loading: true });
  const waiting = nextReads.get(key);
  if (waiting) {
    if (!quiet) waiting.quiet = false;
    return waiting.promise;
  }
  let resolve!: (entry: DetailsEntry) => void;
  const promise = new Promise<DetailsEntry>((done) => {
    resolve = done;
  });
  nextReads.set(key, { target, quiet, promise, resolve });
  return promise;
}

/**
 * Drops the details of the items read longest ago that nobody watches, past
 * `MAX_UNWATCHED_DETAILS`. A failed read counts as a read, so a failure just
 * kept is not the first to go. One with a read running stays: its answer is
 * due.
 */
function prune(): void {
  const { entries } = useWorkItemDetailsStore.getState();
  const unwatched = Object.keys(entries).filter((key) => entries[key].details && !watches.has(key));
  const excess = unwatched.length - MAX_UNWATCHED_DETAILS;
  if (excess <= 0) return;
  const dropped = new Set(
    unwatched
      .filter((key) => !inFlight.has(key))
      .sort((a, b) => lastReadAt(entries[a]) - lastReadAt(entries[b]))
      .slice(0, excess),
  );
  if (dropped.size === 0) return;
  useWorkItemDetailsStore.setState((state) => ({
    entries: Object.fromEntries(Object.entries(state.entries).filter(([key]) => !dropped.has(key))),
  }));
}

/**
 * Loads a watched item, then plans what follows, whether or not that read
 * anything. The store's own reads (a watch's first, the re-check) show
 * loading only while the item has no details yet: loading locks the pane's
 * editors, and a person typing in one must not lose it every few minutes.
 */
function check(key: string, options?: LoadOptions): void {
  const watch = watches.get(key);
  if (!watch) return;
  void useWorkItemDetailsStore
    .getState()
    .load(watch.target, options ?? { quiet: Boolean(entryOf(key).details) });
  follow(key);
}

/**
 * What a watched item does next, planned when watching starts and after
 * every read of it; while a read runs, its end plans instead, so nothing
 * planned before it is left to fire meanwhile. The item is checked once its
 * entry goes stale, timed from the last read, answered or failed, rather
 * than from a fixed interval, which would find the entry a read's latency
 * short of stale and wait out a second interval. And while GitHub is still
 * working mergeability out, a quiet read follows shortly, as GitHub's own
 * page keeps asking, a few times per spell of watching.
 */
function follow(key: string): void {
  const watch = watches.get(key);
  if (!watch) return;
  clearTimeout(watch.recheck);
  clearTimeout(watch.poll);
  if (inFlight.has(key)) return;
  const entry = useWorkItemDetailsStore.getState().entries[key];
  const age = Date.now() - lastReadAt(entry);
  const untilStale = age < DETAILS_REFRESH_MS ? DETAILS_REFRESH_MS - age : DETAILS_REFRESH_MS;
  watch.recheck = setTimeout(() => check(key), untilStale);
  if (entry?.details?.mergeState === 'UNKNOWN' && watch.polls < MERGE_STATE_POLLS) {
    watch.poll = setTimeout(() => {
      watch.polls++;
      check(key, { force: true, quiet: true });
    }, MERGE_STATE_POLL_MS);
  }
}

/**
 * The item's entry, kept current while `active`: a viewer on screen. One that
 * cannot be seen reads only what is already there, and asks for nothing.
 */
export function useWorkItemDetails(
  target: DetailsTarget | null,
  active: boolean,
): DetailsEntry | undefined {
  const key = target ? detailsKey(target) : null;
  // The key says which item; the target it came from is read when watching starts.
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    const current = latest.current;
    if (!key || !active || !current) return;
    return useWorkItemDetailsStore.getState().watch(current);
  }, [key, active]);
  return useDetailsEntry(target);
}

/** The item's entry as it is. It never watches, so it never causes a read. */
export function useDetailsEntry(target: DetailsTarget | null): DetailsEntry | undefined {
  const key = target ? detailsKey(target) : null;
  return useWorkItemDetailsStore((state) => (key ? state.entries[key] : undefined));
}
