import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { WorkItemDetails } from '../../shared/workItemDetails';
import { INBOX_REFRESH_INTERVAL_MS, type WorkItemRef, workItemKey } from '../../shared/workItems';
import { inboxBridge } from '../services/inboxBridge';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

/** How long a read stays fresh: the Inbox's own interval, so the two agree on what is current. */
export const DETAILS_REFRESH_MS = INBOX_REFRESH_INTERVAL_MS;
/** GitHub works mergeability out lazily; UNKNOWN means "ask again shortly". */
export const MERGE_STATE_POLL_MS = 3_000;
export const MERGE_STATE_POLLS = 5;

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
}

interface WorkItemDetailsState {
  entries: Record<string, DetailsEntry>;
  /**
   * The item's entry, read again once it is stale. `force` reads a fresh one
   * too: the person's Refresh, or the re-read after a write. `quiet` neither
   * shows loading nor records a failure. A read already running for the item
   * is joined, whatever is asked.
   */
  load(
    target: DetailsTarget,
    options?: { force?: boolean; quiet?: boolean },
  ): Promise<DetailsEntry>;
  /** An active viewer. Returns its release. */
  watch(target: DetailsTarget): () => void;
}

const NEVER_READ: DetailsEntry = { fetchedAt: 0, loading: false };

const inFlight = new Map<string, Promise<DetailsEntry>>();

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
 * seen (`watch`), once per key however many ask, and no more than once per
 * `DETAILS_REFRESH_MS` unless someone forces it.
 *
 * Kept in the renderer rather than main: main allows one window per
 * workspace, so no two windows would share an entry anyway.
 */
export const useWorkItemDetailsStore = create<WorkItemDetailsState>((set, get) => ({
  entries: {},

  load: (target, { force = false, quiet = false } = {}) => {
    const key = detailsKey(target);
    const running = inFlight.get(key);
    if (running) return running;
    const known = get().entries[key];
    if (!force && known && Date.now() - known.fetchedAt < DETAILS_REFRESH_MS) {
      return Promise.resolve(known);
    }

    const patch = (change: Partial<DetailsEntry>) =>
      set((state) => ({
        entries: { ...state.entries, [key]: { ...(state.entries[key] ?? NEVER_READ), ...change } },
      }));
    if (!quiet) patch({ loading: true });
    const read = (async () => {
      try {
        const details = await inboxBridge.getDetails(target.workspaceId, target.ref);
        patch({
          details,
          fetchedAt: Date.now(),
          error: undefined,
          errorAt: undefined,
          ...(quiet ? {} : { loading: false }),
        });
      } catch (error) {
        // A failure keeps the last details: what the item was is still worth showing.
        if (!quiet) patch({ loading: false, error: ipcErrorMessage(error), errorAt: Date.now() });
      } finally {
        inFlight.delete(key);
      }
      follow(key);
      return get().entries[key] ?? NEVER_READ;
    })();
    inFlight.set(key, read);
    return read;
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
    };
  },
}));

/** Loads a watched item, then plans what follows, whether or not that read anything. */
function check(key: string, options?: { force?: boolean; quiet?: boolean }): void {
  const watch = watches.get(key);
  if (!watch) return;
  void useWorkItemDetailsStore.getState().load(watch.target, options);
  // A read that started, or was joined, plans what follows when it ends.
  if (!inFlight.has(key)) follow(key);
}

/**
 * What a watched item does next, planned again after every read of it and
 * when watching starts. It is checked once its entry goes stale, timed from
 * the read rather than from a fixed interval, which would find the entry a
 * read's latency short of stale and wait out a second interval. And while
 * GitHub is still working mergeability out, a quiet read follows shortly,
 * as GitHub's own page keeps asking, a few times per spell of watching.
 */
function follow(key: string): void {
  const watch = watches.get(key);
  if (!watch) return;
  clearTimeout(watch.recheck);
  clearTimeout(watch.poll);
  const entry = useWorkItemDetailsStore.getState().entries[key];
  const age = Date.now() - (entry?.fetchedAt ?? 0);
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
