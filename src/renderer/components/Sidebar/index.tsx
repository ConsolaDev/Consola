import { useEffect } from 'react';
import { Folder, GitBranch, Inbox as InboxIcon, Plus, Settings, X } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Scope, type Session } from '../../stores/workspaceStore';
import { useInboxStore } from '../../stores/inboxStore';
import { useSettings } from '../../contexts/SettingsContext';
import { dialogBridge } from '../../services/dialogBridge';
import { SessionNavItem } from './SessionNavItem';
import { GroupNavItem } from './GroupNavItem';
import { activateSession, createQuickSession } from '../../utils/sessionActions';
import './styles.css';

/**
 * The workspace this window holds: Inbox · Groups · Scopes.
 *
 * A grouped session renders under its group with its scope as subtitle; an
 * ungrouped one renders under its scope. Group badges are derived from the
 * terminal status store on every render — progress is never stored. Which
 * workspace this is lives in the top bar.
 */
export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const addScope = useWorkspaceStore((state) => state.addScope);
  const removeScope = useWorkspaceStore((state) => state.removeScope);
  const { openSettings } = useSettings();

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;

  const isInboxOpen = useNavigationStore((state) => state.isInboxOpen);
  const openInbox = useNavigationStore((state) => state.openInbox);
  const inboxCount = useInboxStore((state) =>
    workspace ? (state.snapshots[workspace.id]?.items.length ?? 0) : 0
  );

  // Prime the inbox for github-bound workspaces so the count is live even
  // before the Inbox view is ever opened. Main answers from cache or kicks a
  // background refresh whose result arrives on the push channel.
  const githubAccount = workspace?.github?.accountLogin;
  useEffect(() => {
    if (workspace && githubAccount) void useInboxStore.getState().load(workspace.id);
  }, [workspace?.id, githubAccount]);

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
    if (session.groupId && liveGroupIds.has(session.groupId)) {
      const members = grouped.get(session.groupId) ?? [];
      members.push(session);
      grouped.set(session.groupId, members);
    } else {
      ungrouped.push(session);
    }
  }

  // The subtitle a grouped session carries: where it runs, since its row no
  // longer sits under a scope heading.
  const scopeNameFor = (scopeId: string) =>
    workspace?.scopes.find((scope) => scope.id === scopeId)?.name;

  const scopeIds = new Set(workspace?.scopes.map((scope) => scope.id) ?? []);
  // A session whose scope is gone still renders — losing a row over a broken
  // pointer would look like data loss.
  const orphanSessions = ungrouped.filter((session) => !scopeIds.has(session.scopeId));

  const handleAddScope = async () => {
    if (!workspace) return;
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    try {
      await addScope(workspace.id, {
        name: folder.name,
        path: folder.path,
        isGitRepo: folder.isGitRepo,
      });
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
      {workspace?.github && (
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
        <div className="sidebar-section">
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
                scopeNameFor={scopeNameFor}
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
                <div key={scope.id} className="scope-group">
                  <div className="scope-row" title={scope.path}>
                    <span className="scope-row-icon">
                      {scope.isGitRepo ? <GitBranch size={13} /> : <Folder size={13} />}
                    </span>
                    <span className="scope-row-name">{scope.name}</span>
                    <button
                      className="scope-row-action"
                      onClick={() => void createQuickSession(workspace.id, scope.id)}
                      aria-label={`New session in ${scope.name}`}
                    >
                      <Plus size={12} />
                    </button>
                    {removable && (
                      <button
                        className="scope-row-action"
                        onClick={() => void handleRemoveScope(scope)}
                        aria-label={`Remove scope ${scope.name}`}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  {scopeSessions.map((session) => (
                    <SessionNavItem
                      key={session.id}
                      session={session}
                      workspaceId={workspace.id}
                      isActive={activeSessionId === session.id}
                      onClick={() => activateSession(workspace.id, session.id)}
                    />
                  ))}
                </div>
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
