import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { CloneRepoResult } from '../../shared/types';
import type { Workspace } from '../../shared/workspace';

const execFileAsync = promisify(execFile);

export interface CloneRepoDeps {
  ghBinary(): Promise<string>;
  /** Login env plus GH_TOKEN for the workspace's account. Main-side only. */
  composeEnv(accountLogin: string): Promise<NodeJS.ProcessEnv>;
  /** WorkspaceService's scope-add (Phase 0 scope CRUD). Fires onChange. */
  addScope(workspaceId: string, dirPath: string): void;
}

/**
 * Clone an un-cloned inbox repo into a chosen directory.
 *
 * `gh repo clone` rather than bare `git clone`: gh authenticates from GH_TOKEN
 * in the subprocess env, so private repos clone as the workspace's account and
 * Consola still stores zero credentials. When the destination is not inside
 * any existing scope, it becomes one — otherwise resolveRepo would still
 * answer null and the launch could never continue.
 */
export async function cloneWorkspaceRepo(
  deps: CloneRepoDeps,
  workspace: Workspace,
  repo: string,
  destinationDir: string
): Promise<CloneRepoResult> {
  if (!workspace.github) {
    return { ok: false, error: 'This workspace has no GitHub account bound.' };
  }
  if (!fs.existsSync(destinationDir)) {
    return { ok: false, error: `Destination not found: ${destinationDir}` };
  }
  const name = repo.split('/').pop() ?? repo;
  const target = path.join(destinationDir, name);
  if (fs.existsSync(target)) {
    return { ok: false, error: `${target} already exists.` };
  }

  try {
    const env = await deps.composeEnv(workspace.github.accountLogin);
    await execFileAsync(await deps.ghBinary(), ['repo', 'clone', repo, target], {
      env: env as { [key: string]: string },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    return {
      ok: false,
      error: stderr || (error instanceof Error ? error.message : String(error)),
    };
  }

  const covered = workspace.scopes.some(
    (scope) => target === scope.path || target.startsWith(scope.path + path.sep)
  );
  if (!covered) {
    try {
      deps.addScope(workspace.id, destinationDir);
    } catch (error) {
      // The clone already landed on disk; a scope-add failure (e.g. an
      // unknown workspace id) must not be reported as if nothing happened.
      // Name the path so the user can find and register it by hand.
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Cloned to ${target}, but could not add ${destinationDir} as a scope: ${message}`,
      };
    }
  }
  return { ok: true, path: target };
}
