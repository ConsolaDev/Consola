import { Folder, GitBranch, Plus, Settings, X } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Scope } from '../../stores/workspaceStore';
import { useSettings } from '../../contexts/SettingsContext';
import { dialogBridge } from '../../services/dialogBridge';
import { SessionNavItem } from './SessionNavItem';
import { activateSession, createQuickSession } from '../../utils/sessionActions';
import './styles.css';

/**
 * The scopes of the workspace this window holds, with each session nested
 * under the scope it runs in.
 *
 * Scopes are the one level of structure the sidebar carries: a window shows
 * one workspace, a workspace holds a few durable places, and every session
 * has exactly one home among them. Which workspace this is lives in the top
 * bar.
 */
export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const addScope = useWorkspaceStore((state) => state.addScope);
  const removeScope = useWorkspaceStore((state) => state.removeScope);
  const { openSettings } = useSettings();

  if (isSidebarHidden) {
    return null;
  }

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  // Sessions appear once Claude has named them, so an unnamed one is a session
  // whose first turn has not landed yet.
  const sessions = workspace?.sessions.filter((session) => session.name.length > 0) ?? [];
  const scopeIds = new Set(workspace?.scopes.map((scope) => scope.id) ?? []);
  // A session whose scope is gone still renders — losing a row over a broken
  // pointer would look like data loss.
  const orphanSessions = sessions.filter((session) => !scopeIds.has(session.scopeId));

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
              const scopeSessions = sessions.filter(
                (session) => session.scopeId === scope.id
              );
              const removable =
                workspace.scopes.length > 1 &&
                workspace.sessions.every((session) => session.scopeId !== scope.id);
              return (
                <div key={scope.id} className="scope-group">
                  <div className="scope-row" title={scope.path}>
                    <span className="scope-row-icon">
                      {scope.isGitRepo ? <GitBranch size={12} /> : <Folder size={12} />}
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
