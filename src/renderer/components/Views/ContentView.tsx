import { useWorkspaceStore } from '../../stores/workspaceStore';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

export function ContentView({ workspaceId, projectId }: ContentViewProps) {
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  const workspace = getWorkspace(workspaceId);

  if (!workspace) {
    return (
      <div className="workspace-view">
        <div className="workspace-view-content">
          <div className="workspace-placeholder">
            <p>Workspace not found</p>
          </div>
        </div>
      </div>
    );
  }

  const project = projectId
    ? workspace.projects.find((p) => p.id === projectId)
    : undefined;

  return (
    <div className="workspace-view">
      <div className="workspace-view-header">
        <h1 className="workspace-view-title">
          {project ? project.name : workspace.name}
        </h1>
        {project && (
          <p className="workspace-view-subtitle">{workspace.name}</p>
        )}
      </div>
      <div className="workspace-view-content">
        <div className="workspace-placeholder">
          {project ? (
            <>
              <p>Project: {project.path}</p>
              <p className="workspace-placeholder-hint">
                Chat panel and context tabs coming soon
              </p>
            </>
          ) : (
            <>
              <p>Workspace content will appear here</p>
              <p className="workspace-placeholder-hint">
                Chat panel and context tabs coming soon
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
