import type { TerminalState } from '../stores/terminalStore';
import type { Workspace } from '../../shared/workspace';

/**
 * What a session's dot shows.
 *
 * Activity is inferred from terminal output, so the only states Consola can
 * distinguish are "the process is gone", "a menu is waiting on a keypress",
 * and "output is flowing".
 */
export type SessionStatus = 'error' | 'attention' | 'running' | null;

export function sessionStatusFor(terminal: TerminalState | undefined): SessionStatus {
  if (!terminal) return null;
  if (terminal.hasExited) return 'error';
  if (terminal.isAwaitingConfirmation) return 'attention';
  if (terminal.isBusy) return 'running';
  return null;
}

const RANK: Record<Exclude<SessionStatus, null>, number> = {
  error: 3,
  attention: 2,
  running: 1,
};

/** The most urgent status among a workspace's sessions. */
export function workspaceStatusFor(
  workspace: Workspace,
  terminals: Record<string, TerminalState>
): SessionStatus {
  let worst: SessionStatus = null;

  for (const session of workspace.sessions) {
    const status = sessionStatusFor(terminals[session.instanceId]);
    if (status && (!worst || RANK[status] > RANK[worst])) {
      worst = status;
    }
  }

  return worst;
}

/**
 * Whether a workspace this window is not showing wants a human.
 *
 * Deliberately excludes `running`: a session doing work is not a reason to
 * pull someone out of another project. Only a waiting menu or a dead process
 * is.
 */
export function anyOtherWorkspaceNeedsAttention(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  terminals: Record<string, TerminalState>
): boolean {
  return workspaces.some((workspace) => {
    if (workspace.id === activeWorkspaceId) return false;
    const status = workspaceStatusFor(workspace, terminals);
    return status === 'attention' || status === 'error';
  });
}
