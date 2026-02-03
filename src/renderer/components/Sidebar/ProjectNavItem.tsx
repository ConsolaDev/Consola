import { Folder, GitBranch } from 'lucide-react';
import { useWorkspaceStore, type Project } from '../../stores/workspaceStore';
import { ProjectActionsMenu } from './ProjectActionsMenu';

interface ProjectNavItemProps {
  project: Project;
  workspaceId: string;
}

export function ProjectNavItem({ project, workspaceId }: ProjectNavItemProps) {
  const removeProject = useWorkspaceStore((state) => state.removeProjectFromWorkspace);

  const handleRemove = () => {
    removeProject(workspaceId, project.id);
  };

  return (
    <div className="project-nav-item">
      <span className="project-nav-item-icon">
        {project.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
      </span>
      <span className="project-nav-item-name">{project.name}</span>
      <ProjectActionsMenu
        projectName={project.name}
        onRemove={handleRemove}
      />
    </div>
  );
}
