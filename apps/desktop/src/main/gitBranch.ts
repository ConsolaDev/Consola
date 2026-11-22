import type { BranchFacts } from '../shared/branchFacts';
import { readGit as git } from './gitRead';
import { resolveSshRemoteAsync } from './sshRemote';

/**
 * A checkout's branch as the clone already knows it: what it has to push or
 * pull, how far it has come from the branch it merges into, and the names its
 * pull request is found by.
 *
 * Every count compares with the remote-tracking refs the clone kept from its
 * last fetch. On git 2.44 and later nothing here reaches the remote or waits
 * on it: in a partial clone git would otherwise fetch, unasked, a blob the
 * diff needs from the remote it was cloned from, and `GIT_NO_LAZY_FETCH=1`
 * (`readGit`'s) makes the diff fail instead, so its line is not drawn. An
 * older git ignores that variable and fetches.
 *
 * A read git cannot answer (it failed, timed out, is missing, or wrote more
 * than its buffer) is null, and the fact it was for is not drawn.
 */

/**
 * A branch name that can follow `origin/` in an argument: no leading dash, so
 * it is never read as an option, and no `..`, so it is never read as a range.
 */
export function isPlainBranchName(name: string): boolean {
  return /^(?!-)(?!.*\.\.)[\w./-]+$/.test(name);
}

/** The branch HEAD tracks, and the commits on either side of it. */
async function readUpstream(dir: string): Promise<BranchFacts['upstream']> {
  const ref = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!ref) return null;
  const counts = await git(dir, [
    'rev-list',
    '--left-right',
    '--count',
    'HEAD...@{upstream}',
    '--',
  ]);
  const match = counts?.match(/^(\d+)\s+(\d+)$/);
  return match ? { ref, ahead: Number(match[1]), behind: Number(match[2]) } : null;
}

/**
 * What to compare with: the pull request's base when the clone has it, else
 * origin's default branch. Never a guessed `main` or `master`.
 */
async function readBaseRef(dir: string, baseBranch: string | undefined): Promise<string | null> {
  if (baseBranch && isPlainBranchName(baseBranch)) {
    const known = await git(dir, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${baseBranch}`,
    ]);
    if (known !== null) return `origin/${baseBranch}`;
  }
  return (
    (await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])) || null
  );
}

/** A `--numstat` field: a binary file's `-` counts no lines. */
function lineCount(field: string | undefined): number {
  const count = Number(field);
  return Number.isInteger(count) ? count : 0;
}

/** Room for tens of thousands of changed files' numstat lines, as WorktreeService gives its diffs. */
const NUMSTAT_MAX_BUFFER = 10 * 1024 * 1024;

/** HEAD against its merge base with `ref`, or null when the two share no history. */
async function compareWith(dir: string, ref: string): Promise<BranchFacts['base']> {
  const numstat = await git(dir, ['diff', '--numstat', `${ref}...HEAD`, '--'], {
    maxBuffer: NUMSTAT_MAX_BUFFER,
  });
  if (numstat === null) return null;
  const lines = numstat.split('\n').filter(Boolean);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    const [added, deleted] = line.split('\t');
    additions += lineCount(added);
    deletions += lineCount(deleted);
  }
  return { ref, files: lines.length, additions, deletions };
}

/**
 * The branch's push counts and its distance from its base, from what the
 * clone already has. Never throws: anything git cannot answer is a null field,
 * and a folder outside git has neither.
 */
export async function readBranchFacts(dir: string, baseBranch?: string): Promise<BranchFacts> {
  const [upstream, baseRef] = await Promise.all([readUpstream(dir), readBaseRef(dir, baseBranch)]);
  // A base that is the branch's own upstream would only repeat the push count.
  const base = baseRef && baseRef !== upstream?.ref ? await compareWith(dir, baseRef) : null;
  return { upstream, base };
}

export interface BranchIdentity {
  /** Null on a detached HEAD. */
  branch: string | null;
  /** The branch's name on the remote (`branch.<branch>.merge`), else `branch`. */
  remoteBranch: string | null;
  /** `remote get-url origin`, through `resolveRemote`. */
  originUrl: string | null;
}

/** The names a branch's pull request is found by, or null outside git. */
export async function readBranchIdentity(
  dir: string,
  resolveRemote: (url: string) => Promise<string> = resolveSshRemoteAsync,
): Promise<BranchIdentity | null> {
  if ((await git(dir, ['rev-parse', '--git-dir'])) === null) return null;
  const [branch, originUrl] = await Promise.all([
    git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(dir, ['remote', 'get-url', 'origin']),
  ]);
  const [merge, resolvedOrigin] = await Promise.all([
    branch ? git(dir, ['config', '--get', `branch.${branch}.merge`]) : null,
    originUrl ? resolveRemote(originUrl) : null,
  ]);
  return {
    branch: branch || null,
    remoteBranch: merge?.startsWith('refs/heads/')
      ? merge.slice('refs/heads/'.length)
      : branch || null,
    originUrl: resolvedOrigin,
  };
}
