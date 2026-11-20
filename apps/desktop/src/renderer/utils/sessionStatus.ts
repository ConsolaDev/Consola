import { isParked, worstStatus, type Attention } from '../../shared/attention';
import type { Workspace } from '../../shared/workspace';

/**
 * Folds over attention main has already derived, by session id. Nothing here
 * turns raw terminal flags into a status: that is `deriveAttention`, in main,
 * and the renderer must never grow a second copy of it.
 */
export type AttentionMap = Record<string /* sessionId */, Attention>;

/** The most urgent attention among a workspace's sessions; `ready` when it has none that count. */
export function workspaceStatusFor(workspace: Workspace, attention: AttentionMap): Attention {
  // Put away, for good or until a time, asks nothing of anyone, so it never colours a workspace.
  const live = workspace.sessions
    .map((session) => attention[session.id] ?? 'ready')
    .filter((status) => !isParked(status));
  return worstStatus(live) ?? 'ready';
}

/**
 * Whether a workspace this window is not showing wants a human.
 *
 * Deliberately excludes `working` and `done`: a session doing work — or one
 * that finished and is merely waiting to be looked at — is not a reason to
 * pull someone out of another project. Only a waiting menu or a dead process
 * is. Tested by name, not by rank: `exited` ranks near the bottom, but a dead
 * process is still worth knowing about, so do not "simplify" this to a rank.
 */
export function anyOtherWorkspaceNeedsAttention(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  attention: AttentionMap,
): boolean {
  return workspaces.some((workspace) => {
    if (workspace.id === activeWorkspaceId) return false;
    // Not `worstStatus`: `exited` is outranked by `working` and `ready`, so a
    // workspace with a dead session and a busy one would report neither.
    return workspace.sessions.some((session) => {
      const status = attention[session.id];
      return status === 'needs-attention' || status === 'exited';
    });
  });
}
