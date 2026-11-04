import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { GitProviderId } from '../shared/providers';
import type { WorkItemRef } from '../shared/workItems';
import type { Workspace } from '../shared/workspace';
import { getProviderDriver, type GitProviderDriver } from './providers';
import { resolveSshRemote } from './sshRemote';

const execFileAsync = promisify(execFile);

/** A fetch on a dead network must not stall a cleanup run indefinitely. */
const GIT_TIMEOUT_MS = 60_000;

/** Branches no cleanup ever deletes, whatever a remote's HEAD says. */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

/** What `WorktreeService.inspect` learns about a checkout. */
export interface WorktreeInspection {
  /** Real path of the checkout's top level. */
  toplevel: string;
  /** The clone it belongs to: the parent of its common git directory. */
  mainRepo: string;
  /** False for a clone's own checkout, which Consola never removes. */
  isLinkedWorktree: boolean;
  head: string;
  /** The local branch checked out; null when HEAD is detached. */
  branch: string | null;
  /** The branch's name on the remote, from its tracking config; else `branch`. */
  remoteBranch: string | null;
  originUrl: string | null;
  /** Uncommitted changes or untracked files (ignored files do not count). */
  dirty: boolean;
}

export type PublishedVerdict = 'published' | 'local-commits' | 'unverifiable';

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Spec naming: `<repo-basename>-<type>-<number>`, e.g. catalog-portal-pr-51. */
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
 * through the workspace's driver; the URL with SSH aliases resolved is cached — per
 * directory, invalidated when scopes change (wired to
 * WorkspaceService.onChange) — because a `git remote get-url` per directory
 * per scan would otherwise run on every Inbox paint, and a cached
 * provider-derived value would go stale if the binding changed.
 */
export class WorktreeService {
  /** Directory -> origin URL with SSH aliases resolved (or null for non-repos). */
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
      if (origin) origin = resolveSshRemote(origin);
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

  /**
   * Whether `dir` is one of Consola's own worktrees: a direct child of the
   * root, compared by real path so a symlink or `..` cannot smuggle a scope
   * folder or a hand-made worktree in.
   */
  public isManagedPath(dir: string): boolean {
    const root = realpathOrNull(this.root);
    const target = realpathOrNull(dir);
    return root !== null && target !== null && path.dirname(target) === root;
  }

  /**
   * The facts that decide whether removing a checkout could lose work.
   * Null when `dir` is gone or is not inside a git checkout at all.
   */
  public async inspect(dir: string): Promise<WorktreeInspection | null> {
    if (!fs.existsSync(dir)) return null;
    const facts = await this.git(dir, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
      'HEAD',
    ]);
    if (facts.code !== 0) return null;
    const [toplevel, gitDir, commonDir, head] = facts.stdout.trim().split('\n');
    if (!toplevel || !gitDir || !commonDir || !head) return null;

    const [branchOut, status, origin] = await Promise.all([
      this.git(toplevel, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.git(toplevel, ['status', '--porcelain']),
      this.git(toplevel, ['remote', 'get-url', 'origin']),
    ]);
    const branch = branchOut.code === 0 ? branchOut.stdout.trim() || null : null;
    let remoteBranch: string | null = branch;
    if (branch) {
      const merge = await this.git(toplevel, ['config', '--get', `branch.${branch}.merge`]);
      const tracked = merge.stdout.trim();
      // A branch pushed under another name tracks it here; `gh pr checkout`
      // of a fork tracks refs/pull/<n>/head, which names no branch at all.
      if (merge.code === 0 && tracked.startsWith('refs/heads/')) {
        remoteBranch = tracked.slice('refs/heads/'.length);
      }
    }
    return {
      toplevel: realpathOrNull(toplevel) ?? toplevel,
      mainRepo: path.dirname(commonDir),
      isLinkedWorktree: path.resolve(gitDir) !== path.resolve(commonDir),
      head,
      branch,
      remoteBranch,
      originUrl: origin.code === 0 ? resolveSshRemote(origin.stdout.trim()) || null : null,
      // Status failing is treated as dirty: if git cannot say the tree is
      // clean, it is not clean enough to delete.
      dirty: status.code !== 0 || status.stdout.trim().length > 0,
    };
  }

  /**
   * Whether every commit on this checkout's HEAD exists somewhere else.
   *
   * With `knownHead` (a PR's final head commit), HEAD must be that commit or
   * an ancestor of it — correct for squash and rebase merges, where the merge
   * commit is not a descendant of the branch. The commit is fetched once via
   * `fetchRef` if this clone has never seen it. Without one, HEAD must be
   * reachable from a remote-tracking ref.
   */
  public async commitsArePublished(
    inspection: WorktreeInspection,
    options: { knownHead?: string; fetchRef?: string },
    env: NodeJS.ProcessEnv
  ): Promise<PublishedVerdict> {
    const cwd = inspection.toplevel;
    const { knownHead, fetchRef } = options;
    if (knownHead) {
      if (inspection.head === knownHead) return 'published';
      const hasCommit = async () =>
        (await this.git(cwd, ['cat-file', '-e', `${knownHead}^{commit}`])).code === 0;
      let present = await hasCommit();
      if (!present && fetchRef) {
        await this.git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', fetchRef], {
          ...env,
          GIT_TERMINAL_PROMPT: '0',
        });
        present = await hasCommit();
      }
      if (!present) return 'unverifiable';
      const ancestor = await this.git(cwd, ['merge-base', '--is-ancestor', inspection.head, knownHead]);
      if (ancestor.code === 0) return 'published';
      return ancestor.code === 1 ? 'local-commits' : 'unverifiable';
    }
    const unpublished = await this.git(cwd, ['rev-list', '--count', inspection.head, '--not', '--remotes']);
    if (unpublished.code !== 0) return 'unverifiable';
    return Number(unpublished.stdout.trim()) === 0 ? 'published' : 'local-commits';
  }

  /**
   * `git worktree remove` without `--force`, so git itself refuses a tree
   * that became dirty after it was inspected. Refuses anything that is not
   * one of Consola's own linked worktrees.
   */
  public async removeWorktree(inspection: WorktreeInspection): Promise<void> {
    if (!inspection.isLinkedWorktree || !this.isManagedPath(inspection.toplevel)) {
      throw new Error(`Refusing to remove ${inspection.toplevel}: it is not a Consola worktree.`);
    }
    const removed = await this.git(inspection.mainRepo, ['worktree', 'remove', inspection.toplevel]);
    if (removed.code !== 0) {
      throw new Error(removed.stderr.trim() || `git worktree remove ${inspection.toplevel} failed.`);
    }
  }

  /**
   * Delete a local branch only if it still points at `expectedHead` — the
   * commit that was just proven published. `update-ref -d <ref> <old>` is a
   * compare-and-swap, so unlike `branch -d` it works for squash-merged
   * branches and still cannot delete anything that moved meanwhile. Never
   * deletes the default branch or one checked out in another worktree.
   */
  public async deleteBranchAt(
    mainRepo: string,
    branch: string,
    expectedHead: string
  ): Promise<{ deleted: true } | { deleted: false; reason: string }> {
    if (PROTECTED_BRANCHES.has(branch)) return { deleted: false, reason: `${branch} is protected` };
    const defaultRef = await this.git(mainRepo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (defaultRef.code === 0 && defaultRef.stdout.trim().replace(/^[^/]+\//, '') === branch) {
      return { deleted: false, reason: `${branch} is the default branch` };
    }
    const worktrees = await this.git(mainRepo, ['worktree', 'list', '--porcelain']);
    if (worktrees.code !== 0) return { deleted: false, reason: 'could not list worktrees' };
    if (worktrees.stdout.split('\n').includes(`branch refs/heads/${branch}`)) {
      return { deleted: false, reason: `${branch} is checked out in another worktree` };
    }
    const deleted = await this.git(mainRepo, ['update-ref', '-d', `refs/heads/${branch}`, expectedHead]);
    if (deleted.code !== 0) {
      return { deleted: false, reason: `${branch} no longer points at ${expectedHead.slice(0, 7)}` };
    }
    // update-ref leaves the tracking config behind; harmless, so best-effort.
    await this.git(mainRepo, ['config', '--remove-section', `branch.${branch}`]);
    return { deleted: true };
  }

  /** A git call whose exit code is an answer, not an error. */
  private async git(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
        env: env as { [key: string]: string },
        maxBuffer: 10 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : -1,
        stdout: failure.stdout?.toString() ?? '',
        stderr: failure.stderr?.toString() ?? '',
      };
    }
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
