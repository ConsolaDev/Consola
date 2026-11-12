import { useState, useRef, useEffect } from 'react';
import { FolderGit2, Lock, X } from 'lucide-react';
import { sessionLabel } from '../../../shared/sessionLabel';
import { checkoutRef } from '../../../shared/sessionCheckout';
import { checkoutPathForSession } from '../../../shared/workspace';
import { useCheckout } from '../../stores/checkoutStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionModel } from '../../hooks/useSessionModel';
import { SessionHarnessIcon } from './SessionHarnessIcon';
import { useWorkspaceStore, type Session } from '../../stores/workspaceStore';
import { SessionActionsMenu } from './SessionActionsMenu';
import { startSessionDrag } from './sessionDrag';
import { deleteSessionCompletely } from '../../utils/sessionActions';
import { sessionStatusFor, type SessionStatus } from '../../utils/sessionStatus';
import type { ScopeTrail } from '../../utils/scopeTrail';

interface SessionNavItemProps {
  session: Session;
  workspaceId: string;
  isActive: boolean;
  onClick: () => void;
  /**
   * Rendered under the name *instead of* the session's own name — the scope a
   * grouped session belongs to.
   */
  subtitle?: string;
  /**
   * The scope the session runs in, on a small line above the title. Set only
   * while the list mixes scopes; a filtered list already says which one.
   */
  scopeLabel?: ScopeTrail;
}

/** Spoken form of each status, for the row's accessible name and tooltip. */
const STATUS_LABELS: Record<SessionStatus, string> = {
  working: 'working',
  ready: 'ready',
  'needs-attention': 'needs attention',
  done: 'done',
  exited: 'exited',
};

/**
 * The trailing status word. Only the states that want a human get one —
 * calm rows are carried by the dot alone, so the list stays quiet.
 */
const STATUS_WORDS: Partial<Record<SessionStatus, string>> = {
  'needs-attention': 'attention',
  exited: 'exited',
};

export function SessionNavItem({
  session,
  workspaceId,
  isActive,
  onClick,
  subtitle,
  scopeLabel,
}: SessionNavItemProps) {
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

  const sessionStatus = useTerminalStore((state) =>
    sessionStatusFor(state.terminals[session.instanceId])
  );
  const acknowledgeCompletion = useTerminalStore((state) => state.acknowledgeCompletion);
  const updateSession = useWorkspaceStore((state) => state.updateSession);

  // `done` means "finished while you were elsewhere" — being the active row is
  // being looked at, so the completion stops being news the moment it lands.
  useEffect(() => {
    if (isActive && sessionStatus === 'done') {
      acknowledgeCompletion(session.instanceId);
    }
  }, [isActive, sessionStatus, session.instanceId, acknowledgeCompletion]);

  // Rendered status, not stored status: the effect above clears the flag only
  // after paint, and the active row must never flash `done` for that frame.
  const displayStatus: SessionStatus =
    isActive && sessionStatus === 'done' ? 'ready' : sessionStatus;
  const statusWord = STATUS_WORDS[displayStatus];
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

  // Dragging the row onto a group header moves it there, and dragging a
  // grouped row back onto its own scope row takes it out again — one gesture
  // both ways. The ⋯ menu's "Move to group" and "Remove from group" are the
  // keyboard twins of each, so nothing is reachable only by dragging.
  // Renaming turns it off so the pointer can select text in the input, and a
  // conductor is never draggable — its group is the fleet it orchestrates,
  // not a folder it happens to sit in.
  const draggable = !isRenaming && session.kind !== 'conductor';

  return (
    <div
      role="button"
      tabIndex={0}
      // The rename field replaces the scope line too, so the row is a plain one while it shows.
      className={`session-nav-item ${scopeLabel && !isRenaming ? 'session-nav-item--scoped' : ''} ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
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
      {/* Decorative: the button's aria-label already carries the status, and
          an ancestor's aria-label short-circuits the accessible-name
          computation before it descends into subtree content. */}
      <span
        className={`session-status-indicator session-status-indicator--${displayStatus}`}
        aria-hidden="true"
      />
      {session.kind === 'conductor' && (
        <span className="session-conductor-glyph" aria-hidden>
          🧠
        </span>
      )}
      {showHarness && <SessionHarnessIcon harnessId={session.harnessId} />}
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
          {scopeLabel && (
            <span className="session-nav-item-scope">
              {scopeLabel.parent && <span className="session-nav-item-scope-parent">{scopeLabel.parent} / </span>}
              <span className="session-nav-item-scope-name">{scopeLabel.label}</span>
            </span>
          )}
          <span className="session-nav-item-title">
            {readOnly && (
              <span
                className="session-nav-item-read-only"
                title={`${readOnlyNote}. Open it and choose “Continue with full tools” to make changes.`}
              >
                <Lock size={11} aria-hidden="true" />
              </span>
            )}
            <span className="session-nav-item-name">{label}</span>
          </span>
          {subtitle &&<span className="session-nav-item-subtitle">{subtitle}</span>}
          {/* Worktree and model share a line when both fit, and wrap when not. */}
          {(worktreeRef || shownModel) && (
            <span className="session-nav-item-meta">
              {worktreeRef && (
                <span className="session-nav-item-worktree" title={`Worktree · ${worktreeRef}`}>
                  <FolderGit2 size={11} aria-hidden="true" />
                  <span className="session-nav-item-worktree-ref">{worktreeRef}</span>
                </span>
              )}
              {shownModel && (
                <span className="session-nav-item-model" title={shownModel}>{shownModel}</span>
              )}
            </span>
          )}
        </span>
      )}
      {!isRenaming && statusWord && (
        <span className={`session-status-word session-status-word--${displayStatus}`} aria-hidden="true">
          {statusWord}
        </span>
      )}
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
          <button
            type="button"
            className="nav-row-action"
            aria-label={`Delete session ${label}`}
            title="Delete session"
            onClick={(event) => {
              event.stopPropagation();
              handleDelete();
            }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
