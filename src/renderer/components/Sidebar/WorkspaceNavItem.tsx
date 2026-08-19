import * as Collapsible from '@radix-ui/react-collapsible';
import { Folder, GitBranch, ChevronRight, ChevronDown, Plus } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { WorkspaceActionsMenu } from './WorkspaceActionsMenu';
import { SessionNavItem } from './SessionNavItem';
import { activateSession, createQuickSession } from '../../utils/sessionActions';

interface WorkspaceNavItemProps {
  workspace: Workspace;
}

export function WorkspaceNavItem({ workspace }: WorkspaceNavItemProps) {
  const isExpanded = useNavigationStore((state) => state.isWorkspaceExpanded(workspace.id));
  const toggleExpanded = useNavigationStore((state) => state.toggleWorkspaceExpanded);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const setActiveWorkspace = useNavigationStore((state) => state.setActiveWorkspace);

  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);

  const isActive = activeWorkspaceId === workspace.id && activeSessionId === null;

  // Only show sessions with non-empty names (sessions appear after name is generated)
  const visibleSessions = workspace.sessions?.filter(s => s.name.length > 0) ?? [];

  const handleChevronClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleExpanded(workspace.id);
  };

  const handleClick = () => {
    setActiveWorkspace(workspace.id);
  };

  const handleDelete = async () => {
    await deleteWorkspace(workspace.id);
    // Only after the record is actually gone: a failed delete should leave the
    // workspace both on screen and selected.
    if (activeWorkspaceId === workspace.id) {
      setActiveWorkspace(null);
    }
  };

  const handleAddSession = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Quick-add takes the workspace's default harness; the picker on the
    // new-session screen is where another one gets chosen. Selecting the new
    // session sets workspace and session together -- doing it in two steps
    // would clear the session again, since setActiveWorkspace resets it.
    void createQuickSession(workspace.id);
  };

  const handleSessionClick = (sessionId: string) => {
    activateSession(workspace.id, sessionId);
  };

  return (
    <Collapsible.Root open={isExpanded} onOpenChange={() => toggleExpanded(workspace.id)}>
      <div className={`workspace-nav-item-container ${isActive ? 'active' : ''}`}>
        <button
          className="workspace-expand-toggle"
          onClick={handleChevronClick}
          aria-label={isExpanded ? 'Collapse workspace' : 'Expand workspace'}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          className="nav-item workspace-nav-item"
          onClick={handleClick}
        >
          <span className="nav-item-icon">
            {workspace.isGitRepo ? <GitBranch size={16} /> : <Folder size={16} />}
          </span>
          <span className="nav-item-label">{workspace.name}</span>
        </button>
        <WorkspaceActionsMenu
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          onDelete={handleDelete}
        />
        <button
          className="workspace-add-session"
          onClick={handleAddSession}
          aria-label="New session"
        >
          <Plus size={14} />
        </button>
      </div>
      <Collapsible.Content className="workspace-collapsible-content">
        <div className="workspace-sessions-list">
          {visibleSessions.map((session) => (
            <SessionNavItem
              key={session.id}
              session={session}
              workspaceId={workspace.id}
              isActive={activeWorkspaceId === workspace.id && activeSessionId === session.id}
              onClick={() => handleSessionClick(session.id)}
            />
          ))}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
