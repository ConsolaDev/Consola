import type { TerminalState } from '../stores/terminalStore';
import type { Workspace } from '../../shared/workspace';

/**
 * What a session's dot shows — the status vocabulary from the GitHub workflow
 * design (2026-08-20), derived here in the renderer from the flags terminals
 * already emit rather than a promoted main-process event.
 *
 * Activity is inferred from terminal output, so the states Consola can
 * distinguish are "the process is gone", "a menu is waiting on a keypress",
 * "output is flowing", and — tracked renderer-side — "it finished while you
 * were elsewhere". Everything else is `ready`, including the second or so a
 * session spends booting.
 */
export type SessionStatus = 'exited' | 'needs-attention' | 'done' | 'working' | 'ready';

export function sessionStatusFor(terminal: TerminalState | undefined): SessionStatus {
  if (!terminal) return 'ready';
  if (terminal.hasExited) return 'exited';
  if (terminal.isAwaitingConfirmation) return 'needs-attention';
  if (terminal.isBusy) return 'working';
  if (terminal.completedWhileAway) return 'done';
  return 'ready';
}

// `done` outranks `working` at the workspace level: a finished session is
// actionable (there is a result to look at) while one still working is not.
const RANK: Record<SessionStatus, number> = {
  exited: 4,
  'needs-attention': 3,
  done: 2,
  working: 1,
  ready: 0,
};

/**
 * The most urgent status in a set. Extracted so the Inbox row's "N sessions"
 * dot and the workspace switcher's dot share one rule -- two rollups that
 * disagreed about whether done outranks working would be a bug nobody
 * could name.
 */
export function worstStatus(statuses: SessionStatus[]): SessionStatus {
  let worst: SessionStatus = 'ready';
  for (const status of statuses) {
    if (RANK[status] > RANK[worst]) {
      worst = status;
    }
  }
  return worst;
}

/** The most urgent status among a workspace's sessions. */
export function workspaceStatusFor(
  workspace: Workspace,
  terminals: Record<string, TerminalState>
): SessionStatus {
  return worstStatus(
    workspace.sessions.map((session) => sessionStatusFor(terminals[session.instanceId]))
  );
}

/**
 * Whether a workspace this window is not showing wants a human.
 *
 * Deliberately excludes `working` and `done`: a session doing work — or one
 * that finished and is merely waiting to be looked at — is not a reason to
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
    return status === 'needs-attention' || status === 'exited';
  });
}
