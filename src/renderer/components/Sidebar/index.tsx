import { Plus, Settings } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSettings } from '../../contexts/SettingsContext';
import { SessionNavItem } from './SessionNavItem';
import { activateSession, createQuickSession } from '../../utils/sessionActions';
import './styles.css';

/**
 * The sessions of the workspace this window holds.
 *
 * Flat on purpose: a window shows one workspace, so there is nothing left to
 * nest under. Which workspace that is lives in the top bar.
 */
export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const { openSettings } = useSettings();

  if (isSidebarHidden) {
    return null;
  }

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null;
  // Sessions appear once Claude has named them, so an unnamed one is a session
  // whose first turn has not landed yet.
  const sessions = workspace?.sessions.filter((session) => session.name.length > 0) ?? [];

  const newSessionButton = (
    <button
      className="sidebar-section-button"
      onClick={() => workspace && void createQuickSession(workspace.id)}
      disabled={!workspace}
    >
      <Plus size={14} />
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">Sessions</span>
          <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>{newSessionButton}</Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                  New Session
                  <span className="tooltip-shortcut">⌘N</span>
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <nav className="session-list">
          {workspace &&
            sessions.map((session) => (
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
