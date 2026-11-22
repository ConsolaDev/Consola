import type { Session } from '../../shared/workspace';
import { useNavigationStore } from '../stores/navigationStore';
import { useTerminalStore } from '../stores/terminalStore';

/**
 * Drop everything this window keeps about a session that no longer exists:
 * its terminal state and — if it was on screen — the active selection.
 * Idempotent, and never touches main: the PTY is main's, and so is the
 * session's shell, which main destroys with the session.
 */
export function forgetSessionLocally(session: Pick<Session, 'id' | 'instanceId'>): void {
  useTerminalStore.getState().removeInstance(session.instanceId);
  if (useNavigationStore.getState().activeSessionId === session.id) {
    useNavigationStore.getState().setActiveSession(null);
  }
}
