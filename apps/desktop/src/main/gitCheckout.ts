import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import type { CheckoutInfo } from '../shared/sessionCheckout';

const execFileAsync = promisify(execFile);

/** A hung git (a stale lock on a network drive) must not hold a header hostage. */
const GIT_TIMEOUT_MS = 10_000;

/** stdout, or null when git fails — which here only ever means "not this". */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Which checkout `dir` is: the repository's own, or a linked worktree.
 *
 * A linked worktree's git directory is `<common dir>/worktrees/<name>`, which
 * is the test used here rather than "git dir differs from common dir": that
 * also holds inside a submodule, which is a repository's own checkout.
 *
 * Costs two git processes (three on a detached HEAD), none of which touch the
 * working tree, so it stays cheap enough to run for every sidebar row.
 */
export async function readCheckout(dir: string): Promise<CheckoutInfo> {
  const located = await git(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ]);
  const [root, gitDir, commonDir] = located?.split('\n') ?? [];
  if (!root || !gitDir || !commonDir) return { kind: 'none' };

  const isWorktree = path.dirname(gitDir) === path.join(commonDir, 'worktrees');
  // A repository's common dir is its checkout's `.git`; a bare repository's
  // worktrees hang off the bare directory itself.
  const mainCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;

  // symbolic-ref rather than `rev-parse --abbrev-ref HEAD`: it names a branch
  // that has no commits yet, and fails cleanly — rather than printing "HEAD" —
  // when HEAD is detached.
  const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = branch ? null : await git(dir, ['rev-parse', '--short', 'HEAD']);

  return {
    kind: isWorktree ? 'worktree' : 'main',
    root,
    mainCheckout,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
  };
}
