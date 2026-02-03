import { Settings, Home, Plus } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useCreateWorkspace } from '../../contexts/CreateWorkspaceContext';
import { NavItem } from './NavItem';
import { WorkspaceNavItem } from './WorkspaceNavItem';
import './styles.css';

export function Sidebar() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const { openDialog } = useCreateWorkspace();

  if (isSidebarHidden) {
    return null;
  }

  const newWorkspaceButton = (
    <button className="sidebar-section-button" onClick={openDialog}>
      <Plus size={14} />
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-nav">
        <NavItem
          icon={<Home size={16} />}
          label="Home"
          to="/"
        />
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">Workspaces</span>
          <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>{newWorkspaceButton}</Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
                  New Workspace
                  <span className="tooltip-shortcut">⌘N</span>
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <nav className="workspace-list">
          {workspaces.map((workspace) => (
            <WorkspaceNavItem key={workspace.id} workspace={workspace} />
          ))}
        </nav>
      </div>

      <div className="sidebar-footer">
        <NavItem
          icon={<Settings size={16} />}
          label="Settings"
          to="/settings"
          shortcut="⌘,"
        />
      </div>
    </aside>
  );
}
