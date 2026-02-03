import { Folder, GitBranch } from 'lucide-react';
import { useWorkspaceStore, type Project } from '../../stores/workspaceStore';
import { useTabStore } from '../../stores/tabStore';
import { ProjectActionsMenu } from './ProjectActionsMenu';

interface ProjectNavItemProps {
  project: Project;
  workspaceId: string;
}

export function ProjectNavItem({ project, workspaceId }: ProjectNavItemProps) {
  const removeProject = useWorkspaceStore((state) => state.removeProjectFromWorkspace);
  const openTab = useTabStore((state) => state.openTab);
  const closeTabsForProject = useTabStore((state) => state.closeTabsForProject);
  const activeTabId = useTabStore((state) => state.activeTabId);

  const isActive = activeTabId === `project-${project.id}`;

  const handleClick = () => {
    openTab('project', project.id, workspaceId);
  };

  const handleRemove = () => {
    closeTabsForProject(project.id);
    removeProject(workspaceId, project.id);
  };

  return (
    <button
      className={`project-nav-item ${isActive ? 'active' : ''}`}
      onClick={handleClick}
    >
      <span className="project-nav-item-icon">
        {project.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
      </span>
      <span className="project-nav-item-name">{project.name}</span>
      <ProjectActionsMenu
        projectName={project.name}
        onRemove={handleRemove}
      />
    </button>
  );
}
