import { useState, useRef, useEffect } from 'react';
import { sessionLabel, sessionSubtitle } from '../../../shared/sessionLabel';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore, type Session } from '../../stores/workspaceStore';
import { SessionActionsMenu } from './SessionActionsMenu';
import { startSessionDrag } from './sessionDrag';
import { deleteSessionCompletely } from '../../utils/sessionActions';
import { sessionStatusFor, type SessionStatus } from '../../utils/sessionStatus';

interface SessionNavItemProps {
  session: Session;
  workspaceId: string;
  isActive: boolean;
  onClick: () => void;
  /** Rendered under the name — the scope a grouped session belongs to. */
  subtitle?: string;
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
}: SessionNavItemProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [newName, setNewName] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

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
  // The row reads the derived label — "PR #4118 · Review", "⑂ name" — and
  // shows `name` underneath only when the label stopped saying it. A group
  // member's runs-in subtitle joins it rather than replacing it.
  const label = sessionLabel(session);
  const subtitleText = [sessionSubtitle(session), subtitle].filter(Boolean).join(' · ');
  const accessibleName = `${label} — ${STATUS_LABELS[displayStatus]}`;

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
    void deleteSessionCompletely(workspaceId, session);
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

  // Dragging the row onto a group header moves it there; the ⋯ menu's "Move
  // to group" does the same thing from the keyboard, so nothing is reachable
  // only by dragging. Renaming turns it off so the pointer can select text in
  // the input, and a conductor is never draggable — its group is the fleet it
  // orchestrates, not a folder it happens to sit in.
  const draggable = !isRenaming && session.kind !== 'conductor';

  return (
    <div
      role="button"
      tabIndex={0}
      className={`session-nav-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      onClick={isRenaming ? undefined : onClick}
      onKeyDown={handleRowKeyDown}
      draggable={draggable}
      onDragStart={(event) => {
        startSessionDrag(event, session.id);
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
          <span className="session-nav-item-name">{label}</span>
          {subtitleText && <span className="session-nav-item-subtitle">{subtitleText}</span>}
        </span>
      )}
      {!isRenaming && statusWord && (
        <span className={`session-status-word session-status-word--${displayStatus}`} aria-hidden="true">
          {statusWord}
        </span>
      )}
      {!isRenaming && (
        <SessionActionsMenu
          session={session}
          workspaceId={workspaceId}
          onRename={handleStartRename}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
