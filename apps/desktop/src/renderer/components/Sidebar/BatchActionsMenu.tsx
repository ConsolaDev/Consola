import { useRef, type MutableRefObject } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlarmClockOff, Archive, ArchiveRestore, Trash2, X } from 'lucide-react';
import { sessionLabel } from '../../../shared/sessionLabel';
import type { Session } from '../../../shared/workspace';
import { useAttentionStore } from '../../stores/attentionStore';
import { clearSelection } from '../../stores/sessionSelectionStore';
import {
  deleteManyConfirmed,
  settleManyWithUndo,
  unsettleManyWithUndo,
} from '../../utils/batchActions';
import { wakeWithUndo } from '../../utils/snoozeActions';
import { SnoozeMenuItems } from '../Snooze/SnoozeMenuItems';

interface BatchActionsMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the right-click was, in the row's own box; null opens at the row's corner. */
  at: { x: number; y: number } | null;
  /** What had focus when the menu was asked for; it goes back there on close. */
  returnFocus: MutableRefObject<Element | null>;
  workspaceId: string;
  /** The selected sessions, in drawn order. */
  sessions: Session[];
}

/**
 * The menu for a selection: Snooze, Wake, Settle, Move back or Delete every
 * selected session at once. Each is one request to main, one write, and one
 * toast with one Undo (Delete asks once and has none). What a session cannot
 * do (a child chosen without its conductor, one in use) main refuses and the
 * toast counts. Opened from a selected row exactly as a row's own menu is.
 */
export function BatchActionsMenu({
  open,
  onOpenChange,
  at,
  returnFocus,
  workspaceId,
  sessions,
}: BatchActionsMenuProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const openingDialog = useRef(false);
  const attention = useAttentionStore((state) => state.attention);
  const ids = sessions.map((session) => session.id);
  const names = Object.fromEntries(sessions.map((session) => [session.id, sessionLabel(session)]));
  const count = sessions.length;
  const anySnoozed = ids.some((id) => attention[id] === 'snoozed');
  const anySettled = ids.some((id) => attention[id] === 'settled');
  const anyInPlay = ids.some((id) => attention[id] !== 'settled');
  // Every action ends the gesture: the selection has done its job.
  const then = (action: () => Promise<void>) => () => {
    clearSelection();
    void action();
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <span
          ref={anchorRef}
          className={`session-actions-anchor${at ? ' session-actions-anchor--at-pointer' : ''}`}
          style={at ? { left: at.x, top: at.y } : undefined}
          aria-hidden="true"
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content"
          sideOffset={at ? 2 : 4}
          align={at ? 'start' : 'end'}
          aria-label={`${count} selected sessions`}
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            const previous = returnFocus.current;
            returnFocus.current = null;
            event.preventDefault();
            if (openingDialog.current) {
              openingDialog.current = false;
              return;
            }
            if (previous instanceof HTMLElement && previous.isConnected)
              previous.focus({ preventScroll: true });
          }}
        >
          <DropdownMenu.Label className="dropdown-label">
            {count} sessions selected
          </DropdownMenu.Label>
          <SnoozeMenuItems
            workspaceId={workspaceId}
            sessionIds={ids}
            names={names}
            title={`Snooze ${count} sessions`}
            onPicked={clearSelection}
            onOpenDialog={() => {
              openingDialog.current = true;
              clearSelection();
            }}
          />
          {anySnoozed && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={then(() => wakeWithUndo(workspaceId, ids, names))}
            >
              <AlarmClockOff size={14} />
              <span>Wake</span>
            </DropdownMenu.Item>
          )}
          {anyInPlay && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={then(() => settleManyWithUndo(workspaceId, ids))}
            >
              <Archive size={14} />
              <span>Settle</span>
            </DropdownMenu.Item>
          )}
          {anySettled && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={then(() => unsettleManyWithUndo(workspaceId, ids))}
            >
              <ArchiveRestore size={14} />
              <span>Move back to list</span>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className="dropdown-item" onSelect={() => clearSelection()}>
            <X size={14} />
            <span>Clear selection</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Item
            className="dropdown-item dropdown-item-destructive"
            onSelect={then(() => deleteManyConfirmed(workspaceId, sessions))}
          >
            <Trash2 size={14} />
            <span>Delete {count} sessions…</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
