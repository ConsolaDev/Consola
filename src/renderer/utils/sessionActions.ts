import { useNavigationStore } from '../stores/navigationStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useWorkspaceStore, type Session } from '../stores/workspaceStore';
import { terminalBridge } from '../services/terminalBridge';
import { windowBridge } from '../services/windowBridge';
import { primaryScope } from '../../shared/workspace';

/**
 * Session operations that span more than one store.
 *
 * These sequences have to happen in a particular order, and every caller has
 * to perform all of them — a partial teardown leaks a PTY, and a partial
 * creation lands on the wrong screen. Keeping them here means the sidebar and
 * the command palette cannot drift on what "delete a session" involves.
 */

/** Terminal instance id for a new session in a workspace. */
export function generateSessionInstanceId(workspaceId: string): string {
  const sessionId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  return `workspace-${workspaceId}-session-${sessionId}`;
}

/**
 * Select a session within the workspace this window already holds.
 *
 * Written as a single `setState` rather than `setActiveWorkspace` followed by
 * `setActiveSession`, because `setActiveWorkspace` clears `activeSessionId` as
 * a side effect — doing it in two calls selects the session and then
 * immediately deselects it.
 *
 * Deliberately does not go through main: callers here are the sidebar and
 * other places that only ever name a session in the workspace already on
 * screen. A caller that cannot make that guarantee — a session picker showing
 * results from every workspace, for instance — needs `activateSessionAnywhere`
 * instead, or it can silently attach this window to a workspace another
 * window already holds.
 */
export function activateSession(workspaceId: string, sessionId: string): void {
  useNavigationStore.setState({
    activeWorkspaceId: workspaceId,
    activeSessionId: sessionId,
  });
  windowBridge.setActiveSession(sessionId);
}

/**
 * Select a session that may belong to another workspace.
 *
 * Goes through main whenever the workspace is not this window's, because that
 * workspace may already be open somewhere else — in which case the right
 * outcome is bringing that window forward, not opening a second view of a PTY
 * that only expects one.
 */
export async function activateSessionAnywhere(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  if (useNavigationStore.getState().activeWorkspaceId === workspaceId) {
    activateSession(workspaceId, sessionId);
    return;
  }

  const verdict = await windowBridge.activateWorkspace(workspaceId);
  if (verdict === 'took') {
    activateSession(workspaceId, sessionId);
  }
}

/**
 * Create a session in a scope with the workspace's default harness, and open it.
 *
 * The quick path used by the sidebar's `+`. With no scope named it lands in
 * the primary scope — which is exactly where every session landed before
 * scopes existed. Choosing a harness or starting with a prompt happens on the
 * new-session screen instead.
 */
export async function createQuickSession(
  workspaceId: string,
  scopeId?: string
): Promise<Session | undefined> {
  const workspace = useWorkspaceStore.getState().getWorkspace(workspaceId);
  if (!workspace) return undefined;

  const scope =
    (scopeId
      ? workspace.scopes.find((candidate) => candidate.id === scopeId)
      : undefined) ?? primaryScope(workspace);
  if (!scope) return undefined;

  const session = await useWorkspaceStore.getState().createSession(workspaceId, {
    name: 'New Session',
    workspaceId,
    instanceId: generateSessionInstanceId(workspaceId),
    harnessId: workspace.defaultHarnessId,
    scopeId: scope.id,
  });

  if (session) {
    activateSession(workspaceId, session.id);
  }
  return session;
}

/**
 * Open the new-session composer for a workspace.
 *
 * No session exists until a prompt is submitted, so backing out of the
 * composer leaves nothing behind — which is why the palette starts sessions
 * this way rather than by creating one up front.
 */
export function openNewSessionComposer(workspaceId: string): Promise<void> {
  return useNavigationStore.getState().setActiveWorkspace(workspaceId);
}

/**
 * Close a session: kill its terminal, forget its state, drop the record.
 *
 * Closing is what kills the PTY; unmounting a pane does not. The conversation
 * itself stays in the harness's own session files and is still reachable with
 * `claude --resume`.
 */
export async function deleteSessionCompletely(
  workspaceId: string,
  session: Session
): Promise<void> {
  // The record goes first because it is the only step that can fail. Killing
  // the PTY is a one-way send that cannot report an error, so doing it first
  // would destroy a live terminal and leave the record behind on a failure.
  try {
    await useWorkspaceStore.getState().deleteSession(workspaceId, session.id);
  } catch (error) {
    // The session stays in the list. That is the signal — there is no error
    // surface in this app yet, and a session that visibly did not disappear is
    // better than one that vanished from the UI but not from disk.
    console.error('Failed to delete session record; leaving it in place', error);
    return;
  }

  terminalBridge.destroy(session.instanceId);
  useTerminalStore.getState().removeInstance(session.instanceId);

  if (useNavigationStore.getState().activeSessionId === session.id) {
    useNavigationStore.getState().setActiveSession(null);
  }
}

/**
 * Relaunch a session's CLI after it exited.
 *
 * Keyed by instance rather than session so the terminal pane, which only holds
 * an instance id, shares this instead of repeating the pair of calls.
 */
export function restartSession(instanceId: string): void {
  terminalBridge.restart(instanceId);
  useTerminalStore.getState().setState(instanceId, { hasExited: false });
}

/** Rename a session, ignoring a blank or unchanged name. */
export async function renameSession(
  workspaceId: string,
  session: Session,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed === session.name) return;
  await useWorkspaceStore.getState().updateSession(workspaceId, session.id, { name: trimmed });
}
