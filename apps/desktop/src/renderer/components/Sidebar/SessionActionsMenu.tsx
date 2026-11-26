import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  Check,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  Unlink,
} from 'lucide-react';
import type { Label, Session } from '../../../shared/workspace';
import { canRegenerateTitle } from '../../../shared/sessionTitles';
import { useHarnessStore } from '../../stores/harnessStore';
import { regenerateTitle, useTitleRegenerationStore } from '../../stores/titleRegenerationStore';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { NewLabelDialog } from '../Dialogs/NewLabelDialog';
import { SwitchHarnessDialog } from '../Dialogs/SwitchHarnessDialog';
import { settleWithUndo, unsettleWithUndo } from '../../utils/settleActions';
import { worktreeCleanupBridge } from '../../services/worktreeCleanupBridge';
import type { SettleOffer } from '../../sidebar/settleRules';
import type { SnoozeOffer } from '../../sidebar/snoozeRules';
import { snoozeWithUndo, wakeWithUndo } from '../../utils/snoozeActions';
import { formatClock } from '../../../shared/snooze';
import { SnoozeMenuItems } from '../Snooze/SnoozeMenuItems';

/** Stable identity: a fresh [] from the selector would re-render every tick. */
const EMPTY_LABELS: Label[] = [];

interface SessionActionsMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Where to open, in the row's own box: the pointer of the right-click that
   * asked. Null (the keyboard) opens it under the row's top-right corner.
   */
  at: { x: number; y: number } | null;
  /**
   * What had focus when the menu was asked for, so closing it hands focus
   * back there: the row when the menu key opened it, the terminal the person
   * was typing in when a right-click did. Written by the row as it opens.
   */
  returnFocus: MutableRefObject<Element | null>;
  session: Session;
  workspaceId: string;
  onRename: () => void;
  onDelete: () => void;
  /** What this row may do about the Settled shelf; absent offers nothing. */
  settle?: SettleOffer;
  /** What this row may do about the Snoozed shelf; absent offers nothing. */
  snooze?: SnoozeOffer;
  /** The name the row shows, for toasts. */
  label?: string;
  /** When this session's usage limit resets, when it is stopped on one and the CLI said. */
  limitResetsAt?: number;
}

/**
 * A sidebar row's actions menu, opened from the row (right-click or the menu
 * key): rename, regroup, switch harness, link or unlink, delete.
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
export function SessionActionsMenu({
  session,
  workspaceId,
  onRename,
  onDelete,
  open,
  onOpenChange,
  at,
  returnFocus,
  settle,
  snooze,
  label,
  limitResetsAt,
}: SessionActionsMenuProps) {
  const inManagedWorktree = useManagedWorktree(session, open);
  const bound = useWorkspaceStore((state) =>
    Boolean(state.workspaces.find((candidate) => candidate.id === workspaceId)?.provider),
  );
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const labels =
    useWorkspaceStore(
      (state) => state.workspaces.find((candidate) => candidate.id === workspaceId)?.labels,
    ) ?? EMPTY_LABELS;
  const assignLabel = useWorkspaceStore((state) => state.assignLabel);
  const unassignLabel = useWorkspaceStore((state) => state.unassignLabel);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId),
  );
  const harnesses = useHarnessStore((state) => state.harnesses);
  const regenerating = useTitleRegenerationStore((state) => state.running[session.id] === true);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [switchingHarness, setSwitchingHarness] = useState(false);
  // Selecting "Link to work item..." opens a dialog; the menu refocusing
  // its trigger would race the dialog's own focus grab (WorkspaceSwitcher
  // has the same guard for Delete).
  const openingDialog = useRef(false);
  const anchorRef = useRef<HTMLSpanElement>(null);

  const handleLink = () => {
    openingDialog.current = true;
    useLinkSessionDialogStore.getState().open({ kind: 'pick-item', workspaceId, session });
  };

  // The one write permitted on `parentSessionId`, and the reason it is
  // permitted: the v8 migration infers the link from a session merely sharing
  // a group with a conductor, and a child settles only with its conductor and
  // is drawn into Waiting by any sibling's question. Without this the only
  // escape from a wrong guess would be deleting the session. Clearing is all
  // it does: nothing anywhere can set the field, so a detached session cannot
  // be re-parented by hand.
  const handleDetach = () => {
    void updateSession(workspaceId, session.id, { parentSessionId: undefined }).catch(
      (error: unknown) => {
        // The row visibly staying under its conductor is the signal.
        console.error('Failed to detach session', error);
      },
    );
  };

  const handleUnlink = () => {
    // Presence semantics: the key is sent, and undefined, which is what
    // main reads as "clear the link" — exactly as leaving a group works.
    void updateSession(workspaceId, session.id, { workItem: undefined }).catch((error: unknown) => {
      // The row visibly staying linked is the signal.
      console.error('Failed to unlink session', error);
    });
  };

  const handleNewLabel = () => {
    openingDialog.current = true;
    setCreatingLabel(true);
  };

  const handleSwitchHarness = () => {
    openingDialog.current = true;
    setSwitchingHarness(true);
  };

  const canLink = bound && session.kind !== 'conductor';

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      {/* Not a button: the menu opens from the row itself (right-click, or the
          menu key while the row has focus), so a visible ⋯ would only crowd the
          corner Settle lives in. Radix still needs a box to place the menu
          against: this invisible one, at the pointer or the row's corner. */}
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
          // From the pointer the menu starts just past it, so releasing the
          // button that opened it lands on no item.
          sideOffset={at ? 2 : 4}
          align={at ? 'start' : 'end'}
          // The menu is portaled, but React still bubbles its clicks to the row
          // it belongs to, which would open the session the person only meant
          // to rename or settle (and start its terminal, which takes the focus).
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            const previous = returnFocus.current;
            returnFocus.current = null;
            if (openingDialog.current) {
              event.preventDefault();
              openingDialog.current = false;
              return;
            }
            // Radix would hand focus to the anchor, which cannot take it. Focus
            // goes back where it came from instead. A right-click from the
            // terminal returns to the terminal: parking it on the row drew the
            // keyboard ring around a row nobody had tabbed to, and held its
            // Settle pill open over its age until something else took focus.
            // A row swapped out for the rename field keeps the field focused.
            const row = anchorRef.current?.closest<HTMLElement>('.session-nav-item');
            if (!row) return;
            event.preventDefault();
            if (
              previous instanceof HTMLElement &&
              previous !== document.body &&
              previous.isConnected
            ) {
              previous.focus({ preventScroll: true });
            } else if (!at) {
              // Opened from the keyboard, with nothing to return to: the row,
              // so a keyboard user is not left on <body>.
              row.focus();
            }
          }}
        >
          <DropdownMenu.Item className="dropdown-item" onSelect={onRename}>
            <Pencil size={14} />
            <span>Rename</span>
          </DropdownMenu.Item>
          {workspace && canRegenerateTitle(workspace, session, harnesses) && (
            <DropdownMenu.Item
              className="dropdown-item"
              disabled={regenerating}
              onSelect={() => void regenerateTitle(workspaceId, session.id)}
            >
              <RefreshCw size={14} />
              <span>{regenerating ? 'Regenerating…' : 'Regenerate title'}</span>
            </DropdownMenu.Item>
          )}
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
                        void write(workspaceId, session.id, label.id).catch((error: unknown) => {
                          console.error('Failed to change session label', error);
                        });
                      }}
                    >
                      {on ? <Check size={14} /> : <Tag size={14} />}
                      <span>
                        {label.emoji ? `${label.emoji} ` : ''}
                        {label.name}
                      </span>
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
          {/* Snooze follows Labels: both file the session away, one for a while. */}
          {snooze?.kind === 'wake' && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() =>
                void wakeWithUndo(workspaceId, [session.id], {
                  [session.id]: label ?? session.name,
                })
              }
            >
              <AlarmClockOff size={14} />
              <span>Wake</span>
            </DropdownMenu.Item>
          )}
          {snooze?.kind === 'snooze' &&
            limitResetsAt !== undefined &&
            limitResetsAt > Date.now() && (
              <DropdownMenu.Item
                className="dropdown-item"
                onSelect={() =>
                  void snoozeWithUndo(
                    workspaceId,
                    [session.id],
                    { untilLimitResets: true },
                    { [session.id]: label ?? session.name },
                  )
                }
              >
                <AlarmClockOff size={14} />
                <span>Snooze until limit resets · {formatClock(limitResetsAt)}</span>
              </DropdownMenu.Item>
            )}
          {(snooze?.kind === 'snooze' || snooze?.kind === 'wake') && (
            <SnoozeMenuItems
              workspaceId={workspaceId}
              sessionIds={[session.id]}
              names={{ [session.id]: label ?? session.name }}
              onOpenDialog={() => {
                openingDialog.current = true;
              }}
              title={snooze.kind === 'wake' ? 'Snooze until another time' : 'Snooze'}
            />
          )}
          {snooze?.kind === 'blocked' && (
            <DropdownMenu.Item className="dropdown-item" disabled title={snooze.reason}>
              <AlarmClockOff size={14} />
              <span>Snooze · {snooze.reason}</span>
            </DropdownMenu.Item>
          )}
          {/* Conductors stay on their harness; main refuses them too. */}
          {session.kind === 'interactive' && (
            <DropdownMenu.Item className="dropdown-item" onSelect={handleSwitchHarness}>
              <ArrowLeftRight size={14} />
              <span>Switch harness…</span>
            </DropdownMenu.Item>
          )}
          {settle?.kind === 'unsettle' && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => void unsettleWithUndo(workspaceId, session.id, session.name)}
            >
              <ArchiveRestore size={14} />
              <span>Move back to list</span>
            </DropdownMenu.Item>
          )}
          {settle?.kind === 'settle' && (
            <DropdownMenu.Item
              className="dropdown-item"
              onSelect={() => void settleWithUndo(workspaceId, session.id, session.name)}
            >
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
              void updateSession(workspaceId, session.id, {
                autoSettle: keep ? 'never' : undefined,
              }).catch((error: unknown) => {
                console.error('Failed to change auto-settle', error);
              });
            }}
          >
            <span className="navigation-settings-check">
              <DropdownMenu.ItemIndicator>
                <Check size={14} />
              </DropdownMenu.ItemIndicator>
            </span>
            <span>Never auto-settle</span>
          </DropdownMenu.CheckboxItem>
          {inManagedWorktree && (
            <DropdownMenu.CheckboxItem
              className="dropdown-item"
              checked={session.autoRemoveWorktree === 'never'}
              onCheckedChange={(keep) => {
                void updateSession(workspaceId, session.id, {
                  autoRemoveWorktree: keep ? 'never' : undefined,
                }).catch((error: unknown) => {
                  console.error('Failed to change worktree cleanup', error);
                });
              }}
            >
              <span className="navigation-settings-check">
                <DropdownMenu.ItemIndicator>
                  <Check size={14} />
                </DropdownMenu.ItemIndicator>
              </span>
              <span>Never remove this worktree</span>
            </DropdownMenu.CheckboxItem>
          )}
          {session.parentSessionId && (
            <DropdownMenu.Item className="dropdown-item" onSelect={handleDetach}>
              <Unlink size={14} />
              <span>Detach from conductor</span>
            </DropdownMenu.Item>
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
      {switchingHarness && (
        <SwitchHarnessDialog
          workspaceId={workspaceId}
          session={session}
          onClose={() => setSwitchingHarness(false)}
        />
      )}
    </DropdownMenu.Root>
  );
}

/**
 * Whether the session runs in one of Consola's own worktrees — the only kind
 * a cleanup rule ever removes, so the only kind the opt-out means anything
 * for. Asked when the menu opens; a session whose worktree was removed is one.
 */
function useManagedWorktree(session: Session, open: boolean): boolean {
  const [managed, setManaged] = useState(false);
  const dir = session.cwd;
  const removed = session.removedWorktree !== undefined;
  useEffect(() => {
    if (!open || removed || !dir) return;
    let live = true;
    void worktreeCleanupBridge.isManaged(dir).then((answer) => {
      if (live) setManaged(answer);
    });
    return () => {
      live = false;
    };
  }, [open, dir, removed]);
  return removed || managed;
}
