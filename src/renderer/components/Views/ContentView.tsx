import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { AgentPanel } from '../Agent/AgentPanel';
import { ContextPlaceholder } from './ContextPlaceholder';
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
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <Panel id="agent" defaultSize="60%" minSize="20%">
            <AgentPanel />
          </Panel>
          <Separator className="resize-handle" />
          <Panel id="context" minSize="20%">
            <ContextPlaceholder />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
