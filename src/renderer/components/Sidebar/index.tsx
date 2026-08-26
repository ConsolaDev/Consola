import { useEffect } from 'react';
import { Inbox as InboxIcon, Plus, Settings } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Scope, type Session } from '../../stores/workspaceStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { itemsForView } from '../../../shared/inboxViews';
import { useSettings } from '../../contexts/SettingsContext';
import { SessionNavItem } from './SessionNavItem';
import { GroupNavItem } from './GroupNavItem';
import { ScopeNavItem } from './ScopeNavItem';
import { sidebarSectionForSession } from './sidebarSections';
import { activateSession } from '../../utils/sessionActions';
import { addScopeViaDialog } from '../../utils/scopeActions';
import './styles.css';

/**
 * The workspace this window holds: Inbox · Groups · Scopes.
 *
 * A grouped session renders under its group, subtitled with the folder it
 * runs in; an ungrouped one renders under its scope. Group badges are derived from the
 * terminal status store on every render — progress is never stored. Which
 * workspace this is lives in the top bar.
 *
 * Scopes and groups both fold shut, and both remember it across a relaunch;
 * the set of folded ids lives in the settings store, since it is a
 * preference rather than anything the workspace record owns.
 */
export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const removeScope = useWorkspaceStore((state) => state.removeScope);
  const { openSettings } = useSettings();

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;

  const isInboxOpen = useNavigationStore((state) => state.isInboxOpen);
  const openInbox = useNavigationStore((state) => state.openInbox);
  // The sectioned count, not the raw cache: the cache now holds everything
  // the "involves" search returned, and the badge is for things waiting on
  // a triage decision. Unfiltered on purpose -- the sidebar has no filter
  // context, and a badge that shrank with a repo selection would lie.
  const inboxCount = useInboxStore((state) =>
    workspace ? itemsForView(state.snapshots[workspace.id]?.items ?? [], 'inbox').length : 0
  );

  // Prime the inbox for provider-bound workspaces so the count is live even
  // before the Inbox view is ever opened. Main answers from cache or kicks a
  // background refresh whose result arrives on the push channel.
  const providerAccount = workspace?.provider?.accountLogin;
  useEffect(() => {
    if (workspace && providerAccount) void useInboxStore.getState().load(workspace.id);
  }, [workspace?.id, providerAccount]);

  // Activating a session inside a folded section has to reveal it, or the
  // pane shows a conversation the sidebar has nowhere to point at. A live
  // group wins over the scope because that is the row the session renders
  // under.
  //
  // The workspace is read at call time rather than closed over: its identity
  // changes on every unrelated workspace write, and re-running on those would
  // keep prising open a section the user had just folded shut.
  const expandSidebarSection = useSettingsStore((state) => state.expandSidebarSection);
  useEffect(() => {
    if (!activeWorkspaceId || !activeSessionId) return;
    const current = useWorkspaceStore
      .getState()
      .workspaces.find((candidate) => candidate.id === activeWorkspaceId);
    const session = current?.sessions.find((candidate) => candidate.id === activeSessionId);
    if (!current || !session) return;
    const liveGroupIds = new Set(
      current.groups.filter((group) => !group.archivedAt).map((group) => group.id)
    );
    expandSidebarSection(sidebarSectionForSession(liveGroupIds, session));
  }, [activeWorkspaceId, activeSessionId, expandSidebarSection]);

  if (isSidebarHidden) {
    return null;
  }

  // Sessions appear once Claude has named them, so an unnamed one is a session
  // whose first turn has not landed yet.
  const sessions = workspace?.sessions.filter((session) => session.name.length > 0) ?? [];

  // A live group owns its members' rows; everything else falls through to the
  // scope it runs in. The partition is what keeps a session on exactly one
  // row — an archived group hands its members back to their scopes.
  const groups = (workspace?.groups ?? []).filter((group) => !group.archivedAt);
  const liveGroupIds = new Set(groups.map((group) => group.id));
  const grouped = new Map<string, Session[]>();
  const ungrouped: Session[] = [];
  for (const session of sessions) {
    const sectionId = sidebarSectionForSession(liveGroupIds, session);
    if (sectionId === session.groupId) {
      const members = grouped.get(sectionId) ?? [];
      members.push(session);
      grouped.set(sectionId, members);
    } else {
      ungrouped.push(session);
    }
  }

  // The scope a grouped session belongs to, which its row uses to say where
  // it runs — its row no longer sits under a scope heading. The whole record
  // goes down, not just the name: a session with a cwd of its own is
  // subtitled by that folder instead, which needs the scope's path to compare.
  const scopeFor = (scopeId: string) =>
    workspace?.scopes.find((scope) => scope.id === scopeId);

  const scopeIds = new Set(workspace?.scopes.map((scope) => scope.id) ?? []);
  // A session whose scope is gone still renders — losing a row over a broken
  // pointer would look like data loss.
  const orphanSessions = ungrouped.filter((session) => !scopeIds.has(session.scopeId));

  const handleAddScope = async () => {
    if (!workspace) return;
    try {
      await addScopeViaDialog(workspace.id);
    } catch (error) {
      console.error('Failed to add scope', error);
    }
  };

  const handleRemoveScope = async (scope: Scope) => {
    if (!workspace) return;
    if (!window.confirm(`Remove scope "${scope.name}"? The folder itself is untouched.`)) {
      return;
    }
    try {
      await removeScope(workspace.id, scope.id);
    } catch (error) {
      // The service refuses while sessions reference the scope; the button is
      // hidden in that case, so this only fires on a race. The scope visibly
      // staying put is the signal.
      console.error('Failed to remove scope', error);
    }
  };

  const addScopeButton = (
    <button
      className="sidebar-section-button"
      onClick={() => void handleAddScope()}
      disabled={!workspace}
    >
      <Plus size={14} />
    </button>
  );

  return (
    <aside className="sidebar">
      {workspace?.provider && (
        <div className="sidebar-inbox">
          <button
            className={`sidebar-inbox-row ${isInboxOpen ? 'active' : ''}`}
            onClick={openInbox}
          >
            <InboxIcon size={14} />
            <span className="sidebar-inbox-name">Inbox</span>
            {inboxCount > 0 && <span className="sidebar-inbox-count">{inboxCount}</span>}
          </button>
        </div>
      )}
      {workspace && groups.length > 0 && (
        <div className="sidebar-section sidebar-section-groups">
          <div className="sidebar-section-header">
            <span className="sidebar-section-title">Groups</span>
          </div>
          <nav className="session-list">
            {groups.map((group) => (
              <GroupNavItem
                key={group.id}
                group={group}
                sessions={grouped.get(group.id) ?? []}
                workspaceId={workspace.id}
                scopeFor={scopeFor}
                activeSessionId={activeSessionId}
              />
            ))}
          </nav>
        </div>
      )}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">Scopes</span>
          <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>{addScopeButton}</Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                  Add scope
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <nav className="session-list">
          {workspace &&
            workspace.scopes.map((scope) => {
              const scopeSessions = ungrouped.filter(
                (session) => session.scopeId === scope.id
              );
              const removable =
                workspace.scopes.length > 1 &&
                workspace.sessions.every((session) => session.scopeId !== scope.id);
              return (
                <ScopeNavItem
                  key={scope.id}
                  scope={scope}
                  sessions={scopeSessions}
                  workspaceId={workspace.id}
                  activeSessionId={activeSessionId}
                  removable={removable}
                  onRemove={(target) => void handleRemoveScope(target)}
                />
              );
            })}
          {workspace &&
            orphanSessions.map((session) => (
              <SessionNavItem
                key={session.id}
                session={session}
                workspaceId={workspace.id}
                isActive={activeSessionId === session.id}
                onClick={() => activateSession(workspace.id, session.id)}
              />
            ))}
        </nav>
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-settings-button" onClick={openSettings}>
          <Settings size={16} />
          <span>Settings</span>
          <span className="sidebar-settings-shortcut">⌘,</span>
        </button>
      </div>
    </aside>
  );
}
