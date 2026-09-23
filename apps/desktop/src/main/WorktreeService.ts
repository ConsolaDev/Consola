import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { GitProviderId } from '../shared/providers';
import type { WorkItemRef } from '../shared/workItems';
import type { Workspace } from '../shared/workspace';
import { getProviderDriver, type GitProviderDriver } from './providers';

const execFileAsync = promisify(execFile);

/** Spec naming: `<repo-basename>-<type>-<number>`, e.g. controller-app-pr-51. */
export function worktreeDirName(workItem: WorkItemRef): string {
  const basename = workItem.repo.split('/').pop() ?? workItem.repo;
  return `${basename}-${workItem.type}-${workItem.number}`;
}

/**
 * Owns work-item worktrees under ~/.consola/worktrees/ and the mapping from
 * remote repos to local clones.
 *
 * The mapping scans the workspace's scopes: a repo scope matches on its origin
 * remote; a container scope scans its direct children. Whether a remote URL
 * names a repo is the provider's call (host, casing), so matching goes
 * through the workspace's driver; the raw URL is what gets cached — per
 * directory, invalidated when scopes change (wired to
 * WorkspaceService.onChange) — because a `git remote get-url` per directory
 * per scan would otherwise run on every Inbox paint, and a cached
 * provider-derived value would go stale if the binding changed.
 */
export class WorktreeService {
  /** Directory -> raw origin remote URL (or null for non-repos). */
  private readonly remoteCache = new Map<string, string | null>();

  constructor(
    private readonly root: string = process.env.CONSOLA_WORKTREES_DIR ??
      path.join(os.homedir(), '.consola', 'worktrees'),
    private readonly resolveDriver: (id: GitProviderId) => GitProviderDriver = getProviderDriver
  ) {}

  public invalidate(): void {
    this.remoteCache.clear();
  }

  /**
   * Local clone for a remote repo, found through the workspace's scopes.
   *
   * An unbound workspace — or one bound to a provider this build lacks — has
   * nothing to match against and resolves nothing; the launch path then
   * offers the clone flow, which reports the real reason.
   */
  public resolveRepo(workspace: Workspace, repo: string): string | null {
    const driver = this.driverFor(workspace);
    if (!driver) return null;
    for (const scope of workspace.scopes) {
      if (this.matches(driver, scope.path, repo)) return scope.path;
      if (!scope.isGitRepo) {
        for (const child of this.childDirs(scope.path)) {
          if (this.matches(driver, child, repo)) return child;
        }
      }
    }
    return null;
  }

  private driverFor(workspace: Workspace): GitProviderDriver | null {
    const provider = workspace.provider;
    if (!provider) return null;
    try {
      return this.resolveDriver(provider.id);
    } catch {
      return null; // A provider this build lacks: nothing can match, so nothing does.
    }
  }

  private matches(driver: GitProviderDriver, dir: string, repo: string): boolean {
    const origin = this.originOf(dir);
    return origin !== null && driver.matchesRemote(origin, repo);
  }

  private childDirs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(dir, entry.name));
    } catch {
      // A scope pointing at a moved folder resolves nothing; the launch path
      // reports "not cloned", which offers the clone flow — strictly better
      // than throwing here.
      return [];
    }
  }

  private originOf(dir: string): string | null {
    const cached = this.remoteCache.get(dir);
    if (cached !== undefined) return cached;
    let origin: string | null = null;
    try {
      origin =
        execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() || null;
    } catch {
      origin = null; // Not a repo, or no origin — either way, not a match.
    }
    this.remoteCache.set(dir, origin);
    return origin;
  }

  /** Absolute `git-common-dir` for `dir` — the same value for every worktree of one repo. */
  private async gitCommonDir(dir: string, env: NodeJS.ProcessEnv): Promise<string> {
    const out = await this.run(
      'git',
      dir,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      env
    );
    return out.trim();
  }

  /**
   * Refuse to hand back `dir` unless it is actually a worktree of `clonePath`.
   *
   * Only called on the fast path, where `dir` was found to already exist —
   * so this never adds a subprocess to a fresh worktree creation, only to
   * reusing one.
   */
  private async assertBelongsToClone(
    dir: string,
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    const [existingCommonDir, expectedCommonDir] = await Promise.all([
      this.gitCommonDir(dir, env),
      this.gitCommonDir(clonePath, env),
    ]);
    if (existingCommonDir === expectedCommonDir) return;
    throw new Error(
      `${dir} already exists but is a worktree of a different repository ` +
        `(git dir ${existingCommonDir}), not ${clonePath} (git dir ${expectedCommonDir}). ` +
        `Refusing to hand it to ${workItem.repo} ${workItem.type} #${workItem.number} — ` +
        `two repositories share the worktree name "${worktreeDirName(workItem)}" here. ` +
        `Remove the stale worktree, or clone one of them somewhere the collision cannot happen, ` +
        `before retrying.`
    );
  }

  /**
   * The worktree for a work item, creating or recreating it as needed.
   *
   * Idempotent by design: resuming a session whose worktree was deleted lands
   * here again before the PTY spawns, and the checkout must simply happen
   * again. A linked worktree keeps a `.git` *file* pointing at the clone, so
   * its presence is the "already exists" signal — but the worktree directory
   * name (`<repo-basename>-<type>-<number>`) is global across every clone in
   * every workspace, so two repos that merely share a basename (e.g. two
   * different orgs' `docs`) can collide on it. Before trusting an existing
   * directory, its `git-common-dir` (which a linked worktree always points
   * back at its origin repo's `.git`) must match `clonePath`'s own — that is
   * the precise test for "this worktree actually belongs to this clone",
   * unlike comparing origin URLs, which two clones of the *same* repo would
   * also satisfy without proving *this* directory came from *this* clone.
   * A mismatch refuses loudly rather than handing back another repo's
   * worktree: silently doing so would point an agent's `gh` calls at the
   * wrong repository, including any review or comment it writes.
   *
   * PRs: `git worktree add --detach`, then the provider's checkout inside it
   * (for GitHub, `gh pr checkout <n>` — gh owns the branch naming and the
   * fetch, with the token in `env`). Issues: a `consola/issue-<n>` branch,
   * created on first use, reused after; there is nothing remote to fetch.
   */
  public async ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string> {
    const dir = path.join(this.root, worktreeDirName(workItem));
    if (fs.existsSync(path.join(dir, '.git'))) {
      await this.assertBelongsToClone(dir, clonePath, workItem, env);
      return dir;
    }

    await fs.promises.mkdir(this.root, { recursive: true });
    // A worktree whose directory was deleted stays registered and would make
    // `worktree add` refuse; prune drops stale registrations only.
    await this.run('git', clonePath, ['worktree', 'prune'], env);

    if (workItem.type === 'pr') {
      await this.run('git', clonePath, ['worktree', 'add', '--detach', dir], env);
      // From here on this call owns a worktree it just created: if the
      // checkout fails, leaving it behind would make the next call's fast
      // path treat a half-provisioned worktree as done forever, with the
      // session running against the wrong commit and no error ever
      // surfacing again. Undo the add and let the original error travel up.
      try {
        await this.resolveDriver(workItem.provider).checkout(dir, workItem, env);
      } catch (error) {
        await this.removeCreatedWorktree(clonePath, dir);
        throw error;
      }
    } else {
      const branch = `consola/issue-${workItem.number}`;
      const existing = await this.run('git', clonePath, ['branch', '--list', branch], env);
      await this.run(
        'git',
        clonePath,
        existing.trim()
          ? ['worktree', 'add', dir, branch]
          : ['worktree', 'add', '-b', branch, dir],
        env
      );
      // No step follows the add on this path today, so there is nothing to
      // unwind — but if one is added later, wrap it the same way as above.
    }
    return dir;
  }

  /**
   * Best-effort cleanup for a worktree this call created but could not
   * finish provisioning. Never removes a worktree it did not just create —
   * that could destroy a user's in-progress work. Failures here are
   * swallowed: the caller's original git/gh error is what must reach the
   * Inbox, never a secondary cleanup failure.
   */
  private async removeCreatedWorktree(clonePath: string, dir: string): Promise<void> {
    try {
      await this.run('git', clonePath, ['worktree', 'remove', '--force', dir], process.env);
    } catch {
      // Best-effort only; the original error above is what gets thrown.
    }
  }

  /**
   * Remove a work-item worktree — offered, never automatic.
   *
   * Refuses while the worktree holds uncommitted changes: pruning is cleanup,
   * and cleanup must never be the thing that loses work.
   */
  public async prune(worktreePath: string): Promise<void> {
    const status = await this.run('git', worktreePath, ['status', '--porcelain'], process.env);
    if (status.trim()) {
      throw new Error(
        `Refusing to prune ${worktreePath}: it has uncommitted changes. Commit or discard them first.`
      );
    }
    const commonDir = (
      await this.run(
        'git',
        worktreePath,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        process.env
      )
    ).trim();
    const mainRoot = path.dirname(commonDir);
    await this.run('git', mainRoot, ['worktree', 'remove', worktreePath], process.env);
  }

  /** Run a subprocess; on failure surface stderr as the Error message. */
  private async run(
    binary: string,
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(binary, args, {
        cwd,
        env: env as { [key: string]: string },
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
      throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
    }
  }
}
