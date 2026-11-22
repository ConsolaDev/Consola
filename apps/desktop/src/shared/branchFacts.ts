/**
 * What a checkout's branch holds beyond its working tree: the commits it has
 * to push or pull, and how far it has come from the branch it will merge
 * into. Read in main from what the clone already has; nothing is fetched.
 */
export interface BranchFacts {
  /** Null on a detached HEAD, for a branch that tracks nothing, or when the tracked ref is gone from the clone. */
  upstream: { ref: string; ahead: number; behind: number } | null;
  /** HEAD against its merge base with `ref`. Null with no origin, no base ref, no merge base, or a base that is the branch's own upstream. */
  base: { ref: string; files: number; additions: number; deletions: number } | null;
}

/** The answer for a folder outside git, or one git could not read. */
export const NO_BRANCH_FACTS: BranchFacts = Object.freeze({ upstream: null, base: null });
