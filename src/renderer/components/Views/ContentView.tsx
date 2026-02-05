import { useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { AgentPanel } from '../Agent/AgentPanel';
import { PreviewPanel } from '../PreviewPanel';
import { PathDisplay } from './PathDisplay';
import { FileExplorer } from '../FileExplorer';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

export function ContentView({ workspaceId, projectId }: ContentViewProps) {
  const [isExplorerVisible, setIsExplorerVisible] = useState(false);

  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
  const openFile = usePreviewTabStore((state) => state.openFile);
  const hasOpenTabs = usePreviewTabStore((state) => state.tabs.length > 0);
  const activeTabId = usePreviewTabStore((state) => state.activeTabId);

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
    openFile(path);
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
                  selectedPath={activeTabId}
                  onSelectFile={handleSelectFile}
                />
              </Panel>
              <Separator className="resize-handle" />
            </>
          )}
          <Panel id="agent" defaultSize={isExplorerVisible ? "45%" : "60%"} minSize="20%">
            <AgentPanel instanceId={instanceId} cwd={cwd} />
          </Panel>
          {hasOpenTabs && (
            <>
              <Separator className="resize-handle" />
              <Panel id="preview" defaultSize="40%" minSize="20%">
                <PreviewPanel />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}
