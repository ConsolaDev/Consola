import type { Session } from '../../shared/workspace';
import { useNavigationStore } from '../stores/navigationStore';
import { useShellStore } from '../stores/shellStore';
import { useTerminalStore } from '../stores/terminalStore';

/**
 * Drop everything this window keeps about a session that no longer exists:
 * its shell toggle, its terminal state, and — if it was on screen — the
 * active selection. Idempotent, and never touches main: the PTY is main's.
 */
export function forgetSessionLocally(session: Pick<Session, 'id' | 'instanceId'>): void {
    useShellStore.getState().remove(session.instanceId);
    useTerminalStore.getState().removeInstance(session.instanceId);
    if (useNavigationStore.getState().activeSessionId === session.id) {
        useNavigationStore.getState().setActiveSession(null);
    }
}
