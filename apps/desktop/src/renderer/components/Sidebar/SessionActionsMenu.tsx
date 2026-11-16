import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Archive,
  ArchiveRestore,
  Check,
  Link2,
  MoreVertical,
  Pencil,
  Plus,
  Tag,
  Trash2,
  Unlink,
} from 'lucide-react';
import type { Label, Session } from '../../../shared/workspace';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { NewLabelDialog } from '../Dialogs/NewLabelDialog';
import { settleWithUndo, unsettleWithUndo } from '../../utils/settleActions';
import type { SettleOffer } from '../../sidebar/settleRules';

/** Stable identity: a fresh [] from the selector would re-render every tick. */
const EMPTY_LABELS: Label[] = [];

interface SessionActionsMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  workspaceId: string;
  onRename: () => void;
  onDelete: () => void;
  /** What this row may do about the Settled shelf; absent offers nothing. */
  settle?: SettleOffer;
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
 * Labels are the one way to file a session: tick the ones it carries, or make a
 * new one and have it applied at once. There is no "move to group" — groups are
 * not shown anywhere, so a move into one would change nothing on screen.
 */
export function SessionActionsMenu({ session, workspaceId, onRename, onDelete, open, onOpenChange, settle }: SessionActionsMenuProps) {
  const bound = useWorkspaceStore((state) =>
    Boolean(state.workspaces.find((candidate) => candidate.id === workspaceId)?.provider)
  );
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const labels = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === workspaceId)?.labels) ?? EMPTY_LABELS;
  const assignLabel = useWorkspaceStore((state) => state.assignLabel);
  const unassignLabel = useWorkspaceStore((state) => state.unassignLabel);
  const [creatingLabel, setCreatingLabel] = useState(false);
  // Selecting "Link to work item..." opens a dialog; the menu refocusing
  // its trigger would race the dialog's own focus grab (WorkspaceSwitcher
  // has the same guard for Delete).
  const openingDialog = useRef(false);

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

  const handleNewLabel = () => {
    openingDialog.current = true;
    setCreatingLabel(true);
  };

  const canLink = bound && session.kind !== 'conductor';

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          className="nav-row-action session-actions-trigger"
          onClick={(e) => e.stopPropagation()}
          aria-label="Session actions"
          title="Session actions"
        >
          <MoreVertical size={12} aria-hidden="true" />
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
          <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className="dropdown-item">
                <Tag size={14} />
                <span>Labels</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="dropdown-content" sideOffset={4}>
                  {labels.map((label) => {
                    const on = session.labelIds?.includes(label.id) ?? false;
                    return (
                      <DropdownMenu.Item
                        key={label.id}
                        className="dropdown-item"
                        onSelect={(event) => {
                          event.preventDefault();
                          const write = on ? unassignLabel : assignLabel;
                          void write(workspaceId, session.id, label.id).catch((error) => {
                            console.error('Failed to change session label', error);
                          });
                        }}
                      >
                        {on ? <Check size={14} /> : <Tag size={14} />}
                        <span>{label.emoji ? `${label.emoji} ` : ''}{label.name}</span>
                      </DropdownMenu.Item>
                    );
                  })}
                  {labels.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}
                  <DropdownMenu.Item className="dropdown-item" onSelect={handleNewLabel}>
                    <Plus size={14} />
                    <span>New label…</span>
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          {settle?.kind === 'unsettle' && (
            <DropdownMenu.Item className="dropdown-item" onSelect={() => void unsettleWithUndo(workspaceId, session.id, session.name)}>
              <ArchiveRestore size={14} />
              <span>Move back to list</span>
            </DropdownMenu.Item>
          )}
          {settle?.kind === 'settle' && (
            <DropdownMenu.Item className="dropdown-item" onSelect={() => void settleWithUndo(workspaceId, session.id, session.name)}>
              <Archive size={14} />
              <span>Settle</span>
            </DropdownMenu.Item>
          )}
          {/* Where it cannot work, say why rather than leave the person guessing. */}
          {settle?.kind === 'blocked' && (
            <DropdownMenu.Item className="dropdown-item" disabled title={settle.reason}>
              <Archive size={14} />
              <span>Settle · {settle.reason}</span>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.CheckboxItem
            className="dropdown-item"
            checked={session.autoSettle === 'never'}
            onCheckedChange={(keep) => {
              void updateSession(workspaceId, session.id, { autoSettle: keep ? 'never' : undefined }).catch((error) => {
                console.error('Failed to change auto-settle', error);
              });
            }}
          >
            <span className="navigation-settings-check">
              <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
            </span>
            <span>Never auto-settle</span>
          </DropdownMenu.CheckboxItem>
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
            onSelect={onDelete}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
      {creatingLabel && (
        <NewLabelDialog
          workspaceId={workspaceId}
          onClose={() => setCreatingLabel(false)}
          onCreated={(label) => assignLabel(workspaceId, session.id, label.id)}
        />
      )}
    </DropdownMenu.Root>
  );
}
