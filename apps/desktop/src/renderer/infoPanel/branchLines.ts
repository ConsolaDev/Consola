/**
 * What the info panel's Branch section says about a checkout: its branch,
 * what waits to be pushed, what is uncommitted, and how far it has come from
 * its base. Pure, so the wording is decided here and the section only draws
 * it. Every count is what the clone already holds: nothing is fetched.
 */
import type { BranchFacts } from '../../shared/branchFacts';
import type { TabFacts } from '../sidePanel/tabKinds';

/** How many characters of a commit say which it is, as git abbreviates one. */
const SHORT_COMMIT = 7;

/** `1 file`, `2 files`: the count, then the word that agrees with it. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Whether the section is drawn: for a checkout git knows (the repository's
 * own or a linked worktree), and for a removed worktree, whose record still
 * names its branch. Not outside git, nor before git has answered.
 */
export function branchSectionShown(facts: Pick<TabFacts, 'session' | 'checkout'>): boolean {
  if (facts.session.removedWorktree) return true;
  return facts.checkout?.kind === 'main' || facts.checkout?.kind === 'worktree';
}

/**
 * The branch checked out, or the commit a detached HEAD is on. A removed
 * worktree has no checkout to ask, so its record answers: the branch it was
 * on, or the commit it was left at.
 */
export function branchLabel(facts: Pick<TabFacts, 'session' | 'checkout'>): string | null {
  const removed = facts.session.removedWorktree;
  if (removed) return removed.branch ?? `detached at ${removed.commit.slice(0, SHORT_COMMIT)}`;
  const { checkout } = facts;
  if (!checkout || checkout.kind === 'none') return null;
  return checkout.branch ?? `detached at ${checkout.head ?? 'HEAD'}`;
}

/**
 * The branch row's value: the commits waiting to be pushed, and those behind
 * only when there are some. A branch that tracks nothing (or whose tracked
 * ref is gone from the clone) is not pushed yet. A detached HEAD
 * (`onBranch` false) has no branch to push, so it has no value at all.
 */
export function pushValue(
  upstream: BranchFacts['upstream'],
  onBranch: boolean,
): { text: string; title: string } | null {
  if (!onBranch) return null;
  if (!upstream) return { text: 'Not pushed yet', title: 'No upstream branch in this clone' };
  const { ref, ahead, behind } = upstream;
  const toPush = `${plural(ahead, 'commit', 'commits')} to push to ${ref}`;
  return behind === 0
    ? { text: `↑${ahead}`, title: toPush }
    : { text: `↑${ahead} ↓${behind}`, title: `${toPush}, ${behind} behind` };
}

/** What the working tree holds that is not committed; null when nothing, which reads `None`. */
export function uncommittedValue(stats: {
  modifiedCount: number;
  addedLines: number;
  removedLines: number;
}): { files: string; additions: number; deletions: number } | null {
  if (stats.modifiedCount === 0) return null;
  return {
    files: plural(stats.modifiedCount, 'file', 'files'),
    additions: stats.addedLines,
    deletions: stats.removedLines,
  };
}

/**
 * The branch against its base (`vs origin/main`), labelled with the ref it
 * was compared with. Its files are null when nothing differs, which reads
 * `No changes`; no base at all has no line.
 */
export function baseLine(base: BranchFacts['base']): {
  label: string;
  files: string | null;
  additions: number;
  deletions: number;
  title: string;
} | null {
  if (!base) return null;
  return {
    label: `vs ${base.ref}`,
    files: base.files === 0 ? null : plural(base.files, 'file', 'files'),
    additions: base.additions,
    deletions: base.deletions,
    title: `Compared with what this clone last fetched of ${base.ref}. Consola never fetches.`,
  };
}
