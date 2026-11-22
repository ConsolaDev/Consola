import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BranchFacts } from '../shared/branchFacts';
import { resolveSshRemote } from './sshRemote';

/**
 * A checkout's branch as the clone already knows it: what it has to push or
 * pull, how far it has come from the branch it merges into, and the names its
 * pull request is found by.
 *
 * These reads never fetch. Every count compares with the remote-tracking refs
 * the clone kept from its last fetch, so nothing here reaches the remote or
 * waits on it. `GIT_NO_LAZY_FETCH=1` keeps that true in a partial clone, where
 * git would otherwise fetch, unasked, a blob the diff needs from the remote it
 * was cloned from; there the diff fails instead, and its line is not drawn.
 */

const execFileAsync = promisify(execFile);

/** A hung git (a stale lock on a network drive) must not hold the panel hostage. */
const GIT_TIMEOUT_MS = 10_000;

/** stdout, or null when git fails, which here only ever means "no such fact". */
async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

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

/** HEAD against its merge base with `ref`, or null when the two share no history. */
async function compareWith(dir: string, ref: string): Promise<BranchFacts['base']> {
  const numstat = await git(dir, ['diff', '--numstat', `${ref}...HEAD`, '--']);
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
  resolveRemote: (url: string) => string = resolveSshRemote,
): Promise<BranchIdentity | null> {
  if ((await git(dir, ['rev-parse', '--git-dir'])) === null) return null;
  const [branch, originUrl] = await Promise.all([
    git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(dir, ['remote', 'get-url', 'origin']),
  ]);
  const merge = branch ? await git(dir, ['config', '--get', `branch.${branch}.merge`]) : null;
  return {
    branch: branch || null,
    remoteBranch: merge?.startsWith('refs/heads/')
      ? merge.slice('refs/heads/'.length)
      : branch || null,
    originUrl: originUrl ? resolveRemote(originUrl) : null,
  };
}
