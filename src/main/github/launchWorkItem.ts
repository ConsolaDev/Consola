import * as path from 'path';
import type { InboxItem, WorkItemRef } from '../../shared/github';
import { sameWorkItem, workItemKey } from '../../shared/github';
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
  /** Whether a path exists on disk — used to notice a re-attach whose worktree was deleted. */
  pathExists(target: string): boolean;
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
  if (existing) {
    // A present cwd stays on the fast path untouched — no subprocess on the
    // common re-attach. Only a *missing* cwd (the worktree directory was
    // deleted out from under the session) re-ensures it before handing the
    // session back, so TerminalService never has to reject the spawn with
    // "Working folder not found" for a directory ensureWorktree can just
    // recreate.
    if (existing.cwd && !deps.pathExists(existing.cwd)) {
      const clonePath = deps.resolveRepo(workspace, workItem.repo);
      if (clonePath) {
        try {
          const env = await deps.composeEnv(workspace.github.accountLogin);
          await deps.ensureWorktree(clonePath, workItem, env);
        } catch (error) {
          return {
            ok: false,
            reason: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      // clonePath === null means the clone itself is gone too — there is
      // nothing to rebuild from, so fall through to the honest re-attach
      // below; the user gets today's terminal notice rather than a launch
      // failure for a problem this call cannot fix.
    }
    return { ok: true, session: existing, reattached: true };
  }

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

/**
 * Coalesces concurrent launches of the *same* work item into one in-flight
 * call — the same in-flight-Map pattern `GitHubService.refresh` already uses
 * for concurrent inbox refreshes of one workspace.
 *
 * Not reachable through the UI today (the renderer's `launching[key]` disables
 * the button, and one workspace belongs to one window), but two overlapping
 * calls would each pass the "existing session" check before either created
 * one, minting two sessions for one work item and violating "one work item,
 * one session, forever." It would also let two concurrent `ensureWorktree`
 * calls for the same item race — one call's failure cleanup removing a
 * worktree directory the other just fast-pathed onto. Keyed by workspace id
 * plus work-item key, so concurrent launches of *different* items still run
 * in parallel.
 */
export function createLaunchCoalescer(
  deps: WorkItemLaunchDeps
): (workspaceId: string, workItem: WorkItemRef) => Promise<WorkItemLaunchResult> {
  const inFlight = new Map<string, Promise<WorkItemLaunchResult>>();
  return (workspaceId, workItem) => {
    const key = `${workspaceId}:${workItemKey(workItem)}`;
    const running = inFlight.get(key);
    if (running) return running;
    const job = launchWorkItem(deps, workspaceId, workItem).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  };
}
