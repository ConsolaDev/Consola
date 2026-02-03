import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Trash2 } from 'lucide-react';

interface WorkspaceActionsMenuProps {
  workspaceId: string;
  workspaceName: string;
  onDelete: () => void;
}

export function WorkspaceActionsMenu({ workspaceId, workspaceName, onDelete }: WorkspaceActionsMenuProps) {
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
