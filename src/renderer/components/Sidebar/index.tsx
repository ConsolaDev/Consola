import { Settings, Home } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { NavItem } from './NavItem';
import { WorkspaceNavItem } from './WorkspaceNavItem';
import { WorkspaceHeader } from './WorkspaceHeader';
import { SidebarToggle } from './SidebarToggle';
import './styles.css';

export function Sidebar() {
  const isSidebarCollapsed = useNavigationStore((state) => state.isSidebarCollapsed);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  return (
    <aside className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
      <WorkspaceHeader />

      <div className="sidebar-nav">
        <NavItem
          icon={<Home size={16} />}
          label="Home"
          to="/"
        />
      </div>

      <div className="sidebar-section">
        {!isSidebarCollapsed && (
          <div className="sidebar-section-title">Workspaces</div>
        )}
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
        <SidebarToggle />
      </div>
    </aside>
  );
}
