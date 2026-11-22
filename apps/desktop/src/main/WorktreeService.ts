import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { GitProviderId } from '../shared/providers';
import type { WorkItemRef } from '../shared/workItems';
import type { Workspace } from '../shared/workspace';
import type { RemovedWorktree } from '../shared/worktreeCleanup';
import { getProviderDriver, type GitProviderDriver } from './providers';
import { withoutRepositoryOverrides } from '@consola/automation-engine';
import { withoutGitHooks } from './gitHooks';
import { resolveSshRemote } from './sshRemote';
import {
  type AtRiskFiles,
  ignoredAtRisk,
  type NestedRepos,
  nestedRepos,
} from './worktreeCleanup/localFiles';
import { type PathLock, worktreePathLock } from './worktreeCleanup/PathLock';

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
  /** How many paths `git status` lists; 0 when it could not say. */
  dirtyFiles: number;
}

/** What putting a removed worktree back found or did. */
export type RestoreResult =
  /** The folder was there all along (a removal that never finished): left as it is. */
  | { kind: 'existed'; head: string }
  /** Recreated on the recorded commit, on its branch when that had not moved, else detached. */
  | { kind: 'rebuilt'; branch: string | null };

/** Skip-worktree or assume-unchanged files whose content differs from the index. */
export type HiddenChanges =
  | { kind: 'none' }
  | { kind: 'some'; paths: string[] }
  | { kind: 'unknown' };

export type PublishedVerdict = 'published' | 'local-commits' | 'unverifiable';

/**
 * The automation checkout exists and is Consola's, but could not be brought
 * to the item's head: the provider's checkout, or the fetch, failed. Retrying
 * once the head can be fetched may work, unlike any other failure there.
 */
export class HeadCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadCheckoutError';
  }
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** A real path in the disk's own case (macOS's filesystem ignores case), or null when it is gone. */
function canonicalPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target);
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

  /**
   * Puts back a worktree a cleanup rule removed, when a record names `dir`
   * (`WorktreeRebuilder.restoreAt`). Called with the folder's lock held,
   * before anything here would recreate it at a pull request's latest head.
   * Set at wiring time.
   */
  public restoreRemoved?: (dir: string) => Promise<unknown>;

  constructor(
    private readonly root: string = process.env.CONSOLA_WORKTREES_DIR ??
      path.join(os.homedir(), '.consola', 'worktrees'),
    private readonly resolveDriver: (id: GitProviderId) => GitProviderDriver = getProviderDriver,
    private readonly lock: PathLock = worktreePathLock,
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
      env,
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
    env: NodeJS.ProcessEnv,
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
        `before retrying.`,
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
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    const dir = path.join(this.root, worktreeDirName(workItem));
    // Under the folder's lock, so a removal cannot run between this handing
    // the folder back and the session that will use it being recorded; the
    // stamp covers the rest of that gap.
    const ready = await this.lock.run(dir, () =>
      this.ensureWorktreeLocked(dir, clonePath, workItem, env),
    );
    this.lock.markPrepared(ready);
    return ready;
  }

  private async ensureWorktreeLocked(
    dir: string,
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    // Only the rebuilder recreates a folder a removal record names: on the
    // commit it was left at, never the PR's latest head under a path the
    // CLI already trusts.
    if (this.restoreRemoved) await this.restoreRemoved(dir);
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
        await this.checkoutPullRequest(dir, workItem, env);
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
        existing.trim() ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir],
        env,
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

  /** Where `ensureWorktree` keeps an item's worktree, whether or not it exists yet. */
  public worktreePathFor(workItem: WorkItemRef): string {
    return path.join(this.root, worktreeDirName(workItem));
  }

  /**
   * Where `syncAutomationCheckout` keeps an item's automation checkout,
   * whether or not it exists yet: beside the Inbox's worktree, a direct child
   * of the root, so `isManagedPath` and the stale-session cleanup cover it.
   */
  public automationCheckoutPathFor(workItem: WorkItemRef): string {
    return path.join(this.root, `${worktreeDirName(workItem)}-automation`);
  }

  /**
   * Bring an item's automation checkout to the item's head, making it first
   * when it is missing, and say which commit that is.
   *
   * It is used only by `steps:` runs, and is detached, never on a branch: a
   * branch can be checked out in one worktree only, and the Inbox's has the
   * PR's. Each preparation first undoes what an earlier run's commands left
   * (`reset --hard`, `clean -fd`), keeping ignored files such as a build
   * cache. A PR is then checked out the provider's way, detached; an issue
   * at origin's HEAD. This is a PR author's tree, so every call runs with git
   * hooks off, and without any variable that aims git at another repository
   * or index, whatever `env` the caller composed.
   *
   * Nothing is reset until the folder is proven to be the linked worktree
   * this made (`assertOwnAutomationCheckout`): a reset in anything else, a
   * symlink to the clone say, would destroy someone's work. A failure to
   * reach the head is a `HeadCheckoutError`; any other failure is not.
   */
  public async syncAutomationCheckout(
    clonePath: string,
    workItem: WorkItemRef,
    callerEnv: NodeJS.ProcessEnv,
  ): Promise<{ dir: string; head: string }> {
    const env = withoutGitHooks(withoutRepositoryOverrides(callerEnv));
    // Before anything is made: a provider this build lacks is not a fetch that may work later.
    const driver = workItem.type === 'pr' ? this.resolveDriver(workItem.provider) : null;
    const dir = this.automationCheckoutPathFor(workItem);
    await fs.promises.mkdir(this.root, { recursive: true });
    await this.run('git', clonePath, ['worktree', 'prune'], env);
    const entry = await lstatOrNull(dir);
    if (entry && (entry.isSymbolicLink() || (await lstatOrNull(path.join(dir, '.git'))))) {
      await this.assertOwnAutomationCheckout(dir, clonePath, workItem, env);
      await this.run('git', dir, ['reset', '--hard', '-q'], env);
      await this.run('git', dir, ['clean', '-fdq'], env);
    } else {
      // Missing, or a folder with no .git: git's own refusal says which.
      await this.run('git', clonePath, ['worktree', 'add', '--detach', dir], env);
    }
    try {
      if (driver) {
        await driver.checkout(dir, workItem, env, { detach: true });
      } else {
        // Nobody is there to answer a credential prompt.
        await this.run('git', dir, ['fetch', '--quiet', 'origin', 'HEAD'], {
          ...env,
          GIT_TERMINAL_PROMPT: '0',
        });
        await this.run('git', dir, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], env);
      }
    } catch (error) {
      throw new HeadCheckoutError(error instanceof Error ? error.message : String(error));
    }
    const head = (await this.run('git', dir, ['rev-parse', 'HEAD'], env)).trim();
    return { dir, head };
  }

  /**
   * Refuse, before anything is reset, unless `dir` is provably the item's
   * automation checkout:
   * - a real folder (not a symlink), directly in Consola's worktree root;
   * - whose `.git` is the plain file a linked worktree has, not a link to
   *   another worktree's;
   * - a linked worktree of `clonePath` whose git dir is its own: git's
   *   back-pointer names this folder's `.git`;
   * - at its own top level, and neither the clone nor the Inbox's worktree.
   *
   * `existsSync` follows symlinks and every worktree of a clone shares its
   * common dir, so neither alone proves it. Paths are compared in the disk's
   * own case, so a root written in another case still finds its own.
   */
  private async assertOwnAutomationCheckout(
    dir: string,
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const refuse = (why: string) =>
      new Error(
        `Refusing to reset ${dir}: ${why}, so it is not an automation checkout Consola made. ` +
          `Nothing in it was changed; move it aside, then retry.`,
      );
    const entry = await fs.promises.lstat(dir);
    if (entry.isSymbolicLink()) throw refuse('it is a symbolic link');
    if (!entry.isDirectory()) throw refuse('it is not a folder');
    const dotGit = await lstatOrNull(path.join(dir, '.git'));
    if (dotGit?.isSymbolicLink()) throw refuse('its .git is a symbolic link');
    if (!dotGit?.isFile()) throw refuse('its .git is not the file a linked worktree has');
    const real = canonicalPathOrNull(dir);
    if (!real || !this.isDirectChildOfRoot(dir, canonicalPathOrNull))
      throw refuse('it is not in Consola’s worktree folder');
    await this.assertBelongsToClone(dir, clonePath, workItem, env);
    const [toplevel, gitDir, commonDir] = (
      await this.run(
        'git',
        dir,
        ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
        env,
      )
    )
      .trim()
      .split('\n');
    if (!toplevel || !gitDir || !commonDir) throw refuse('git cannot say what it is');
    if (
      canonicalPathOrNull(path.dirname(gitDir)) !==
      canonicalPathOrNull(path.join(commonDir, 'worktrees'))
    ) {
      throw refuse('it is not a linked worktree of the clone');
    }
    // Git writes it absolute, or relative to the git dir (`worktree.useRelativePaths`).
    let pointsAt: string | null = null;
    try {
      const written = path.resolve(
        gitDir,
        fs.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim(),
      );
      const folder = canonicalPathOrNull(path.dirname(written));
      pointsAt = folder ? path.join(folder, path.basename(written)) : null;
    } catch {
      pointsAt = null;
    }
    // This folder's own `.git`, never wherever a link there leads.
    if (pointsAt !== path.join(real, '.git'))
      throw refuse('its git dir belongs to another worktree');
    if (canonicalPathOrNull(toplevel) !== real) throw refuse(`it is inside ${toplevel}`);
    if (real === canonicalPathOrNull(clonePath)) throw refuse('it is the clone itself');
    if (real === canonicalPathOrNull(this.worktreePathFor(workItem)))
      throw refuse('it is the Inbox’s worktree for this item');
  }

  /**
   * Bring an existing pull-request worktree up to the PR's current head, the
   * provider's own checkout run again — so a review requested again after new
   * pushes reads the new code, not the commit the folder was made at.
   *
   * Only a clean worktree is touched: anything uncommitted in it is someone's
   * work, and a refresh must never be what loses it. Returns whether it ran.
   */
  public async refreshPullRequest(
    dir: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    if (workItem.type !== 'pr') return false;
    return this.lock.run(dir, async () => {
      if (!fs.existsSync(path.join(dir, '.git'))) return false;
      const status = await this.run(
        'git',
        dir,
        ['status', '--porcelain', '--untracked-files=normal'],
        env,
      );
      if (status.trim()) return false;
      await this.checkoutPullRequest(dir, workItem, env);
      return true;
    });
  }

  /**
   * The provider's checkout, recovering from the one failure an earlier
   * checkout sets up. Branches belong to the clone, not to a worktree, so
   * removing a review's worktree keeps the branch its checkout made, and the
   * next checkout of that PR reuses it — fast-forward only. Once the author
   * has force-pushed (a rebase onto the base branch, say), no fast-forward
   * exists and the checkout refuses.
   *
   * A branch whose every commit came from a remote is only a stale copy of
   * the PR, and the checkout runs again told to reset it. A commit nobody
   * pushed is someone's work: then the error stands, and says why.
   */
  private async checkoutPullRequest(
    dir: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const driver = this.resolveDriver(workItem.provider);
    try {
      await driver.checkout(dir, workItem, env);
    } catch (error) {
      // Still detached: the checkout failed before reaching a reused branch.
      const branch = await this.git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env);
      if (branch.code !== 0) throw error;
      if (!(await this.holdsOnlyFetchedCommits(dir, env))) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message}\n\nConsola left the local branch ${branch.stdout.trim()} as it is: it has commits that were never pushed.`,
        );
      }
      await driver.checkout(dir, workItem, env, { resetBranch: true });
    }
  }

  /**
   * Whether every commit on HEAD is one this clone saw on a remote: on a
   * remote-tracking ref now, or somewhere HEAD's upstream pointed before a
   * force-push moved it (that ref's reflog). Any doubt answers no.
   */
  private async holdsOnlyFetchedCommits(dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const upstream = await this.git(dir, ['rev-parse', '--symbolic-full-name', '@{upstream}'], env);
    const formerHeads =
      upstream.code === 0
        ? (
            await this.git(dir, ['reflog', 'show', '--format=%H', upstream.stdout.trim()], env)
          ).stdout
            .split('\n')
            .filter(Boolean)
        : [];
    const unfetched = await this.git(
      dir,
      ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...new Set(formerHeads)],
      env,
    );
    return unfetched.code === 0 && Number(unfetched.stdout.trim()) === 0;
  }

  /**
   * Remove a work-item worktree — offered, never automatic.
   *
   * Refuses while the worktree holds uncommitted changes: pruning is cleanup,
   * and cleanup must never be the thing that loses work.
   */
  public async prune(worktreePath: string): Promise<void> {
    const status = await this.run(
      'git',
      worktreePath,
      ['status', '--porcelain', '--untracked-files=normal'],
      process.env,
    );
    if (status.trim()) {
      throw new Error(
        `Refusing to prune ${worktreePath}: it has uncommitted changes. Commit or discard them first.`,
      );
    }
    const commonDir = (
      await this.run(
        'git',
        worktreePath,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        process.env,
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
    return this.isDirectChildOfRoot(dir, realpathOrNull);
  }

  private isDirectChildOfRoot(dir: string, resolve: (target: string) => string | null): boolean {
    const root = resolve(this.root);
    const target = resolve(dir);
    return root !== null && target !== null && path.dirname(target) === root;
  }

  /**
   * The Consola worktree `dir` is, or lies inside, by real path: the
   * root's direct child on the way down to it. Null for anything outside
   * the root, the root itself, and a folder that does not exist.
   */
  public managedTreeOf(dir: string): string | null {
    const root = realpathOrNull(this.root);
    const target = realpathOrNull(dir);
    if (root === null || target === null) return null;
    const relative = path.relative(root, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return path.join(root, relative.split(path.sep)[0]);
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
      // Explicit: `status.showUntrackedFiles=no` would hide new files.
      this.git(toplevel, ['status', '--porcelain', '--untracked-files=normal']),
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
      dirtyFiles: status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : 0,
    };
  }

  /** Ignored files only this worktree has: see `worktreeCleanup/localFiles`. */
  public ignoredAtRisk(tree: string, mainRepo: string): Promise<AtRiskFiles> {
    return ignoredAtRisk((cwd, args) => this.git(cwd, args), tree, mainRepo);
  }

  /** Repositories nested below the tree's root. */
  public nestedRepos(tree: string): Promise<NestedRepos> {
    return nestedRepos(tree);
  }

  /**
   * Edits git hides from `status`: files marked skip-worktree (`S`) or
   * assume-unchanged (a lowercase tag) whose content no longer matches the
   * index. A sparse checkout's absent skip-worktree files lose nothing.
   */
  public async hiddenChanges(tree: string): Promise<HiddenChanges> {
    const listed = await this.git(tree, ['ls-files', '-v', '-z']);
    if (listed.code !== 0) return { kind: 'unknown' };
    const flagged = listed.stdout
      .split('\0')
      .filter((entry) => entry.length > 2)
      .filter((entry) => entry[0] === 'S' || /^[a-z]$/.test(entry[0]))
      .map((entry) => entry.slice(2))
      .filter((file) => fs.existsSync(path.join(tree, file)));
    if (flagged.length === 0) return { kind: 'none' };
    const [staged, hashed] = await Promise.all([
      this.git(tree, ['ls-files', '-s', '-z', '--', ...flagged]),
      this.git(tree, ['hash-object', '--', ...flagged]),
    ]);
    if (staged.code !== 0 || hashed.code !== 0) return { kind: 'unknown' };
    const indexed = new Map<string, string>();
    for (const entry of staged.stdout.split('\0').filter(Boolean)) {
      const [meta, file] = entry.split('\t');
      indexed.set(file, meta.split(' ')[1]);
    }
    const hashes = hashed.stdout.trim().split('\n');
    const changed = flagged.filter((file, index) => indexed.get(file) !== hashes[index]);
    return changed.length === 0 ? { kind: 'none' } : { kind: 'some', paths: changed };
  }

  /** Whether git has the worktree locked (`git worktree lock`). Null when it could not say. */
  public async isLocked(mainRepo: string, tree: string): Promise<boolean | null> {
    const listed = await this.git(mainRepo, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) return null;
    const target = realpathOrNull(tree) ?? path.resolve(tree);
    for (const record of listed.stdout.split('\n\n')) {
      const lines = record.split('\n');
      const location = lines.find((line) => line.startsWith('worktree '))?.slice(9);
      if (!location || (realpathOrNull(location) ?? path.resolve(location)) !== target) continue;
      return lines.some((line) => line === 'locked' || line.startsWith('locked '));
    }
    return null;
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
    env: NodeJS.ProcessEnv,
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
      const ancestor = await this.git(cwd, [
        'merge-base',
        '--is-ancestor',
        inspection.head,
        knownHead,
      ]);
      if (ancestor.code === 0) return 'published';
      return ancestor.code === 1 ? 'local-commits' : 'unverifiable';
    }
    const unpublished = await this.git(cwd, [
      'rev-list',
      '--count',
      inspection.head,
      '--not',
      '--remotes',
    ]);
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
    const removed = await this.git(
      inspection.mainRepo,
      // Git's own dirty check is the last guard: it must see untracked files
      // whatever the person's config says.
      ['-c', 'status.showUntrackedFiles=normal', 'worktree', 'remove', inspection.toplevel],
      withoutGitHooks(process.env),
    );
    if (removed.code !== 0) {
      throw new Error(
        removed.stderr.trim() || `git worktree remove ${inspection.toplevel} failed.`,
      );
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
    expectedHead: string,
  ): Promise<{ deleted: true } | { deleted: false; reason: string }> {
    if (PROTECTED_BRANCHES.has(branch)) return { deleted: false, reason: `${branch} is protected` };
    const defaultRef = await this.git(mainRepo, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    if (defaultRef.code === 0 && defaultRef.stdout.trim().replace(/^[^/]+\//, '') === branch) {
      return { deleted: false, reason: `${branch} is the default branch` };
    }
    const worktrees = await this.git(mainRepo, ['worktree', 'list', '--porcelain']);
    if (worktrees.code !== 0) return { deleted: false, reason: 'could not list worktrees' };
    if (worktrees.stdout.split('\n').includes(`branch refs/heads/${branch}`)) {
      return { deleted: false, reason: `${branch} is checked out in another worktree` };
    }
    const deleted = await this.git(mainRepo, [
      'update-ref',
      '-d',
      `refs/heads/${branch}`,
      expectedHead,
    ]);
    if (deleted.code !== 0) {
      return {
        deleted: false,
        reason: `${branch} no longer points at ${expectedHead.slice(0, 7)}`,
      };
    }
    // update-ref leaves the tracking config behind; harmless, so best-effort.
    await this.git(mainRepo, ['config', '--remove-section', `branch.${branch}`]);
    return { deleted: true };
  }

  /**
   * Point `ref` at `commit` in the clone, so the commit outlives a removed
   * worktree: a pull request's checkout may be detached, its branch reset by
   * a later checkout, and gc drops what nothing references.
   */
  public async writeKeepRef(mainRepo: string, ref: string, commit: string): Promise<void> {
    const written = await this.git(mainRepo, ['update-ref', ref, commit]);
    if (written.code !== 0) {
      throw new Error(written.stderr.trim() || `Could not write ${ref}.`);
    }
  }

  /**
   * Put a worktree a cleanup rule removed back at its path, on the commit it
   * was on — never at whatever its branch or pull request points at now.
   * Git hooks stay off: `worktree add` would otherwise run the checkout's
   * own `post-checkout`. The caller holds the folder's lock.
   *
   * A folder already there is left alone: it is reported when it is this
   * clone's worktree (a removal interrupted before git ran), refused when it
   * is anything else.
   */
  public async restore(removed: RemovedWorktree): Promise<RestoreResult> {
    const env = withoutGitHooks(process.env);
    const dir = removed.path;
    const short = removed.commit.slice(0, 7);
    if (fs.existsSync(dir)) {
      if (!fs.existsSync(path.join(dir, '.git'))) {
        throw new Error(`${dir} exists but is not a git worktree, so Consola left it alone.`);
      }
      const [actual, expected] = await Promise.all([
        this.git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        this.git(removed.mainRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      ]);
      if (
        actual.code !== 0 ||
        expected.code !== 0 ||
        actual.stdout.trim() !== expected.stdout.trim()
      ) {
        throw new Error(
          `${dir} exists but belongs to another repository, so Consola left it alone.`,
        );
      }
      const head = await this.git(dir, ['rev-parse', 'HEAD']);
      return { kind: 'existed', head: head.stdout.trim() };
    }

    if (!fs.existsSync(removed.mainRepo)) {
      throw new Error(`the repository it belonged to is gone (${removed.mainRepo}).`);
    }
    await this.git(removed.mainRepo, ['worktree', 'prune'], env);
    const present = await this.git(removed.mainRepo, [
      'cat-file',
      '-e',
      `${removed.commit}^{commit}`,
    ]);
    if (present.code !== 0) {
      throw new Error(`the commit it was on (${short}) is no longer in ${removed.mainRepo}.`);
    }
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    const added = await this.git(
      removed.mainRepo,
      ['worktree', 'add', '--detach', dir, removed.commit],
      env,
    );
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || `git worktree add ${dir} failed.`);
    }
    const head = await this.git(dir, ['rev-parse', 'HEAD']);
    if (head.stdout.trim() !== removed.commit) {
      throw new Error(`${dir} came back at ${head.stdout.trim().slice(0, 7)}, not ${short}.`);
    }

    // Back onto its branch only if the branch still points where the
    // worktree left it, and no other worktree has it checked out.
    let branch: string | null = null;
    if (removed.branch) {
      const [tip, listed] = await Promise.all([
        this.git(removed.mainRepo, ['rev-parse', '--verify', '-q', `refs/heads/${removed.branch}`]),
        this.git(removed.mainRepo, ['worktree', 'list', '--porcelain']),
      ]);
      const elsewhere = listed.stdout.split('\n').includes(`branch refs/heads/${removed.branch}`);
      if (tip.code === 0 && tip.stdout.trim() === removed.commit && !elsewhere) {
        const switched = await this.git(dir, ['switch', '--quiet', removed.branch], env);
        if (switched.code === 0) branch = removed.branch;
      }
    }
    return { kind: 'rebuilt', branch };
  }

  /** Best-effort: a keep-ref left behind costs one ref, never work. */
  public async deleteKeepRef(mainRepo: string, ref: string): Promise<void> {
    if (!ref.startsWith('refs/consola/')) return;
    await this.git(mainRepo, ['update-ref', '-d', ref]);
  }

  /** A git call whose exit code is an answer, not an error. */
  private async git(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
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
    env: NodeJS.ProcessEnv,
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
