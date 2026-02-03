import { NavLink } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { FileText } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import type { Workspace } from '../../stores/workspaceStore';

interface WorkspaceNavItemProps {
  workspace: Workspace;
}

export function WorkspaceNavItem({ workspace }: WorkspaceNavItemProps) {
  const isSidebarCollapsed = useNavigationStore((state) => state.isSidebarCollapsed);

  const content = (
    <NavLink
      to={`/workspace/${workspace.id}`}
      className={({ isActive }) => `nav-item workspace-nav-item ${isActive ? 'active' : ''}`}
    >
      <span className="nav-item-icon">
        <FileText size={16} />
      </span>
      {!isSidebarCollapsed && (
        <span className="nav-item-label">{workspace.name}</span>
      )}
    </NavLink>
  );

  if (isSidebarCollapsed) {
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{content}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
              {workspace.name}
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }

  return content;
}
