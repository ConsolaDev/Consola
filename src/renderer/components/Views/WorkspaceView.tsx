import { useParams, Navigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import './styles.css';

export function WorkspaceView() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  const workspace = workspaceId ? getWorkspace(workspaceId) : undefined;

  if (!workspace) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="workspace-view">
      <div className="workspace-view-header">
        <h1 className="workspace-view-title">{workspace.name}</h1>
      </div>
      <div className="workspace-view-content">
        <div className="workspace-placeholder">
          <p>Workspace content will appear here</p>
          <p className="workspace-placeholder-hint">
            Chat panel and context tabs coming soon
          </p>
        </div>
      </div>
    </div>
  );
}
