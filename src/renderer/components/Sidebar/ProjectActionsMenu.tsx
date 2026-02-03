import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, X } from 'lucide-react';

interface ProjectActionsMenuProps {
  projectName: string;
  onRemove: () => void;
}

export function ProjectActionsMenu({ projectName, onRemove }: ProjectActionsMenuProps) {
  const handleRemove = () => {
    if (window.confirm(`Remove "${projectName}" from this workspace?`)) {
      onRemove();
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="project-actions-trigger"
          onClick={(e) => e.stopPropagation()}
          aria-label="Project actions"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
          <DropdownMenu.Item
            className="dropdown-item"
            onSelect={handleRemove}
          >
            <X size={14} />
            <span>Remove from workspace</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
