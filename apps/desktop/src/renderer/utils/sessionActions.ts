import { filteredScope, newSessionScope, useHomeStore } from '../stores/homeStore';
import { closePanelOnWorkspaceSwitch, useNavigationStore } from '../stores/navigationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useWorkspaceStore, type Session } from '../stores/workspaceStore';
import { providerBridge } from '../services/providerBridge';
import { terminalBridge } from '../services/terminalBridge';
import { assistantBridge } from '../services/assistantBridge';
import { windowBridge } from '../services/windowBridge';
import { forgetSessionLocally } from './forgetSession';
import { ipcErrorMessage } from './ipcErrorMessage';
import { generateSessionInstanceId } from '../../shared/workspace';
import type { SessionCheckout } from '../../shared/sessionCheckout';
import { useNewSessionDialogStore, type NewSessionDestination } from '../stores/newSessionDialogStore';

export { generateSessionInstanceId };

/**
 * Session operations that span more than one store.
 *
 * These sequences have to happen in a particular order, and every caller has
 * to perform all of them — a partial teardown leaks a PTY, and a partial
 * creation lands on the wrong screen. Keeping them here means the sidebar and
 * the command palette cannot drift on what "delete a session" involves.
 */

/**
 * Select a session within the workspace this window already holds.
 *
 * Written as a single `setState` rather than `setActiveWorkspace` followed by
 * `setActiveSession`. `setActiveWorkspace` asks main for the workspace and
 * adopts the view it was last left on, so in two calls the pane would paint
 * the remembered session and only then correct to the named one — and on a
 * `focused-elsewhere` verdict, where this window did not get the workspace at
 * all, the follow-up call would still fire and point it at a session it is
 * not showing.
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
    overlay: null,
  });
  windowBridge.setView(workspaceId, { activeSessionId: sessionId, overlay: null });
}

/**
 * Narrow the sidebar's session list to one scope, or widen it to All with null.
 *
 * While one scope is picked, the open session is in the list. So picking a
 * scope the open session doesn't run in moves the view to the new-session
 * view, written through like any other backing-out. It never moves to one of
 * that scope's sessions: mounting a session launches its CLI, and choosing a
 * filter asked for no such thing. All hides nothing, so it never navigates.
 *
 * The Assistant belongs to no scope, so no filter hides it; the Inbox and
 * Automations cover the pane, so the choice only filters the list behind it.
 */
export function chooseScope(workspaceId: string, scopeId: string | null): void {
  useHomeStore.getState().setScopeFilter(workspaceId, scopeId);
  if (scopeId === null) return;
  const navigation = useNavigationStore.getState();
  if (navigation.activeWorkspaceId !== workspaceId || navigation.overlay !== null) return;
  const open = useWorkspaceStore.getState().getSession(workspaceId, navigation.activeSessionId ?? '');
  if (open && open.kind !== 'assistant' && open.scopeId !== scopeId) navigation.setActiveSession(null);
}

/**
 * Keep a session that just became active in the list: when one scope is
 * picked and the session runs in another (the palette, a notification, the
 * Assistant, the ▾ "New session in" menu), the filter follows it. Under All
 * the list already shows it, so clicking a row never narrows the list.
 */
export function revealSessionScope(workspaceId: string, sessionId: string | null): void {
  const workspace = useWorkspaceStore.getState().getWorkspace(workspaceId);
  // Resolved as the list resolves it: a filter whose scope was removed is All.
  const scope = workspace && filteredScope(workspace, useHomeStore.getState().scopeFilters[workspaceId]);
  if (!scope || !sessionId) return;
  const session = useWorkspaceStore.getState().getSession(workspaceId, sessionId);
  if (!session || session.kind === 'assistant' || session.scopeId === scope.id) return;
  useHomeStore.getState().setScopeFilter(workspaceId, session.scopeId);
}

/**
 * Open the workspace's Assistant, making its record the first time. Nothing
 * launches here: the pane does, like any other session.
 */
export async function openAssistant(workspaceId: string): Promise<void> {
  const session = await assistantBridge.open(workspaceId);
  activateSession(workspaceId, session.id);
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

  const result = await windowBridge.activateWorkspace(workspaceId);
  if (result.verdict === 'took') {
    closePanelOnWorkspaceSwitch(useNavigationStore.getState().activeWorkspaceId, workspaceId);
    // The remembered view is deliberately discarded: the caller named a
    // session, and that choice replaces whatever the workspace was left on.
    activateSession(workspaceId, sessionId);
  }
}

/** Resolve where a new session starts without changing the current view or filters. */
function sessionDestination(workspaceId: string, destination: NewSessionDestination) {
  const workspace = useWorkspaceStore.getState().getWorkspace(workspaceId);
  if (!workspace) return destination;
  const navigation = useNavigationStore.getState();
  const scope = newSessionScope(workspace, destination.scopeId ?? useHomeStore.getState().scopeFilters[workspaceId],
    navigation.activeWorkspaceId === workspaceId ? navigation.activeSessionId : null);
  return { ...destination, scopeId: scope?.id };
}

/** The scope a new session in this workspace starts in by default, for dialogs that offer a choice. */
export function defaultSessionScopeId(workspaceId: string): string | undefined {
  return sessionDestination(workspaceId, {}).scopeId;
}

/**
 * Keep work created without opening it (a fan-out, an orchestration) in
 * view: a filter on another scope would hide it, so it widens to All.
 * Widening never navigates.
 */
export function revealCreatedScope(workspaceId: string, scopeId: string): void {
  const filterId = useHomeStore.getState().scopeFilters[workspaceId];
  if (filterId !== undefined && filterId !== scopeId) chooseScope(workspaceId, null);
}

/** Open options without creating a session or replacing the view underneath. */
export function openNewSessionDialog(workspaceId: string, destination: NewSessionDestination = {}): void {
  useNewSessionDialogStore.getState().open(workspaceId, sessionDestination(workspaceId, destination));
}

/** Shared creation path for default sessions and the options dialog. */
export async function createSessionAndOpen(
  workspaceId: string,
  options: NewSessionDestination & { harnessId?: string; model?: string; checkout?: SessionCheckout } = {}
): Promise<Session | undefined> {
  const workspace = useWorkspaceStore.getState().getWorkspace(workspaceId);
  if (!workspace) throw new Error('This workspace is no longer available.');
  const { scopeId, groupId } = sessionDestination(workspaceId, options);
  if (!scopeId) throw new Error('Add a scope to this workspace to start a session.');

  if (useNavigationStore.getState().activeWorkspaceId !== workspaceId) {
    const result = await windowBridge.activateWorkspace(workspaceId);
    if (result.verdict !== 'took') return undefined;
    closePanelOnWorkspaceSwitch(useNavigationStore.getState().activeWorkspaceId, workspaceId);
    useNavigationStore.setState({ activeWorkspaceId: workspaceId, ...result.view });
  }
  const session = await useWorkspaceStore.getState().createSession(workspaceId, {
    name: 'New Session',
    workspaceId,
    instanceId: generateSessionInstanceId(workspaceId),
    harnessId: options.harnessId ?? workspace.defaultHarnessId,
    model: options.model,
    scopeId,
    groupId,
  }, options.checkout);
  if (!session) throw new Error('The session could not be created. Please try again.');
  // A slow worktree creation must not pull the user back from another workspace.
  if (useNavigationStore.getState().activeWorkspaceId === workspaceId) {
    activateSession(workspaceId, session.id);
  }
  return session;
}

const pendingQuickSessions = new Set<string>();

/** Start immediately with defaults; failed launches can be corrected in options. */
export async function createQuickSession(
  workspaceId: string,
  destination: NewSessionDestination = {}
): Promise<Session | undefined> {
  if (pendingQuickSessions.has(workspaceId)) return undefined;
  pendingQuickSessions.add(workspaceId);
  const resolved = sessionDestination(workspaceId, destination);
  try {
    return await createSessionAndOpen(workspaceId, resolved);
  } catch (reason) {
    if (useNavigationStore.getState().activeWorkspaceId === workspaceId) {
      useNewSessionDialogStore.getState().open(workspaceId, resolved,
        reason instanceof Error ? reason.message : String(reason));
    }
    return undefined;
  } finally {
    pendingQuickSessions.delete(workspaceId);
  }
}

/**
 * Close a session: drop the record — main stops its terminal, shell and MCP
 * endpoint with it — and forget this window's state for it.
 *
 * Closing is what kills the PTY; unmounting a pane does not. The conversation
 * itself stays in the harness's own session files and is still reachable with
 * `claude --resume`.
 */
export async function deleteSessionCompletely(
  workspaceId: string,
  session: Session
): Promise<void> {
  // Main deletes the record first and stops the PTY only once that reached
  // disk, so a failed delete leaves the session running and listed.
  try {
    await useWorkspaceStore.getState().deleteSession(workspaceId, session.id);
  } catch (error) {
    // The session stays in the list. That is the signal — there is no error
    // surface in this app yet, and a session that visibly did not disappear is
    // better than one that vanished from the UI but not from disk.
    console.error('Failed to delete session record; leaving it in place', error);
    return;
  }

  forgetSessionLocally(session);
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

/**
 * Run one of the workspace's actions in a work-item session that already
 * exists, and return why not, or null once main has taken it.
 *
 * Main relaunches an exited CLI for either kind of action, so a pane that
 * was offering Restart is live again — the same local correction
 * restartSession makes, since main reports only exits, never relaunches.
 */
export async function runActionInSession(
  workspaceId: string,
  session: Pick<Session, 'id' | 'instanceId'>,
  actionId: string
): Promise<string | null> {
  try {
    const result = await providerBridge.runActionInSession(workspaceId, session.id, actionId);
    if (!result.ok) return result.message;
    useTerminalStore.getState().setState(session.instanceId, { hasExited: false });
    return null;
  } catch (error) {
    return ipcErrorMessage(error);
  }
}

/**
 * Move a session into a group, or out of every group with `undefined`.
 *
 * One write either way. `groupId` clears by presence — the key is sent and
 * explicitly undefined, which is what main reads as "leave the group" — so
 * this must not be shortened to an object built by spreading a defined value
 * in, or removal would silently become a no-op.
 *
 * The destination is unfolded on success, for the same reason activating a
 * session reveals its section: a row that moved into a folded group would
 * vanish from the sidebar, and a move that looks like a delete is worse than
 * no move at all.
 *
 * Shared by the ⋯ menu and the sidebar's drag-and-drop so the two cannot
 * drift on what moving a session means.
 */
export async function moveSessionToGroup(
  workspaceId: string,
  sessionId: string,
  groupId: string | undefined
): Promise<void> {
  try {
    await useWorkspaceStore.getState().updateSession(workspaceId, sessionId, { groupId });
  } catch (error) {
    // The row visibly staying where it was is the signal, as it is for the
    // menu's other writes.
    console.error('Failed to move session to group', error);
    return;
  }
  // Leaving a group needs no reveal: the scope the row falls back to is
  // unfolded by the same gesture only if the user folded it themselves, and
  // prising that open would undo a choice they made about a section this
  // move never touched.
  if (groupId) useSettingsStore.getState().expandSidebarSection(groupId);
}

/** Rename a session, ignoring a blank or unchanged name. */
export async function renameSession(
  workspaceId: string,
  session: Session,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed === session.name) return;
  // A typed name is the user's own and wins permanently: the flag stops the
  // CLI-summary poll from ever overwriting it.
  await useWorkspaceStore
    .getState()
    .updateSession(workspaceId, session.id, { name: trimmed, nameIsUserSet: true });
}
