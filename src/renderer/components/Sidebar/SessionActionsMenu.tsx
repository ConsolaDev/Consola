import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Boxes, Check, Link2, MoreHorizontal, Pencil, Trash2, Unlink } from 'lucide-react';
import { sessionLabel } from '../../../shared/sessionLabel';
import type { Group, Session } from '../../../shared/workspace';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { NewGroupDialog } from '../Dialogs/NewGroupDialog';
import { moveSessionToGroup } from '../../utils/sessionActions';

/** Stable identity: a fresh [] from the selector would re-render every tick. */
const EMPTY_GROUPS: Group[] = [];

interface SessionActionsMenuProps {
  session: Session;
  workspaceId: string;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * The ⋯ menu on a sidebar row: rename, regroup, link or unlink, delete.
 *
 * Link and Unlink are the sidebar door into the session-item relation.
 * Linking is metadata only — the session keeps its folder and gets no
 * prompt — and unlinking a session that runs in an item's worktree leaves
 * it there. Conductors are never offered the link (main would refuse), and
 * a workspace with no provider has no items to link to.
 *
 * "Move to group" is the accessible twin of dragging a row onto a group
 * header — same single write, reachable from the keyboard. Only live groups
 * are offered: an archived one hands its members back to their scopes, so
 * moving into one would look like the move had failed. A conductor is not
 * offered it either, since its group is what it orchestrates.
 */
export function SessionActionsMenu({ session, workspaceId, onRename, onDelete }: SessionActionsMenuProps) {
  const bound = useWorkspaceStore((state) =>
    Boolean(state.workspaces.find((candidate) => candidate.id === workspaceId)?.provider)
  );
  // The stored array, filtered in render rather than in the selector: a
  // selector that built a new array every call would hand React a fresh
  // snapshot each time it asked for one.
  const allGroups = useWorkspaceStore(
    (state) => state.workspaces.find((candidate) => candidate.id === workspaceId)?.groups
  );
  const groups = (allGroups ?? EMPTY_GROUPS).filter((group) => !group.archivedAt);
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const [creatingGroup, setCreatingGroup] = useState(false);
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

  const handleMove = (groupId: string | undefined) => {
    void moveSessionToGroup(workspaceId, session.id, groupId);
  };

  const handleNewGroup = () => {
    openingDialog.current = true;
    setCreatingGroup(true);
  };

  const canLink = bound && session.kind !== 'conductor';
  // A conductor's group is the fleet it drives, not an inbox folder.
  const canRegroup = session.kind !== 'conductor';

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
          {canRegroup && (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="dropdown-item">
                <Boxes size={14} />
                <span>Move to group</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="dropdown-content" sideOffset={4}>
                  {groups.map((group) => (
                    <DropdownMenu.Item
                      key={group.id}
                      className="dropdown-item"
                      // Selecting the group it is already in would be a
                      // no-op write; disabling says so instead of pretending.
                      disabled={group.id === session.groupId}
                      onSelect={() => handleMove(group.id)}
                    >
                      {group.id === session.groupId ? <Check size={14} /> : <Boxes size={14} />}
                      <span>{group.name}</span>
                    </DropdownMenu.Item>
                  ))}
                  {groups.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}
                  <DropdownMenu.Item className="dropdown-item" onSelect={handleNewGroup}>
                    <span>New group…</span>
                  </DropdownMenu.Item>
                  {session.groupId !== undefined && (
                    <DropdownMenu.Item
                      className="dropdown-item"
                      onSelect={() => handleMove(undefined)}
                    >
                      <span>Remove from group</span>
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )}
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
      {creatingGroup && (
        <NewGroupDialog
          workspaceId={workspaceId}
          onClose={() => setCreatingGroup(false)}
          onCreated={(group) => moveSessionToGroup(workspaceId, session.id, group.id)}
        />
      )}
    </DropdownMenu.Root>
  );
}
