import { useState, useRef, useEffect } from 'react';
import { Archive, ArchiveRestore, FolderGit2, Lock } from 'lucide-react';
import { sessionLabel } from '../../../../shared/sessionLabel';
import { checkoutRef } from '../../../../shared/sessionCheckout';
import { checkoutPathForSession } from '../../../../shared/workspace';
import { useCheckout } from '../../../stores/checkoutStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useSessionModel } from '../../../hooks/useSessionModel';
import { SessionHarnessIcon } from '../SessionHarnessIcon';
import { useWorkspaceStore, type Session } from '../../../stores/workspaceStore';
import { SessionActionsMenu } from '../SessionActionsMenu';
import { startSessionDrag } from '../sessionDrag';
import { deleteSessionCompletely } from '../../../utils/sessionActions';
import { settleWithUndo, unsettleWithUndo } from '../../../utils/settleActions';
import type { Attention } from '../../../../shared/attention';
import { useSessionAttention } from '../../../stores/attentionStore';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useWindowFocusStore } from '../../../stores/windowFocusStore';
import { isSessionViewed } from '../../../utils/viewing';
import { scopeTrail } from '../../../utils/scopeTrail';
import { basename } from '../../../utils/fileUtils';
import { relativeSince } from '../../../utils/relativeSince';
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
  settled: 'settled',
};

/**
 * Which states draw a dot. Only the three that are *about to want something*
 * do — a dot on a calm row is the "persistent status circle when nothing needs
 * attention" PRODUCT.md names as an anti-reference, and at eleven rows it was
 * eleven circles saying nothing.
 */
const MARKED: ReadonlySet<Attention> = new Set<Attention>(['working', 'done', 'needs-attention']);

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
const PAST: ReadonlySet<Attention> = new Set<Attention>(['exited', 'settled']);

/**
 * The row for a session entry: looks its record up by the entry's key, since an
 * entry carries no payload. A session deleted between renders simply has no row.
 */
export function SessionRow(props: RowProps) {
  const id = idOfKey(props.entry.key);
  const session = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === props.workspaceId)?.sessions.find((candidate) => candidate.id === id)
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
}: RowProps & { session: Session }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [newName, setNewName] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const showModel = useSettingsStore((state) => state.showSidebarModel);
  const showHarness = useSettingsStore((state) => state.showSidebarHarness);
  const showWorktree = useSettingsStore((state) => state.showSidebarWorktree);
  const model = useSessionModel(session, showModel);
  // Read from the folder, not the record: a scope can itself be a worktree.
  // Nothing is read at all while the line is switched off.
  const checkoutPath = useWorkspaceStore((state) => {
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
    return workspace ? checkoutPathForSession(workspace, session) : undefined;
  });
  const checkout = useCheckout(showWorktree ? checkoutPath : null);
  const worktreeRef =
    showWorktree && checkout?.kind === 'worktree' ? checkoutRef(checkout) : undefined;
  const shownModel = showModel ? model : undefined;
  // The stored list, resolved in render: a selector building an array would
  // hand React a fresh snapshot on every read. Ids naming a deleted label
  // simply find nothing.
  const allLabels = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === workspaceId)?.labels);
  const labelNames = (allLabels ?? []).filter((label) => session.labelIds?.includes(label.id));

  // While the list mixes scopes each row says which one it runs in; a list
  // filtered to one scope already says it once, in the filter bar.
  const workspace = useWorkspaceStore((state) => state.workspaces.find((candidate) => candidate.id === workspaceId));
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
    session.groupId && worksIn && worksIn !== rowScope?.path && !(showWorktree && checkouts[worksIn]?.kind === 'worktree')
      ? basename(worksIn)
      : undefined;

  const derivedStatus = useSessionAttention(session.id);
  // Exactly what `useViewingReport` reports as viewed, not bare `isActive`: an
  // overlay or an unfocused window is not looking, and its `done` is real.
  const windowFocused = useWindowFocusStore((state) => state.focused);
  const isViewed = useNavigationStore((state) => isSessionViewed(state, session.id, windowFocused));
  const updateSession = useWorkspaceStore((state) => state.updateSession);

  // Whether `done` has been seen is main's call, from what this window reports
  // it is showing and whether it has focus. This does not derive or clear
  // anything: it only hides the dot for the round trip (report, mark seen, the
  // ~100ms broadcast coalesce) on a row the person just opened, which would
  // otherwise flash `done` once. Main's value is untouched.
  const displayStatus: Attention = isViewed && derivedStatus === 'done' ? 'ready' : derivedStatus;
  const statusWord = STATUS_WORDS[displayStatus];
  // The hover action is a toggle: a shelved row offers the way back, so the
  // slot never shows an action that would do nothing.
  const isSettled = displayStatus === 'settled';
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
    age && `last active ${age}`,
    worktreeRef && `worktree ${worktreeRef}`,
    shownModel,
  ]
    .filter(Boolean)
    .join(' — ');

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleRename = async () => {
    const trimmedName = newName.trim();
    try {
      if (trimmedName && trimmedName !== session.name) {
        // A typed name is the user's own and wins permanently: the flag stops
        // the CLI-summary poll from ever overwriting it.
        await updateSession(workspaceId, session.id, {
          name: trimmedName,
          nameIsUserSet: true,
        });
      } else {
        setNewName(session.name);
      }
    } finally {
      // The field closes either way. A rename that failed leaves the old name
      // on screen, which is the truth.
      setIsRenaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleRename();
    } else if (e.key === 'Escape') {
      setNewName(session.name);
      setIsRenaming(false);
    }
  };

  const handleDelete = () => {
    if (window.confirm(`Delete session "${label}"? This will remove the session and its chat history.`)) {
      void deleteSessionCompletely(workspaceId, session);
    }
  };

  const handleStartRename = () => {
    setNewName(session.name);
    setIsRenaming(true);
  };

  // The row activates the session but also hosts the ⋯ actions trigger, and
  // a <button> may not contain another button. A div with role="button"
  // carries the same semantics while keeping the nested trigger valid; the
  // key handler restores the Enter/Space activation a real button gets free.
  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (isRenaming || e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  // Dragging the row onto a label chip assigns that label; the ⋯ menu's label
  // entries are its keyboard twin, so nothing is reachable only by dragging.
  // Renaming turns it off so the pointer can select text in the input, and a
  // conductor is never draggable — its tree is the fleet it orchestrates.
  const draggable = !isRenaming && session.kind !== 'conductor';

  // The meta line carries everything that used to sit on the title's line and
  // eat its width: the glyphs, where the row runs, its state, its age. Rendered
  // whenever it has anything to say, which with an age is always.
  const meta = showHarness || session.kind === 'conductor' || readOnly || scopeLabel || subtitle || statusWord || age;

  return (
    <div
      role="button"
      tabIndex={0}
      className={`session-nav-item ${child ? 'session-nav-item--child' : ''} ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${PAST.has(displayStatus) ? 'session-nav-item--past' : ''}`}
      onClick={isRenaming ? undefined : onClick}
      onKeyDown={handleRowKeyDown}
      onContextMenu={(event) => {
        if (isRenaming) return;
        event.preventDefault();
        event.stopPropagation();
        setActionsOpen(true);
      }}
      draggable={draggable}
      onDragStart={(event) => {
        startSessionDrag(event, session);
        setIsDragging(true);
      }}
      onDragEnd={() => setIsDragging(false)}
      title={accessibleName}
      aria-label={accessibleName}
    >
      {/* A fixed gutter rather than a flow item: the dot comes and goes with the
          state, and the titles must stay in one column whether or not it is there.
          Decorative — the row's aria-label already carries the status, and an
          ancestor's aria-label short-circuits the accessible-name computation
          before it descends into subtree content. */}
      <span className="session-row-gutter" aria-hidden="true">
        {MARKED.has(displayStatus) && (
          <span className={`session-status-indicator session-status-indicator--${displayStatus}`} />
        )}
      </span>
      {isRenaming ? (
        <input
          ref={inputRef}
          type="text"
          className="session-rename-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
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
                  {scopeLabel.parent && <span className="session-nav-item-scope-parent">{scopeLabel.parent} / </span>}
                  <span className="session-nav-item-scope-name">{scopeLabel.label}</span>
                </span>
              )}
              {subtitle && <span className="session-nav-item-subtitle">{subtitle}</span>}
              {statusWord && (
                <span className={`session-status-word session-status-word--${displayStatus}`}>{statusWord}</span>
              )}
              {/* Pushed right by the spacer, so the age keeps one column down
                  the list however much or little precedes it. */}
              <span className="session-row-meta-spacer" />
              {age && <span className="session-row-age">{age}</span>}
            </span>
          )}
          {/* The hero. It owns the full width of the column and may take a
              second line, because what the conversation is about is the one
              thing the list exists to tell you. */}
          <span className="session-nav-item-title">
            <span className="session-nav-item-name">{label}</span>
          </span>
          {(worktreeRef || shownModel || labelNames.length > 0) && (
            <span className="session-nav-item-meta">
              {worktreeRef && (
                <span className="session-nav-item-worktree" title={`Worktree · ${worktreeRef}`}>
                  <FolderGit2 size={11} aria-hidden="true" />
                  <span className="session-nav-item-worktree-ref">{worktreeRef}</span>
                </span>
              )}
              {shownModel && <span className="session-nav-item-model" title={shownModel}>{shownModel}</span>}
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
          <SessionActionsMenu
            open={actionsOpen}
            onOpenChange={setActionsOpen}
            session={session}
            workspaceId={workspaceId}
            onRename={handleStartRename}
            onDelete={handleDelete}
          />
          {/* Settle, not delete. The row's one-click slot belongs to the move a
              person makes constantly and can undo from the toast; destroying a
              session and its history is rare and permanent, so it stays behind
              the ⋯ menu where a mis-aimed click cannot reach it. */}
          <button
            type="button"
            className="nav-row-action"
            aria-label={isSettled ? `Move ${label} back to the list` : `Settle session ${label}`}
            title={isSettled ? 'Move back to the list' : 'Settle — move it to the Settled shelf'}
            onClick={(event) => {
              event.stopPropagation();
              void (isSettled ? unsettleWithUndo : settleWithUndo)(workspaceId, session.id, label);
            }}
          >
            {isSettled ? <ArchiveRestore size={12} aria-hidden="true" /> : <Archive size={12} aria-hidden="true" />}
          </button>
        </div>
      )}
    </div>
  );
}
