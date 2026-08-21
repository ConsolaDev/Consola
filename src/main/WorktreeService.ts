import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { WorkItemRef } from '../shared/github';
import type { Workspace } from '../shared/workspace';

const execFileAsync = promisify(execFile);

/**
 * `owner/repo` (lowercased) from a git remote URL, or null.
 *
 * Lowercased on both sides of every comparison because GitHub treats repo
 * names case-insensitively while remembering the display casing — a clone made
 * from a differently-cased URL must still resolve.
 */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  if (!trimmed) return null;
  // scp-style: git@github.com:owner/repo
  const scp = trimmed.match(/^[^@\s/]+@[^:\s]+:(.+)$/);
  // url-style: https://github.com/owner/repo or ssh://git@github.com/owner/repo
  const web = trimmed.match(/^\w+:\/\/[^/]+\/(.+)$/);
  const repoPath = (scp?.[1] ?? web?.[1])?.replace(/^\/+/, '');
  if (!repoPath) return null;
  const parts = repoPath.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
}

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
 * remote; a container scope scans its direct children. Remote lookups are
 * cached per directory and invalidated when scopes change (wired to
 * WorkspaceService.onChange) — a `git remote get-url` per directory per scan
 * would otherwise run on every Inbox paint.
 */
export class WorktreeService {
  /** Directory -> normalized origin remote (or null for non-repos). */
  private readonly remoteCache = new Map<string, string | null>();

  constructor(
    private readonly root: string = process.env.CONSOLA_WORKTREES_DIR ??
      path.join(os.homedir(), '.consola', 'worktrees'),
    private readonly ghBinary: () => Promise<string> = async () =>
      process.env.CONSOLA_GH_PATH ?? 'gh'
  ) {}

  public invalidate(): void {
    this.remoteCache.clear();
  }

  /** Local clone for a remote repo, found through the workspace's scopes. */
  public resolveRepo(workspace: Workspace, repo: string): string | null {
    const target = repo.toLowerCase();
    for (const scope of workspace.scopes) {
      if (this.originOf(scope.path) === target) return scope.path;
      if (!scope.isGitRepo) {
        for (const child of this.childDirs(scope.path)) {
          if (this.originOf(child) === target) return child;
        }
      }
    }
    return null;
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
      const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      origin = normalizeRemote(url);
    } catch {
      origin = null; // Not a repo, or no origin — either way, not a match.
    }
    this.remoteCache.set(dir, origin);
    return origin;
  }

  /**
   * The worktree for a work item, creating or recreating it as needed.
   *
   * Idempotent by design: resuming a session whose worktree was deleted lands
   * here again before the PTY spawns, and the checkout must simply happen
   * again. A linked worktree keeps a `.git` *file* pointing at the clone, so
   * its presence is the "already exists" signal.
   *
   * PRs: `git worktree add --detach` then `gh pr checkout <n>` inside it —
   * gh owns the branch naming and the fetch, with GH_TOKEN in `env`.
   * Issues: a `consola/issue-<n>` branch, created on first use, reused after.
   */
  public async ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string> {
    const dir = path.join(this.root, worktreeDirName(workItem));
    if (fs.existsSync(path.join(dir, '.git'))) return dir;

    await fs.promises.mkdir(this.root, { recursive: true });
    // A worktree whose directory was deleted stays registered and would make
    // `worktree add` refuse; prune drops stale registrations only.
    await this.run('git', clonePath, ['worktree', 'prune'], env);

    if (workItem.type === 'pr') {
      await this.run('git', clonePath, ['worktree', 'add', '--detach', dir], env);
      await this.run(await this.ghBinary(), dir, ['pr', 'checkout', String(workItem.number)], env);
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
    }
    return dir;
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
