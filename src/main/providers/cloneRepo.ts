import * as fs from 'fs';
import * as path from 'path';
import type { GitProviderId } from '../../shared/providers';
import type { CloneRepoResult } from '../../shared/types';
import type { Workspace } from '../../shared/workspace';
import { describeError } from './errors';
import type { GitProviderDriver } from './GitProviderDriver';

export interface CloneRepoDeps {
  /** getProviderDriver — throws on an unknown id, which becomes the clone error. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  /** Login env plus this account's token, under the driver's variable. Main-side only. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  /** WorkspaceService's scope-add. Fires onChange. */
  addScope(workspaceId: string, dirPath: string): void;
}

/**
 * Clone an un-cloned inbox repo into a chosen directory.
 *
 * The driver does the cloning as the workspace's account (its CLI reads the
 * token from the env it is handed), so private repos clone and Consola still
 * stores zero credentials. When the destination is not inside any existing
 * scope, it becomes one — otherwise resolveRepo would still answer null and
 * the launch could never continue.
 */
export async function cloneWorkspaceRepo(
  deps: CloneRepoDeps,
  workspace: Workspace,
  repo: string,
  destinationDir: string
): Promise<CloneRepoResult> {
  const provider = workspace.provider;
  if (!provider) {
    return { ok: false, error: 'This workspace has no provider account bound.' };
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
    const driver = deps.resolveDriver(provider.id);
    const env = await deps.composeEnv(driver, provider.accountLogin);
    await driver.cloneRepo(repo, target, env);
  } catch (error) {
    // The driver already surfaces its CLI's stderr as the message.
    return { ok: false, error: describeError(error) };
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
      return {
        ok: false,
        error: `Cloned to ${target}, but could not add ${destinationDir} as a scope: ${describeError(error)}`,
      };
    }
  }
  return { ok: true, path: target };
}
