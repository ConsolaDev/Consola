import { Plus } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useCreateWorkspace } from '../../contexts/CreateWorkspaceContext';

export function WorkspaceHeader() {
  const { openDialog } = useCreateWorkspace();

  const newButton = (
    <button className="workspace-header-button" onClick={openDialog}>
      <Plus size={16} />
    </button>
  );

  return (
    <div className="workspace-header">
      <div className="workspace-header-drag-region" />
      <span className="workspace-header-title">Workspaces</span>
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
