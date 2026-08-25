import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link2, MoreHorizontal, Pencil, Trash2, Unlink } from 'lucide-react';
import { sessionLabel } from '../../../shared/sessionLabel';
import type { Session } from '../../../shared/workspace';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

interface SessionActionsMenuProps {
  session: Session;
  workspaceId: string;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * The ⋯ menu on a sidebar row: rename, link or unlink, delete.
 *
 * Link and Unlink are the sidebar door into the session-item relation.
 * Linking is metadata only — the session keeps its folder and gets no
 * prompt — and unlinking a session that runs in an item's worktree leaves
 * it there. Conductors are never offered the link (main would refuse), and
 * a workspace with no provider has no items to link to.
 */
export function SessionActionsMenu({ session, workspaceId, onRename, onDelete }: SessionActionsMenuProps) {
  const bound = useWorkspaceStore((state) =>
    Boolean(state.workspaces.find((candidate) => candidate.id === workspaceId)?.provider)
  );
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  // Selecting "Link to work item..." opens a dialog; the menu refocusing
  // its trigger would race the dialog's own focus grab (WorkspaceSwitcher
  // has the same guard for Delete).
  const openingDialog = useRef(false);

  const handleDelete = () => {
    if (
      window.confirm(
        `Delete session "${sessionLabel(session)}"? This will remove the session and its chat history.`
      )
    ) {
      onDelete();
    }
  };

  const handleLink = () => {
    openingDialog.current = true;
    useLinkSessionDialogStore.getState().open({ kind: 'pick-item', workspaceId, session });
  };

  const handleUnlink = () => {
    // Presence semantics: the key is sent, and undefined, which is what
    // main reads as "clear the link" — exactly as leaving a group works.
    void updateSession(workspaceId, session.id, { workItem: undefined }).catch((error) => {
      // The row visibly staying linked is the signal.
      console.error('Failed to unlink session', error);
    });
  };

  const canLink = bound && session.kind !== 'conductor';

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
        <DropdownMenu.Content
          className="dropdown-content"
          sideOffset={4}
          align="end"
          onCloseAutoFocus={(event) => {
            if (openingDialog.current) {
              event.preventDefault();
              openingDialog.current = false;
            }
          }}
        >
          <DropdownMenu.Item className="dropdown-item" onSelect={onRename}>
            <Pencil size={14} />
            <span>Rename</span>
          </DropdownMenu.Item>
          {canLink &&
            (session.workItem ? (
              <DropdownMenu.Item className="dropdown-item" onSelect={handleUnlink}>
                <Unlink size={14} />
                <span>Unlink</span>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item className="dropdown-item" onSelect={handleLink}>
                <Link2 size={14} />
                <span>Link to work item...</span>
              </DropdownMenu.Item>
            ))}
          <DropdownMenu.Separator className="dropdown-separator" />
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
