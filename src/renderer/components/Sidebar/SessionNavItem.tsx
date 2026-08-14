import { useState, useRef, useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore, type Session } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { SessionActionsMenu } from './SessionActionsMenu';
import { terminalBridge } from '../../services/terminalBridge';

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
  const removeTerminalInstance = useTerminalStore((state) => state.removeInstance);

  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const deleteSession = useWorkspaceStore((state) => state.deleteSession);

  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const setActiveSession = useNavigationStore((state) => state.setActiveSession);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleRename = () => {
    const trimmedName = newName.trim();
    if (trimmedName && trimmedName !== session.name) {
      updateSession(workspaceId, session.id, { name: trimmedName });
    } else {
      setNewName(session.name);
    }
    setIsRenaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRename();
    } else if (e.key === 'Escape') {
      setNewName(session.name);
      setIsRenaming(false);
    }
  };

  const handleDelete = () => {
    // Closing a session is what kills its terminal; unmounting does not.
    terminalBridge.destroy(session.instanceId);
    removeTerminalInstance(session.instanceId);

    // Remove from store. The conversation itself stays in Claude's own session
    // files and remains reachable through `claude --resume`.
    deleteSession(workspaceId, session.id);

    // Clear active session if this was it
    if (activeSessionId === session.id) {
      setActiveSession(null);
    }
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
