import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { AgentPanel } from '../Agent/AgentPanel';
import { ContextPlaceholder } from './ContextPlaceholder';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

/**
 * Truncate a file path to show a sensible shortened version.
 * Shows ~ for home directory and last 2-3 path segments.
 */
function truncatePath(fullPath: string): string {
  // Replace home directory with ~
  const homeDir = '/Users/';
  let path = fullPath;

  if (path.startsWith(homeDir)) {
    const afterHome = path.slice(homeDir.length);
    const firstSlash = afterHome.indexOf('/');
    if (firstSlash !== -1) {
      path = '~' + afterHome.slice(firstSlash);
    }
  }

  const segments = path.split('/').filter(Boolean);

  // If path is short enough, return as-is
  if (segments.length <= 3) {
    return path.startsWith('/') ? '/' + segments.join('/') : segments.join('/');
  }

  // Show first segment (~ or root indicator) and last 2 segments
  const firstPart = path.startsWith('~') ? '~' : '';
  const lastSegments = segments.slice(-2).join('/');

  return `${firstPart}/.../${lastSegments}`;
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
          <Tooltip.Provider delayDuration={300}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <span className="workspace-view-path">{truncatePath(project.path)}</span>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" sideOffset={5}>
                  {project.path}
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
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
