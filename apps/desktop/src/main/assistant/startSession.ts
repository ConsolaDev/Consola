import * as path from 'path';
import type { Session, Workspace } from '../../shared/workspace';
import { assistantItemMode, generateSessionInstanceId } from '../../shared/workspace';
import { isValidWorkItemRef } from '../../shared/workItems';
import { prepareItemWorktree, type ItemWorktreeDeps } from '../automations/launchAgentRun';
import { readyGroup } from '../providers/launchWorkItem';
import type { LaunchSessionFields } from '../SessionLauncher';

export interface AssistantStartRequest {
  name: string;
  prompt: string;
  workItem?: { repo: string; number: number; type: 'pr' | 'issue' };
  scopePath?: string;
  cwd?: string;
  group?: string;
  readOnly?: boolean;
}

export type AssistantSessionMode = 'full-tools' | 'read-only';

export interface AssistantStartDeps extends ItemWorktreeDeps {
  restoreGroup(workspaceId: string, groupId: string): void;
  launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session>;
}

/**
 * Whether an item session is restricted: the workspace decides, and the
 * Assistant's own `readOnly` counts only where the workspace lets it pick.
 */
function itemMode(workspace: Workspace, readOnly: boolean | undefined): AssistantSessionMode {
  const mode = assistantItemMode(workspace);
  if (mode === 'read-only') return 'read-only';
  if (mode === 'assistant-picks' && readOnly === true) return 'read-only';
  return 'full-tools';
}

/**
 * Start a session for the Assistant, wholly inside its workspace. A work item
 * runs in its Consola worktree, made through the path the Inbox and
 * automations use, so the Assistant never runs git; anything else runs in one
 * of the workspace's scope folders. Every argument is checked before the
 * worktree or the record exists, so a refused argument leaves nothing behind.
 * A launcher refusal (read-only on a harness that cannot enforce it) comes
 * later and can leave a prepared worktree and a restored group.
 */
export async function startAssistantSession(
  deps: AssistantStartDeps,
  workspace: Workspace,
  request: AssistantStartRequest
): Promise<{ session: Session; mode: AssistantSessionMode }> {
  let groupId: string | undefined;
  if (request.group !== undefined) {
    const wanted = request.group;
    const group = workspace.groups.find(
      (candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase()
    );
    if (!group) throw new Error(`No group "${wanted}" in this workspace.`);
    groupId = group.id;
  }

  let workItem: Session['workItem'];
  let scopePlace: { scopeId: string; cwd?: string } | undefined;
  if (request.workItem) {
    if (request.scopePath !== undefined || request.cwd !== undefined) {
      throw new Error('A work item runs in its own worktree; leave out scope_path and cwd.');
    }
    if (!workspace.provider) throw new Error('This workspace has no provider account bound.');
    const ref = { provider: workspace.provider.id, ...request.workItem };
    if (!isValidWorkItemRef(ref)) {
      throw new Error(`Not a valid pull request or issue: ${request.workItem.repo}#${request.workItem.number}.`);
    }
    workItem = ref;
  } else {
    const scope =
      request.scopePath === undefined
        ? workspace.scopes[0]
        : workspace.scopes.find((candidate) => path.resolve(candidate.path) === path.resolve(request.scopePath!));
    if (!scope) {
      throw new Error(
        request.scopePath === undefined
          ? 'Add a scope to this workspace first.'
          : `${request.scopePath} is not one of this workspace’s folders.`
      );
    }
    if (request.cwd !== undefined) {
      const relative = path.relative(path.resolve(scope.path), path.resolve(request.cwd));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`cwd must be inside ${scope.path}.`);
      }
    }
    scopePlace = { scopeId: scope.id, ...(request.cwd !== undefined ? { cwd: request.cwd } : {}) };
  }

  const mode: AssistantSessionMode = workItem ? itemMode(workspace, request.readOnly) : 'full-tools';
  // Only a read-only session may have its worktree moved to the latest head:
  // a full-tools one would load newly pushed settings in a folder already trusted.
  const place = workItem
    ? await prepareItemWorktree(deps, workspace, workItem, { refreshExisting: mode === 'read-only' })
    : scopePlace!;
  // Readied last: restoring an archived group is a write a refusal must not leave.
  const readiedGroup = readyGroup(deps, workspace, groupId);

  const session = await deps.launchSession(workspace.id, {
    name: request.name,
    nameIsUserSet: true,
    workspaceId: workspace.id,
    instanceId: generateSessionInstanceId(workspace.id),
    harnessId: workspace.defaultHarnessId,
    kind: 'interactive',
    scopeId: place.scopeId,
    ...('cwd' in place && place.cwd !== undefined ? { cwd: place.cwd } : {}),
    ...(readiedGroup !== undefined ? { groupId: readiedGroup } : {}),
    ...(workItem ? { workItem } : {}),
    // Read-only runs the way an automation review does: the prompt is an
    // argument and the first turn is unattended. The launcher refuses a
    // harness that cannot enforce it, and that error is the caller's.
    ...(mode === 'read-only' ? { toolPolicy: 'read-only' as const, unattended: true } : {}),
    initialPrompt: request.prompt,
  });
  return { session, mode };
}
