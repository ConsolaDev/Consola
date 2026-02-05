import { useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { AgentPanel } from '../Agent/AgentPanel';
import { ContextPlaceholder } from './ContextPlaceholder';
import { PathDisplay } from './PathDisplay';
import { FileExplorer } from '../FileExplorer';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

export function ContentView({ workspaceId, projectId }: ContentViewProps) {
  const [isExplorerVisible, setIsExplorerVisible] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

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

  const contextId = projectId
    ? `project-${projectId}`
    : `workspace-${workspaceId}`;
  const instanceId = `${contextId}-main`;
  const cwd = project?.path || '';

  const handleSelectFile = (path: string) => {
    setSelectedFilePath(path);
  };

  const handleToggleExplorer = () => {
    setIsExplorerVisible(!isExplorerVisible);
  };

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
          <PathDisplay
            path={project.path}
            className="workspace-view-path"
            showExplorerToggle
            isExplorerVisible={isExplorerVisible}
            onToggleExplorer={handleToggleExplorer}
          />
        )}
      </div>
      <div className="workspace-view-content">
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {isExplorerVisible && cwd && (
            <>
              <Panel id="explorer" defaultSize="20%" minSize="15%" maxSize="40%">
                <FileExplorer
                  rootPath={cwd}
                  selectedPath={selectedFilePath}
                  onSelectFile={handleSelectFile}
                />
              </Panel>
              <Separator className="resize-handle" />
            </>
          )}
          <Panel id="agent" defaultSize={isExplorerVisible ? "45%" : "60%"} minSize="20%">
            <AgentPanel instanceId={instanceId} cwd={cwd} />
          </Panel>
          <Separator className="resize-handle" />
          <Panel id="context" minSize="20%">
            <ContextPlaceholder
              contextId={contextId}
              selectedFile={selectedFilePath}
            />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
