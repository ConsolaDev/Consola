import { NavLink } from 'react-router-dom';
import * as Collapsible from '@radix-ui/react-collapsible';
import { FileText, ChevronRight, ChevronDown } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import type { Workspace } from '../../stores/workspaceStore';

interface WorkspaceNavItemProps {
  workspace: Workspace;
}

export function WorkspaceNavItem({ workspace }: WorkspaceNavItemProps) {
  const isExpanded = useNavigationStore((state) => state.isWorkspaceExpanded(workspace.id));
  const toggleExpanded = useNavigationStore((state) => state.toggleWorkspaceExpanded);

  const handleChevronClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleExpanded(workspace.id);
  };

  return (
    <Collapsible.Root open={isExpanded} onOpenChange={() => toggleExpanded(workspace.id)}>
      <div className="workspace-nav-item-container">
        <button
          className="workspace-expand-toggle"
          onClick={handleChevronClick}
          aria-label={isExpanded ? 'Collapse workspace' : 'Expand workspace'}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <NavLink
          to={`/workspace/${workspace.id}`}
          className={({ isActive }) => `nav-item workspace-nav-item ${isActive ? 'active' : ''}`}
        >
          <span className="nav-item-icon">
            <FileText size={16} />
          </span>
          <span className="nav-item-label">{workspace.name}</span>
        </NavLink>
      </div>
      <Collapsible.Content className="workspace-collapsible-content">
        <div className="project-list">
          {workspace.projects.length === 0 ? (
            <div className="project-list-empty">No projects</div>
          ) : (
            workspace.projects.map((project) => (
              <div key={project.id} className="project-nav-item-placeholder">
                {project.name}
              </div>
            ))
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
