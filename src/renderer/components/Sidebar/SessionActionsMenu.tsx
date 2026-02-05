import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

interface SessionActionsMenuProps {
  sessionName: string;
  onRename: () => void;
  onDelete: () => void;
}

export function SessionActionsMenu({ sessionName, onRename, onDelete }: SessionActionsMenuProps) {
  const handleDelete = () => {
    if (window.confirm(`Delete session "${sessionName}"? This will remove the session and its chat history.`)) {
      onDelete();
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="session-actions-trigger"
          onClick={(e) => e.stopPropagation()}
          aria-label="Session actions"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
          <DropdownMenu.Item
            className="dropdown-item"
            onSelect={onRename}
          >
            <Pencil size={14} />
            <span>Rename</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="dropdown-item dropdown-item-destructive"
            onSelect={handleDelete}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
