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
}
