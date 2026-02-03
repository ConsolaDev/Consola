import * as Collapsible from '@radix-ui/react-collapsible';
import { FileText, ChevronRight, ChevronDown } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { useTabStore } from '../../stores/tabStore';
import { WorkspaceActionsMenu } from './WorkspaceActionsMenu';
import { ProjectNavItem } from './ProjectNavItem';

interface WorkspaceNavItemProps {
  workspace: Workspace;
}

export function WorkspaceNavItem({ workspace }: WorkspaceNavItemProps) {
  const isExpanded = useNavigationStore((state) => state.isWorkspaceExpanded(workspace.id));
  const toggleExpanded = useNavigationStore((state) => state.toggleWorkspaceExpanded);
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);
  const openTab = useTabStore((state) => state.openTab);
  const closeTabsForWorkspace = useTabStore((state) => state.closeTabsForWorkspace);
  const activeTabId = useTabStore((state) => state.activeTabId);

  const isActive = activeTabId === `workspace-${workspace.id}`;

  const handleChevronClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleExpanded(workspace.id);
  };

  const handleClick = () => {
    openTab('workspace', workspace.id);
  };

  const handleDelete = () => {
    closeTabsForWorkspace(workspace.id);
    deleteWorkspace(workspace.id);
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
        <button
          className={`nav-item workspace-nav-item ${isActive ? 'active' : ''}`}
          onClick={handleClick}
        >
          <span className="nav-item-icon">
            <FileText size={16} />
          </span>
          <span className="nav-item-label">{workspace.name}</span>
        </button>
        <WorkspaceActionsMenu
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          onDelete={handleDelete}
        />
      </div>
      <Collapsible.Content className="workspace-collapsible-content">
        <div className="project-list">
          {workspace.projects.length === 0 ? (
            <div className="project-list-empty">No projects</div>
          ) : (
            workspace.projects.map((project) => (
              <ProjectNavItem
                key={project.id}
                project={project}
                workspaceId={workspace.id}
              />
            ))
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
