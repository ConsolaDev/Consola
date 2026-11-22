import { useEffect } from 'react';
import { create } from 'zustand';
import type { BranchFacts } from '../../shared/branchFacts';
import { gitBridge } from '../services/gitBridge';
import { useGitStatusStore } from './gitStatusStore';

/** One entry per folder and the base it was compared with: one folder can be read against two. */
export function branchFactsKey(dir: string, baseBranch?: string): string {
  return JSON.stringify([dir, baseBranch ?? null]);
}

interface BranchFactsState {
  /** What each checkout's branch was last read as, by `branchFactsKey`. */
  entries: Record<string, BranchFacts>;
  /**
   * Read the branch of `dir` again. One read per key is in flight at a time;
   * a load asked while one runs is answered by one more read once it is
   * done, so a commit made after the running read began is still counted.
   * A read that fails keeps the last answer.
   */
  load(dir: string, baseBranch?: string): Promise<void>;
}

/** The read in flight per key. */
const reading = new Map<string, Promise<void>>();
/** The one read queued behind it, shared by every load asked meanwhile. */
const queued = new Map<string, Promise<void>>();

/**
 * Each checkout's branch beyond its working tree: what waits to be pushed,
 * and how far it has come from its base. Read in main from what the clone
 * already holds, never fetched, and only while someone looks at it (the info
 * panel's Branch section, open).
 */
export const useBranchFactsStore = create<BranchFactsState>((set) => {
  function read(key: string, dir: string, baseBranch: string | undefined): Promise<void> {
    const request = gitBridge
      .getBranchFacts(dir, baseBranch)
      .then((facts) => {
        // No git API answers nothing, which is no reason to forget either.
        if (facts) set((state) => ({ entries: { ...state.entries, [key]: facts } }));
      })
      .catch((error: unknown) => {
        console.warn('Could not read the branch of', dir, error);
      })
      .finally(() => reading.delete(key));
    reading.set(key, request);
    return request;
  }

  return {
    entries: {},

    load: (dir, baseBranch) => {
      const key = branchFactsKey(dir, baseBranch);
      const next = queued.get(key);
      if (next) return next;
      const running = reading.get(key);
      if (!running) return read(key, dir, baseBranch);
      const after = running.then(() => {
        queued.delete(key);
        return read(key, dir, baseBranch);
      });
      queued.set(key, after);
      return after;
    },
  };
});

/**
 * The branch facts of `dir` against `baseBranch` (else origin's default
 * branch), or undefined until first read and for no folder. Reads on mount,
 * on a new key, and after each git status refresh of `dir` lands (the
 * header's refresh button, window focus): the moments a commit, a push or a
 * fetch made elsewhere could have moved the counts.
 */
export function useBranchFacts(
  dir: string | undefined,
  baseBranch: string | undefined,
): BranchFacts | undefined {
  const facts = useBranchFactsStore((state) =>
    dir === undefined ? undefined : state.entries[branchFactsKey(dir, baseBranch)],
  );
  useEffect(() => {
    if (dir === undefined) return;
    const { load } = useBranchFactsStore.getState();
    void load(dir, baseBranch);
    return useGitStatusStore.subscribe((state, previous) => {
      if (state.rootPath === dir && state.refreshedAt !== previous.refreshedAt) {
        void load(dir, baseBranch);
      }
    });
  }, [dir, baseBranch]);
  return facts;
}
