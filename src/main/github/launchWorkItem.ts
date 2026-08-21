import * as path from 'path';
import type { InboxItem, WorkItemRef } from '../../shared/github';
import { sameWorkItem } from '../../shared/github';
import type { WorkItemLaunchResult } from '../../shared/types';
import type { NewSessionFields, Session, Workspace } from '../../shared/workspace';

export interface WorkItemLaunchDeps {
  getWorkspace(id: string): Workspace | undefined;
  createSession(workspaceId: string, fields: NewSessionFields): Session | undefined;
  resolveRepo(workspace: Workspace, repo: string): string | null;
  ensureWorktree(
    clonePath: string,
    workItem: WorkItemRef,
    env: NodeJS.ProcessEnv
  ): Promise<string>;
  /** Login env plus GH_TOKEN for this account. Composed main-side only. */
  composeEnv(accountLogin: string): Promise<NodeJS.ProcessEnv>;
  findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined;
}

/** Same shape as the renderer's generateSessionInstanceId — one id namespace. */
function generateInstanceId(workspaceId: string): string {
  const suffix = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  return `workspace-${workspaceId}-session-${suffix}`;
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

/** Sidebar name for a work-item session, titled when the inbox knows the title. */
export function workItemSessionName(workItem: WorkItemRef, item?: InboxItem): string {
  const label = workItem.type === 'pr' ? `PR #${workItem.number}` : `Issue #${workItem.number}`;
  return item ? `${label} - ${item.title}` : label;
}

/**
 * The prompt seeded into the fresh session.
 *
 * Delivered through the existing guarded queue (TerminalService.queuePrompt via
 * TerminalCreateOptions.initialPrompt), so it can never answer a trust gate or
 * permission menu. It tells the agent where it is and to read the item with gh
 * first — the token in its env makes that work as the workspace's account.
 */
export function buildSeedPrompt(workItem: WorkItemRef, item?: InboxItem): string {
  const noun = workItem.type === 'pr' ? 'pull request' : 'issue';
  const ghNoun = workItem.type === 'pr' ? 'pr' : 'issue';
  const title = item ? ` ("${item.title}")` : '';
  const task =
    workItem.type === 'pr'
      ? 'review the changes and summarise your findings before writing any review comments'
      : 'investigate it and propose a plan before changing anything';
  return (
    `This session is for ${noun} #${workItem.number}${title} in ${workItem.repo}. ` +
    `You are in a dedicated git worktree for it, so the user's own checkout stays untouched. ` +
    `Start with \`gh ${ghNoun} view ${workItem.number}\` to read it, then ${task}.`
  );
}

/**
 * One click on an Inbox item: resolve -> worktree -> record.
 *
 * Atomic in that order — the worktree exists before the record does, and the
 * record exists before any PTY spawns (the spawn happens when the session pane
 * mounts, exactly like every hand-made session). On any failure nothing is
 * created and the message is surfaced on the Inbox item.
 *
 * Re-attach: one work item, one session, forever. A second click returns the
 * existing session rather than minting a rival.
 */
export async function launchWorkItem(
  deps: WorkItemLaunchDeps,
  workspaceId: string,
  workItem: WorkItemRef
): Promise<WorkItemLaunchResult> {
  const workspace = deps.getWorkspace(workspaceId);
  if (!workspace) {
    return { ok: false, reason: 'error', message: `Unknown workspace: ${workspaceId}` };
  }
  if (!workspace.github) {
    return { ok: false, reason: 'error', message: 'This workspace has no GitHub account bound.' };
  }

  const existing = workspace.sessions.find((session) =>
    sameWorkItem(session.workItem, workItem)
  );
  if (existing) return { ok: true, session: existing, reattached: true };

  const clonePath = deps.resolveRepo(workspace, workItem.repo);
  if (!clonePath) return { ok: false, reason: 'not-cloned' };

  let worktreePath: string;
  try {
    const env = await deps.composeEnv(workspace.github.accountLogin);
    worktreePath = await deps.ensureWorktree(clonePath, workItem, env);
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const item = deps.findItem(workspaceId, workItem);
  const session = deps.createSession(workspaceId, {
    name: workItemSessionName(workItem, item),
    workspaceId,
    instanceId: generateInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
    scopeId: scopeIdForPath(workspace, clonePath),
    cwd: worktreePath,
    kind: 'interactive',
    workItem,
  });
  if (!session) {
    return { ok: false, reason: 'error', message: 'Could not create the session record.' };
  }
  return { ok: true, session, seedPrompt: buildSeedPrompt(workItem, item), reattached: false };
}
