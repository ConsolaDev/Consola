import * as path from 'path';
import type { GitProviderId } from '../../shared/providers';
import type { InboxItem, WorkItemLaunchAction, WorkItemRef } from '../../shared/workItems';
import { isValidWorkItemRef, workItemActionKey, workItemKey } from '../../shared/workItems';
import { fallbackWorkItemTitle, renderActionPrompt } from '../../shared/workItemPrompt';
import type { WorkItemLaunchResult } from '../../shared/types';
import { generateSessionInstanceId } from '../../shared/workspace';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';
import { describeError } from './errors';
import type { GitProviderDriver } from './GitProviderDriver';

export interface WorkItemLaunchDeps {
  getWorkspace(id: string): Workspace | undefined;
  /** The driver for the workspace's bound provider; throws on an unknown id. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
  resolveRepo(workspace: Workspace, repo: string): string | null;
  ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string>;
  /** Login env plus the provider's token var for this account. Composed main-side only. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
}

/** The deepest scope whose path contains the clone — its home in the sidebar. */
function scopeIdForPath(workspace: Workspace, clonePath: string): string {
  let best: Workspace['scopes'][number] | undefined;
  for (const scope of workspace.scopes) {
    const matches = clonePath === scope.path || clonePath.startsWith(scope.path + path.sep);
    if (matches && (!best || scope.path.length > best.path.length)) best = scope;
  }
  return (best ?? workspace.scopes[0]).id;
}

/**
 * The action's name snapshot and raw body. A stored action is looked up by
 * id; a custom prompt is named 'Custom prompt' so the sidebar and strip
 * still have a label, and its body is never persisted anywhere.
 */
function resolveAction(
  workspace: Workspace,
  action: WorkItemLaunchAction
): { name: string; body: string } | undefined {
  if ('customPrompt' in action) return { name: 'Custom prompt', body: action.customPrompt };
  const stored = workspace.actions.find((candidate) => candidate.id === action.id);
  return stored ? { name: stored.name, body: stored.prompt } : undefined;
}

/**
 * Start a session from an action: validate -> render -> resolve -> worktree
 * -> record.
 *
 * Everything that can be refused cheaply (workspace, binding, ref, action,
 * an empty rendered body) is refused before any subprocess runs. The
 * worktree exists before the record does, and the record exists before any
 * PTY spawns (the spawn happens when the session pane mounts, exactly like
 * every hand-made session). On any failure nothing is created.
 *
 * Always a new session. Several sessions on one item share its worktree —
 * ensureWorktree is idempotent and keyed by item — and re-attaching is an
 * explicit "Open" in the renderer, never a side effect here.
 */
export async function launchWorkItem(
  deps: WorkItemLaunchDeps,
  workspaceId: string,
  ref: WorkItemRef,
  action: WorkItemLaunchAction
): Promise<WorkItemLaunchResult> {
  const workspace = deps.getWorkspace(workspaceId);
  if (!workspace) {
    return { ok: false, reason: 'error', message: `Unknown workspace: ${workspaceId}` };
  }
  if (!workspace.provider) {
    return { ok: false, reason: 'error', message: 'This workspace has no provider account bound.' };
  }
  if (!isValidWorkItemRef(ref)) {
    return { ok: false, reason: 'error', message: 'Invalid work item reference.' };
  }

  const resolved = resolveAction(workspace, action);
  if (!resolved) return { ok: false, reason: 'error', message: 'Unknown action.' };

  let driver: GitProviderDriver;
  try {
    driver = deps.resolveDriver(workspace.provider.id);
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  const item = deps.findItem(workspaceId, ref);
  const prompt = renderActionPrompt(driver.seedHeader(ref, item), resolved.body, ref, item);
  if (!prompt.ok) return { ok: false, reason: 'error', message: prompt.message };

  const clonePath = deps.resolveRepo(workspace, ref.repo);
  if (!clonePath) return { ok: false, reason: 'not-cloned' };

  let worktreePath: string;
  try {
    const env = await deps.composeEnv(driver, workspace.provider.accountLogin);
    worktreePath = await deps.ensureWorktree(clonePath, ref, env);
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  const session = deps.createSession(workspaceId, {
    name: item?.title ?? fallbackWorkItemTitle(ref),
    workspaceId,
    instanceId: generateSessionInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
    scopeId: scopeIdForPath(workspace, clonePath),
    cwd: worktreePath,
    kind: 'interactive',
    workItem: ref,
    workItemAction: resolved.name,
  });
  if (!session) {
    return { ok: false, reason: 'error', message: 'Could not create the session record.' };
  }
  return { ok: true, session, seedPrompt: prompt.seedPrompt };
}

/**
 * Coalesces concurrent launches of the same item *and action* into one
 * in-flight call — the same in-flight-Map pattern InboxService.refresh uses
 * for concurrent refreshes of one workspace.
 *
 * Keyed by item plus action (custom prompts by item plus trimmed body): a
 * double-click on one button still mints one session, while two different
 * actions started back to back on the same item each get their own. It also
 * keeps two concurrent ensureWorktree calls for one item from racing — one
 * call's failure cleanup removing a worktree the other just fast-pathed onto.
 */
export function createLaunchCoalescer(
  deps: WorkItemLaunchDeps
): (
  workspaceId: string,
  ref: WorkItemRef,
  action: WorkItemLaunchAction
) => Promise<WorkItemLaunchResult> {
  const inFlight = new Map<string, Promise<WorkItemLaunchResult>>();
  return (workspaceId, ref, action) => {
    const key = `${workspaceId}:${workItemKey(ref)}:${workItemActionKey(action)}`;
    const running = inFlight.get(key);
    if (running) return running;
    const job = launchWorkItem(deps, workspaceId, ref, action).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };
}
