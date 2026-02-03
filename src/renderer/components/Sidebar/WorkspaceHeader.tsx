import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

export function WorkspaceHeader() {
  const navigate = useNavigate();
  const isSidebarCollapsed = useNavigationStore((state) => state.isSidebarCollapsed);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);

  const handleNewWorkspace = () => {
    const workspace = createWorkspace('New Workspace');
    navigate(`/workspace/${workspace.id}`);
  };

  const newButton = (
    <button className="workspace-header-button" onClick={handleNewWorkspace}>
      <Plus size={16} />
    </button>
  );

  return (
    <div className="workspace-header">
      <div className="workspace-header-drag-region" />
      {!isSidebarCollapsed && (
        <span className="workspace-header-title">Workspaces</span>
      )}
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{newButton}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
              New Workspace
              <span className="tooltip-shortcut">⌘N</span>
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </div>
  );
}
