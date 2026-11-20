import { useEffect, useState, useRef } from 'react';
import { AlarmClockOff, Check, FolderGit2, FolderSync, Lock, Undo2 } from 'lucide-react';
import { sessionLabel } from '../../../../shared/sessionLabel';
import { checkoutRef } from '../../../../shared/sessionCheckout';
import { checkoutPathForSession } from '../../../../shared/workspace';
import { tildePath } from '../../../utils/displayPath';
import { useCheckout } from '../../../stores/checkoutStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSessionModel } from '../../../hooks/useSessionModel';
import { SessionHarnessIcon } from '../SessionHarnessIcon';
import { RowStatus, isLive } from './RowStatus';
import { useWorkspaceStore, type Session } from '../../../stores/workspaceStore';
import { SessionActionsMenu } from '../SessionActionsMenu';
import { BatchActionsMenu } from '../BatchActionsMenu';
import { useSelectionFrame } from '../../../sidebar/selectionContext';
import { selectionGesture } from '../../../sidebar/selection';
import {
  clearSelection,
  selectRange,
  toggleSelected,
  useSessionSelectionStore,
} from '../../../stores/sessionSelectionStore';
import { isMac } from '../../../utils/platform';
import { idOfKey as sessionIdOfKey } from '../../../sidebar/entries';
import { startSessionDrag } from '../sessionDrag';
import { renameSession } from '../../../utils/sessionActions';
import { SessionNameEditor } from '../../SessionName/SessionNameEditor';
import { markRenaming } from '../../../stores/renamingStore';
import { requestSessionDelete } from '../../Dialogs/DeleteSessionDialog';
import { settleWithUndo, unsettleWithUndo } from '../../../utils/settleActions';
import { WAKE_CAUSE_WORDS, wakeWithUndo } from '../../../utils/snoozeActions';
import { WakeCountdown } from '../../Snooze/WakeCountdown';
import { useSessionUsageLimit } from '../../../stores/usageLimitsStore';
import { formatClock } from '../../../../shared/snooze';
import type { Attention } from '../../../../shared/attention';
import { useSessionAttention } from '../../../stores/attentionStore';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useWindowFocusStore } from '../../../stores/windowFocusStore';
import { isSessionViewed } from '../../../utils/viewing';
import { scopeTrail } from '../../../utils/scopeTrail';
import { basename } from '../../../utils/fileUtils';
import { relativeSince } from '../../../utils/relativeSince';
import { shortModelName } from '../../../utils/harnessMark';
import { useCheckoutStore } from '../../../stores/checkoutStore';
import { hasScopeChoice, filteredScope, useHomeStore } from '../../../stores/homeStore';
import { idOfKey } from '../../../sidebar/entries';
import type { RowProps } from '../../../sidebar/rowRegistry';

/** Spoken form of each status, for the row's accessible name and tooltip. */
const STATUS_LABELS: Record<Attention, string> = {
  working: 'working',
  ready: 'ready',
  'needs-attention': 'needs attention',
  done: 'done',
  exited: 'exited',
  snoozed: 'snoozed',
  settled: 'settled',
};

/**
 * The one state worth a word, and it rides the meta line rather than the title
 * line. `exited` is real information (the process is gone; opening it relaunches)
 * but it is not an alarm, so it reads as quiet prose, not a red badge. Every
 * other state is already said by the bucket the row is sitting in.
 */
const STATUS_WORDS: Partial<Record<Attention, string>> = {
  exited: 'exited',
};

/** States whose title has stopped being live, and reads a step back. */
const PAST: ReadonlySet<Attention> = new Set<Attention>(['exited', 'settled', 'snoozed']);

/**
 * The row for a session entry: looks its record up by the entry's key, since an
 * entry carries no payload. A session deleted between renders simply has no row.
 */
export function SessionRow(props: RowProps) {
  const id = idOfKey(props.entry.key);
  const session = useWorkspaceStore((state) =>
    state.workspaces
      .find((candidate) => candidate.id === props.workspaceId)
      ?.sessions.find((candidate) => candidate.id === id),
  );
  return session ? <SessionRowBody {...props} session={session} /> : null;
}

function SessionRowBody({
  session,
  workspaceId,
  entry,
  active: isActive,
  child,
  onActivate: onClick,
  trailing,
  settle,
  snooze,
  bucket,
}: RowProps & { session: Session }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  /** Where a right-click opened the actions menu, in the row's own box; null opens it at the row's corner. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** Where focus was when the actions menu was asked for; it goes back there on close. */
  const menuReturnFocus = useRef<Element | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  /** Whether the open rename field came from the keyboard, so closing it returns focus to the row. */
  const renameFromKeyboard = useRef(false);
  const showModel = useSettingsStore((state) => state.showSidebarModel);
  const showHarnessSetting = useSettingsStore((state) => state.showSidebarHarness);
  const showWorktree = useSettingsStore((state) => state.showSidebarWorktree);
  // A settled row is finished work, so it says what the session was rather
  // than how it ran: one line, its name and its age, with no harness, model,
  // worktree or labels, whatever the settings say for the rest of the list.
  // An archive is scanned for a name; two-line rows made it a wall.
  // A snoozed row is the same: put away, with only its countdown to say.
  const compact = bucket === 'settled' || bucket === 'snoozed';
  const snoozedUntil = bucket === 'snoozed' ? entry.snoozedUntil : undefined;
  const showHarness = showHarnessSetting && !compact;
  const showWorktreeLine = showWorktree && !compact;
  const model = useSessionModel(session, showModel && !compact);
  // Read from the folder, not the record: a scope can itself be a worktree.
  // Nothing is read at all while the line is switched off.
  const checkoutPath = useWorkspaceStore((state) => {
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
    return workspace ? checkoutPathForSession(workspace, session) : undefined;
  });
  const checkout = useCheckout(showWorktreeLine ? checkoutPath : null);
  const worktreeRef =
    showWorktreeLine && checkout?.kind === 'worktree' ? checkoutRef(checkout) : undefined;
  const shownModel = showModel && !compact ? model : undefined;
  // A state, not decoration: shown on every row, settled ones included,
  // whatever the worktree setting says — a rule removed the folder, and
  // opening the session is what brings it back.
  const removedWorktree = session.removedWorktree;
  // The stored list, resolved in render: a selector building an array would
  // hand React a fresh snapshot on every read. Ids naming a deleted label
  // simply find nothing.
  const allLabels = useWorkspaceStore(
    (state) => state.workspaces.find((candidate) => candidate.id === workspaceId)?.labels,
  );
  const labelNames = (allLabels ?? []).filter((label) => session.labelIds?.includes(label.id));

  // While the list mixes scopes each row says which one it runs in; a list
  // filtered to one scope already says it once, in the filter bar.
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId),
  );
  const scopeFilterId = useHomeStore((state) => state.scopeFilters[workspaceId]);
  const rowScope = workspace?.scopes.find((candidate) => candidate.id === session.scopeId);
  const scopeLabel =
    workspace && !filteredScope(workspace, scopeFilterId) && hasScopeChoice(workspace) && rowScope
      ? scopeTrail(workspace.scopes, rowScope)
      : undefined;
  // A grouped session (a fan-out member) still names the repo it runs in when
  // that folder is not its scope's root, unless the worktree line already names
  // the checkout by branch. Where the agent works wins over where it launched.
  const checkouts = useCheckoutStore((state) => state.byPath);
  const worksIn = session.agentCwd ?? session.cwd;
  const subtitle =
    session.groupId &&
    worksIn &&
    worksIn !== rowScope?.path &&
    !(showWorktree && checkouts[worksIn]?.kind === 'worktree')
      ? basename(worksIn)
      : undefined;

  const derivedStatus = useSessionAttention(session.id);
  const frame = useSelectionFrame();
  const selected = useSessionSelectionStore(
    (state) => state.workspaceId === workspaceId && state.keys.includes(entry.key),
  );
  // Only while this row is part of a selection of several does its menu act on all of them.
  const selectedKeys = useSessionSelectionStore((state) =>
    selected && state.keys.length > 1 ? state.keys : null,
  );
  const selectedSessions = useWorkspaceStore((state) => {
    if (!selectedKeys) return null;
    const sessions = state.workspaces.find((candidate) => candidate.id === workspaceId)?.sessions;
    return sessions ?? null;
  });
  const batch =
    selectedKeys && selectedSessions
      ? selectedKeys
          .map((key) => selectedSessions.find((candidate) => candidate.id === sessionIdOfKey(key)))
          .filter((candidate): candidate is Session => candidate !== undefined)
      : null;
  /** A click: ⌘ toggles the row in the selection, ⇧ extends it, a plain click opens the row and ends it. */
  const handleClick = (event: React.MouseEvent) => {
    const gesture = frame ? selectionGesture(event, isMac) : null;
    if (gesture && frame) {
      event.preventDefault();
      if (gesture === 'toggle') toggleSelected(workspaceId, entry.key, frame.order);
      else selectRange(workspaceId, entry.key, frame.order, frame.openKey);
      return;
    }
    clearSelection();
    onClick();
  };
  // Exactly what `useViewingReport` reports as viewed, not bare `isActive`: an
  // overlay or an unfocused window is not looking, and its `done` is real.
  const windowFocused = useWindowFocusStore((state) => state.focused);
  const isViewed = useNavigationStore((state) => isSessionViewed(state, session.id, windowFocused));

  // Whether `done` has been seen is main's call, from what this window reports
  // it is showing and whether it has focus. This does not derive or clear
  // anything: it only hides the dot for the round trip (report, mark seen, the
  // ~100ms broadcast coalesce) on a row the person just opened, which would
  // otherwise flash `done` once. Main's value is untouched.
  const displayStatus: Attention = isViewed && derivedStatus === 'done' ? 'ready' : derivedStatus;
  // Stopped on its harness's usage limit: said in the status column, over
  // Woke, with the reset when the CLI gave one. Not while it works again.
  const usageLimit = useSessionUsageLimit(session.id);
  const limited = usageLimit && displayStatus !== 'working' && !compact ? usageLimit : undefined;
  const limitWord = limited
    ? `Limited${limited.resetsAt !== undefined ? ` · resets ${formatClock(limited.resetsAt)}` : ''}`
    : undefined;
  // Back from a snooze by itself, until the person looks. A question outranks
  // it (the row already says Waiting), and so does looking at it now.
  const woke =
    entry.wakeMark !== undefined && !isViewed && displayStatus !== 'needs-attention'
      ? entry.wakeMark
      : undefined;
  // The quiet word ("exited") gives way to what the status column already says.
  const statusWord = woke || limited ? undefined : STATUS_WORDS[displayStatus];
  // The hover action is a toggle, and only where it works: the tree decides
  // (`settleOffer`), because a child or a busy session cannot reach the shelf.
  const isSettled = settle?.kind === 'unsettle';
  // Computed at render rather than on a timer: the row already re-renders on
  // every attention broadcast, and a per-row interval for a string that changes
  // once a minute would cost more than it tells anyone.
  const age = entry.activityAt ? relativeSince(entry.activityAt) : undefined;
  // The row reads the derived label — "PR #4118 · Review", "⑂ name". A
  // launched work-item session's `name` is not shown under it: until the CLI
  // summary lands it is the seed prompt Consola sent, which only repeats what
  // the label already says. The only subtitle is where the row belongs, for
  // a row whose place in the list doesn't say so.
  const label = sessionLabel(session);
  // An automation's session and the "Continue with full tools" fork of it
  // share a label, so the lock is what tells them apart.
  const readOnly = session.toolPolicy === 'read-only';
  const readOnlyNote = session.automation?.name
    ? `Read-only · started by ${session.automation.name}`
    : 'Read-only';
  const accessibleName = [
    label,
    scopeLabel && `in ${scopeLabel.parent ? `${scopeLabel.parent} / ` : ''}${scopeLabel.label}`,
    readOnly && 'read-only',
    STATUS_LABELS[displayStatus],
    limitWord,
    !limitWord && woke && `woke: ${WAKE_CAUSE_WORDS[woke]}`,
    age && `last active ${age}`,
    removedWorktree
      ? 'worktree removed, rebuilt when opened'
      : worktreeRef && `worktree ${worktreeRef}`,
    shownModel,
  ]
    .filter(Boolean)
    .join(' — ');

  const handleDelete = () => requestSessionDelete(workspaceId, session, label);

  // Double-click, F2 and the actions menu's Rename all open the one field.
  const startRename = (fromKeyboard: boolean) => {
    renameFromKeyboard.current = fromKeyboard;
    setIsRenaming(true);
  };

  // While the field is open the sidebar keeps this row where it is: a row
  // that changes bucket is mounted afresh, and the field would close with
  // the old one.
  useEffect(() => (isRenaming ? markRenaming(session.id) : undefined), [isRenaming, session.id]);

  // A field opened from the keyboard hands focus back to the row when Enter
  // or Escape closes it, so F2 can be pressed again. One opened by the
  // pointer does not: parking focus on a row nobody tabbed to draws its
  // keyboard ring and holds its Settle pill open.
  const finishRename = () => {
    const row = rowRef.current;
    if (renameFromKeyboard.current && row?.contains(document.activeElement)) row.focus();
    setIsRenaming(false);
  };

  // The double-click's first click has already opened the session, so the
  // field opens while its terminal mounts; SessionNameEditor keeps focus
  // through that. A double-click in a control of the row is that control's,
  // and one React bubbles up from a dialog portaled out of the row is not the
  // row's at all.
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    if (target.closest('button, input, a')) return;
    startRename(false);
  };

  // The row activates the session but also hosts the Settle button, and a
  // <button> may not contain another button. A div with role="button" carries
  // the same semantics while keeping the nested button valid; the key handler
  // restores the Enter/Space activation a real button gets free.
  //
  // The actions menu has no visible trigger, so the keyboard reaches it the
  // way it reaches any context menu: the menu key, or Shift+F10, which macOS
  // does not turn into a contextmenu event on its own.
  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (isRenaming || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    } else if (e.key === 'F2') {
      e.preventDefault();
      startRename(true);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      menuReturnFocus.current = e.currentTarget;
      setMenuAt(null);
      setActionsOpen(true);
    }
  };

  // Dragging the row onto a label chip assigns that label; the actions menu's
  // label entries are its keyboard twin, so nothing is reachable only by dragging.
  // Renaming turns it off so the pointer can select text in the input, and a
  // conductor is never draggable — its tree is the fleet it orchestrates.
  // A snoozed row (a conductor's included) can also be dragged to the list, to wake it.
  const labelable = session.kind !== 'conductor';
  const draggable = !isRenaming && (labelable || bucket === 'snoozed');

  // What is happening now, at the line's trailing edge. `working` counts from
  // the turn's own start — `activityAt` is written on the edge into working —
  // and shows the number instead of an age, because a turn that started eight
  // seconds ago has no meaningful age.
  const live = isLive(displayStatus);
  const showAge = age && displayStatus !== 'working' && !woke && !limited;
  // The meta line carries everything that used to sit on the title's line and
  // eat its width: the glyphs, where the row runs, its state, its age. Rendered
  // whenever it has anything to say, which with an age is always.
  const meta =
    showHarness ||
    shownModel ||
    session.kind === 'conductor' ||
    readOnly ||
    scopeLabel ||
    subtitle ||
    statusWord ||
    live ||
    woke ||
    limited ||
    age;

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      data-entry-key={entry.key}
      className={`session-nav-item ${child ? 'session-nav-item--child' : ''} ${compact ? 'session-nav-item--compact' : ''} ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${PAST.has(displayStatus) ? 'session-nav-item--past' : ''} ${selected ? 'session-nav-item--selected' : ''}`}
      aria-selected={selected || undefined}
      onClick={isRenaming ? undefined : handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleRowKeyDown}
      // A press that is about to open the menu does not move focus onto the
      // row: whatever the person was in (usually the terminal) keeps it, so
      // the menu can hand it back. Ctrl-click is the same request on macOS.
      onMouseDown={(event) => {
        if (!isRenaming && (event.button === 2 || (event.button === 0 && event.ctrlKey)))
          event.preventDefault();
      }}
      onContextMenu={(event) => {
        if (isRenaming) return;
        event.preventDefault();
        event.stopPropagation();
        menuReturnFocus.current = document.activeElement;
        // A right-click outside the selection is about this row alone.
        if (!selected) clearSelection();
        // At the pointer, like a native context menu. Anywhere else, the item
        // that happens to land under it is picked when the button comes up.
        const box = event.currentTarget.getBoundingClientRect();
        setMenuAt({ x: event.clientX - box.left, y: event.clientY - box.top });
        setActionsOpen(true);
      }}
      draggable={draggable}
      onDragStart={(event) => {
        startSessionDrag(event, session, { labelable, snoozed: bucket === 'snoozed' });
        setIsDragging(true);
      }}
      onDragEnd={() => setIsDragging(false)}
      title={accessibleName}
      aria-label={accessibleName}
    >
      {isRenaming ? (
        <SessionNameEditor
          initialName={session.name}
          className="session-rename-input"
          ariaLabel="Rename session"
          onCommit={(name) => renameSession(workspaceId, session, name)}
          onClose={finishRename}
        />
      ) : compact ? (
        // One line: the name, then the lock where it applies, then the age.
        // The lock trails so every name on the shelf starts on one edge. The
        // age keeps the trailing column every other row's age sits in, and
        // steps aside for Restore on hover exactly as it does for Settle.
        <span className="session-nav-item-text">
          <span className="session-nav-item-title">
            <span className="session-nav-item-name">{label}</span>
          </span>
          {readOnly && (
            <span className="session-nav-item-read-only" title={readOnlyNote}>
              <Lock size={10} aria-hidden="true" />
            </span>
          )}
          {/* One line on the shelf, so the removed worktree is a mark beside
              the lock, with its sentence in the tooltip. */}
          {removedWorktree && (
            <span
              className="session-nav-item-worktree-removed-mark"
              title="Worktree removed · rebuilt when opened"
            >
              <FolderSync size={10} aria-hidden="true" />
            </span>
          )}
          {snoozedUntil !== undefined ? (
            <WakeCountdown until={snoozedUntil} />
          ) : (
            age && <span className="session-row-age">{age}</span>
          )}
        </span>
      ) : (
        <span className="session-nav-item-text">
          {meta && (
            <span className="session-row-meta">
              {session.kind === 'conductor' && (
                <span className="session-conductor-glyph" aria-hidden>
                  🧠
                </span>
              )}
              {showHarness && <SessionHarnessIcon harnessId={session.harnessId} />}
              {/* How it runs, read together: the harness, then the model it
                  talks to, said the way a person says it. The id is in the
                  tooltip. */}
              {shownModel && (
                <span className="session-nav-item-model" title={shownModel}>
                  {shortModelName(shownModel)}
                </span>
              )}
              {readOnly && (
                <span
                  className="session-nav-item-read-only"
                  title={`${readOnlyNote}. Open it and choose “Continue with full tools” to make changes.`}
                >
                  <Lock size={10} aria-hidden="true" />
                </span>
              )}
              {scopeLabel && (
                <span className="session-nav-item-scope">
                  {scopeLabel.parent && (
                    <span className="session-nav-item-scope-parent">{scopeLabel.parent} / </span>
                  )}
                  <span className="session-nav-item-scope-name">{scopeLabel.label}</span>
                </span>
              )}
              {subtitle && <span className="session-nav-item-subtitle">{subtitle}</span>}
              {/* Pushed right by the spacer, so what a row is doing — and the
                  age where it is doing nothing — keeps one column down the
                  list however much or little precedes it. Keyed on the status,
                  so each change is a fresh element and replays its arrival
                  instead of mutating the words under the person's eyes.
                  "exited" rides in the same column, before the age, where it
                  reads as "exited 47m" rather than running into the model. */}
              <span className="session-row-meta-spacer" />
              {limitWord && (
                <span
                  className="session-row-status session-row-status--limited"
                  title="Stopped on its harness's usage limit"
                >
                  <span className="session-row-status-word">{limitWord}</span>
                </span>
              )}
              {!limitWord && live && !(woke && displayStatus !== 'working') && (
                <RowStatus key={displayStatus} status={displayStatus} since={entry.activityAt} />
              )}
              {!limitWord && woke && displayStatus !== 'working' && (
                <span
                  className="session-row-status session-row-status--woke"
                  title={WAKE_CAUSE_WORDS[woke]}
                >
                  <span className="session-row-status-mark" aria-hidden="true" />
                  <span className="session-row-status-word">Woke</span>
                </span>
              )}
              {(statusWord || showAge) && (
                <span className="session-row-age">
                  {statusWord && (
                    <span className={`session-status-word session-status-word--${displayStatus}`}>
                      {statusWord}{' '}
                    </span>
                  )}
                  {showAge && age}
                </span>
              )}
            </span>
          )}
          {/* The hero. It owns the full width of the column and may take a
              second line, because what the conversation is about is the one
              thing the list exists to tell you. */}
          <span className="session-nav-item-title">
            <span className="session-nav-item-name">{label}</span>
          </span>
          {(worktreeRef || removedWorktree || labelNames.length > 0) && (
            <span className="session-nav-item-meta">
              {removedWorktree ? (
                <span
                  className="session-nav-item-worktree session-nav-item-worktree-removed"
                  title={`Its worktree was removed. Opening this session rebuilds it at ${tildePath(removedWorktree.path)}, on ${removedWorktree.branch ?? removedWorktree.commit.slice(0, 7)}.`}
                >
                  <FolderSync size={11} aria-hidden="true" />
                  <span className="session-nav-item-worktree-ref">
                    Worktree removed · rebuilt when opened
                  </span>
                </span>
              ) : (
                worktreeRef && (
                  <span className="session-nav-item-worktree" title={`Worktree · ${worktreeRef}`}>
                    <FolderGit2 size={11} aria-hidden="true" />
                    <span className="session-nav-item-worktree-ref">{worktreeRef}</span>
                  </span>
                )
              )}
              {labelNames.map((item) => (
                <span key={item.id} className="session-nav-item-label">
                  {item.emoji ? `${item.emoji} ` : ''}
                  {item.name}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
      {trailing}
      {!isRenaming && (
        <div className="nav-row-actions" data-open={actionsOpen || undefined}>
          {/* Settle, not delete. The row's one-click slot belongs to the move a
              person makes constantly and can undo from the toast; destroying a
              session and its history is rare and permanent, so it stays in the
              row's right-click menu where a mis-aimed click cannot reach it. */}
          {/* On the Snoozed shelf the one-click move is Wake, in Settle's place. */}
          {bucket === 'snoozed' && snooze?.kind === 'wake' && (
            <button
              type="button"
              className="session-settle-action"
              aria-label={`Wake ${label}`}
              title="Wake — bring it back to the list now"
              onClick={(event) => {
                event.stopPropagation();
                void wakeWithUndo(workspaceId, [session.id], { [session.id]: label });
              }}
            >
              <AlarmClockOff size={12} aria-hidden="true" />
              <span>Wake</span>
            </button>
          )}
          {bucket !== 'snoozed' && (settle?.kind === 'settle' || settle?.kind === 'unsettle') && (
            <button
              type="button"
              className="session-settle-action"
              aria-label={isSettled ? `Move ${label} back to the list` : `Settle session ${label}`}
              title={isSettled ? 'Move back to the list' : 'Settle — move it to the Settled shelf'}
              onClick={(event) => {
                event.stopPropagation();
                void (isSettled ? unsettleWithUndo : settleWithUndo)(
                  workspaceId,
                  session.id,
                  label,
                );
              }}
            >
              {isSettled ? (
                <Undo2 size={12} aria-hidden="true" />
              ) : (
                <Check size={12} aria-hidden="true" />
              )}
              <span>{isSettled ? 'Restore' : 'Settle'}</span>
            </button>
          )}
        </div>
      )}
      {!isRenaming && batch && batch.length > 1 && (
        <BatchActionsMenu
          open={actionsOpen}
          onOpenChange={setActionsOpen}
          at={menuAt}
          returnFocus={menuReturnFocus}
          workspaceId={workspaceId}
          sessions={batch}
        />
      )}
      {!isRenaming && !(batch && batch.length > 1) && (
        <SessionActionsMenu
          open={actionsOpen}
          onOpenChange={setActionsOpen}
          at={menuAt}
          returnFocus={menuReturnFocus}
          session={session}
          workspaceId={workspaceId}
          // A menu opened from the keyboard has no pointer position.
          onRename={() => startRename(menuAt === null)}
          onDelete={handleDelete}
          settle={settle}
          snooze={snooze}
          label={label}
          limitResetsAt={usageLimit?.resetsAt}
        />
      )}
    </div>
  );
}
