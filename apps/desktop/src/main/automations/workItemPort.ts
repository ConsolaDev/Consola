import type { ItemRef, WorkItemPort } from '@consola/automation-engine';
import type { Workspace } from '../../shared/workspace';
import { workItemKey, workItemUrl } from '../../shared/workItems';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import { toWorkItemRef } from './engineViews';

export interface WorkItemPortDeps {
  getWorkspace(id: string): Workspace | undefined;
  /** WorktreeService.resolveRepo: the scope folder holding a clone of `repo`, or null. */
  resolveRepo(workspace: Workspace, repo: string): string | null;
  /** getProviderDriver, null for an unknown id. */
  driverFor(connection: string): GitProviderDriver | null;
}

/** The engine's work item identity, answered by the desktop's providers and workspaces. */
export function desktopWorkItemPort(deps: WorkItemPortDeps): WorkItemPort {
  return {
    canParseUrls: (connection) =>
      typeof deps.driverFor(connection)?.parseWorkItemUrl === 'function',
    parseUrl: (connection, url): ItemRef | null => {
      const parsed = deps.driverFor(connection)?.parseWorkItemUrl?.(url);
      return parsed
        ? { provider: parsed.provider, repo: parsed.repo, type: parsed.type, number: parsed.number }
        : null;
    },
    keyOf: (ref) => workItemKey(toWorkItemRef(ref)),
    urlOf: (ref) => workItemUrl(toWorkItemRef(ref)),
    inWorkspace: (workspaceId, ref) => {
      const workspace = deps.getWorkspace(workspaceId);
      if (!workspace || workspace.provider?.id !== ref.provider) return false;
      return deps.resolveRepo(workspace, ref.repo) !== null;
    },
    // A run's own checkout is made from the workspace's clone of its repository (slice 3-B).
    repoCloned: (workspaceId, repo) => {
      const workspace = deps.getWorkspace(workspaceId);
      return workspace !== undefined && deps.resolveRepo(workspace, repo) !== null;
    },
  };
}
