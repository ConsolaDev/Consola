import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Boxes, Check, ChevronRight, MoreHorizontal, Trash2 } from 'lucide-react';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

interface WorkspaceActionsMenuProps {
  workspaceId: string;
  workspaceName: string;
  onDelete: () => void;
}

export function WorkspaceActionsMenu({ workspaceId, workspaceName, onDelete }: WorkspaceActionsMenuProps) {
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const harnesses = useHarnessStore((state) => state.harnesses);

  const defaultHarnessId = getWorkspace(workspaceId)?.defaultHarnessId;
  const selectable = harnesses.filter(isSelectableHarness);

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete "${workspaceName}"?`)) {
      onDelete();
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="workspace-actions-trigger"
          onClick={(e) => e.stopPropagation()}
          aria-label="Workspace actions"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
          {selectable.length > 1 && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="dropdown-item">
                <Boxes size={14} />
                <span>Default harness</span>
                <ChevronRight size={14} style={{ marginLeft: 'auto' }} />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="dropdown-content" sideOffset={4}>
                  {selectable.map((harness) => (
                    <DropdownMenu.Item
                      key={harness.id}
                      className="dropdown-item"
                      onSelect={() =>
                        updateWorkspace(workspaceId, { defaultHarnessId: harness.id })
                      }
                    >
                      <span
                        className="workspace-harness-dot"
                        style={{ background: harness.accentColor }}
                      />
                      <span>{harness.name}</span>
                      {harness.id === defaultHarnessId && (
                        <Check size={14} style={{ marginLeft: 'auto' }} />
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}

          <DropdownMenu.Item
            className="dropdown-item dropdown-item-destructive"
            onSelect={handleDelete}
          >
            <Trash2 size={14} />
            <span>Delete workspace</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
