import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { AgentPanel } from '../Agent/AgentPanel';
import { ContextPlaceholder } from './ContextPlaceholder';
import { TruncatedPath } from './TruncatedPath';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

export function ContentView({ workspaceId, projectId }: ContentViewProps) {
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'content-view-split',
    storage: localStorage,
  });

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

  // Compute instanceId for agent (using -main suffix for future multi-agent support)
  const contextId = projectId
    ? `project-${projectId}`
    : `workspace-${workspaceId}`;
  const instanceId = `${contextId}-main`;

  // Determine working directory for agent
  // For projects, use the project path; for workspaces, let main process use its default
  const cwd = project?.path || '';

  return (
    <div className="workspace-view">
      <div className="workspace-view-header">
        <h1 className="workspace-view-title">
          {project ? (
            <>
              <span className="workspace-view-breadcrumb">{workspace.name}</span>
              <span className="workspace-view-separator">/</span>
              <span>{project.name}</span>
            </>
          ) : (
            workspace.name
          )}
        </h1>
        {project?.path && (
          <TruncatedPath path={project.path} className="workspace-view-path" />
        )}
      </div>
      <div className="workspace-view-content">
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <Panel id="agent" defaultSize="60%" minSize="20%">
            <AgentPanel instanceId={instanceId} cwd={cwd} />
          </Panel>
          <Separator className="resize-handle" />
          <Panel id="context" minSize="20%">
            <ContextPlaceholder contextId={contextId} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
