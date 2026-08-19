import { useState, useRef, useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore, type Session } from '../../stores/workspaceStore';
import { SessionActionsMenu } from './SessionActionsMenu';
import { deleteSessionCompletely } from '../../utils/sessionActions';

interface SessionNavItemProps {
  session: Session;
  workspaceId: string;
  isActive: boolean;
  onClick: () => void;
}

export function SessionNavItem({
  session,
  workspaceId,
  isActive,
  onClick,
}: SessionNavItemProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Activity is inferred from terminal output, so the only states Consola can
  // distinguish are "Claude is producing output" and "Claude has exited".
  const sessionStatus = useTerminalStore((state) => {
    const terminal = state.terminals[session.instanceId];
    if (!terminal) return null;

    // Priority: Exited > Awaiting a keypress > Working > None
    if (terminal.hasExited) return 'error';
    if (terminal.isAwaitingConfirmation) return 'attention';
    if (terminal.isBusy) return 'running';
    return null;
  });
  const updateSession = useWorkspaceStore((state) => state.updateSession);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleRename = async () => {
    const trimmedName = newName.trim();
    if (trimmedName && trimmedName !== session.name) {
      await updateSession(workspaceId, session.id, { name: trimmedName });
    } else {
      setNewName(session.name);
    }
    setIsRenaming(false);
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

  return (
    <button
      className={`session-nav-item session-nav-item--indent-1 ${isActive ? 'active' : ''}`}
      onClick={isRenaming ? undefined : onClick}
    >
      <span className="session-nav-item-icon">
        <MessageSquare size={14} />
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
        <span className="session-nav-item-name">{session.name}</span>
      )}
      {sessionStatus && (
        <span className={`session-status-indicator session-status-indicator--${sessionStatus}`} />
      )}
      {!isRenaming && (
        <SessionActionsMenu
          sessionName={session.name}
          onRename={handleStartRename}
          onDelete={handleDelete}
        />
      )}
    </button>
  );
}
