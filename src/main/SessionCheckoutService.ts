import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { CheckoutContext, CheckoutWorktree, SessionCheckout } from '../shared/sessionCheckout';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new Error((error as { stderr?: string }).stderr?.trim() || String(error));
  }
}

/** Local conversation checkouts; never switches or resets the user's checkout. */
export class SessionCheckoutService {
  constructor(private readonly root = process.env.CONSOLA_WORKTREES_DIR ??
    path.join(os.homedir(), '.consola', 'worktrees')) {}

  async list(repo: string): Promise<CheckoutContext> {
    const [raw, refs, currentRoot] = await Promise.all([
      git(repo, ['worktree', 'list', '--porcelain', '-z']),
      git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
      git(repo, ['rev-parse', '--show-toplevel']),
    ]);
    const worktrees: CheckoutWorktree[] = [];
    for (const record of raw.split('\0\0')) {
      const fields = record.split('\0');
      const location = fields.find(field => field.startsWith('worktree '))?.slice(9);
      if (!location || fields.includes('bare')) continue;
      const branch = fields.find(field => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '');
      worktrees.push({
        path: location, branch,
        head: fields.find(field => field.startsWith('HEAD '))?.slice(5) ?? '',
        current: location === currentRoot.trim(),
        unavailable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')),
      });
    }
    return {
      branch: worktrees.find(tree => tree.current)?.branch,
      refs: refs.trim().split('\n').filter(ref => ref && !ref.endsWith('/HEAD')).map(ref => ref.replace(/^refs\/(heads|remotes)\//, '')),
      localBranches: refs.trim().split('\n').filter(ref => ref.startsWith('refs/heads/')).map(ref => ref.slice(11)),
      worktrees,
    };
  }

  async prepare(repo: string, checkout: SessionCheckout): Promise<string> {
    if (checkout.mode === 'current') {
      const stat = await fs.stat(repo);
      if (!stat.isDirectory()) throw new Error('The selected folder is no longer available.');
      return repo;
    }
    const context = await this.list(repo);
    if (checkout.mode === 'existing') {
      const requestedPath = await fs.realpath(checkout.path).catch(() => checkout.path);
      const tree = context.worktrees.find(candidate => candidate.path === requestedPath);
      if (!tree || tree.unavailable) throw new Error('This worktree is no longer available. Refresh and choose another.');
      // Revalidate membership, including a directory replaced after listing.
      const [actual, expected] = await Promise.all([
        git(tree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      ]);
      if (actual !== expected) throw new Error('This worktree belongs to a different repository.');
      return tree.path;
    }
    if (checkout.mode !== 'new') throw new Error('Invalid checkout mode.');
    if (typeof checkout.baseRef !== 'string' || !checkout.baseRef || checkout.baseRef.startsWith('-')) {
      throw new Error('Choose a valid base branch.');
    }
    // Resolve before mutation; --end-of-options prevents refs being read as flags.
    const commit = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${checkout.baseRef}^{commit}`])).trim();
    const suffix = randomUUID().slice(0, 8);
    const branch = checkout.useExistingBranch ? checkout.baseRef : checkout.branchName?.trim() || `consola/session-${suffix}`;
    await git(repo, ['check-ref-format', '--branch', branch]);
    if (checkout.useExistingBranch) {
      await git(repo, ['show-ref', '--verify', `refs/heads/${branch}`]);
      const existing = context.worktrees.find(tree => tree.branch === branch && !tree.unavailable);
      if (existing) return this.prepare(repo, { mode: 'existing', path: existing.path });
    }
    const dir = path.join(this.root, `${path.basename(repo)}-session-${suffix}`);
    await fs.mkdir(this.root, { recursive: true });
    await git(repo, checkout.useExistingBranch
      ? ['worktree', 'add', '--', dir, branch]
      : ['worktree', 'add', '-b', branch, '--', dir, commit]);
    return fs.realpath(dir);
  }
}
