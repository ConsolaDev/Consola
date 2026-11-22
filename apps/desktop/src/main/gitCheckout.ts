import * as path from 'node:path';
import type { CheckoutInfo } from '../shared/sessionCheckout';
import { readGit as git } from './gitRead';

/**
 * Which checkout `dir` is: the repository's own, or a linked worktree. When
 * git cannot say where `dir` is (outside git, a timeout, no git), it is none.
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
