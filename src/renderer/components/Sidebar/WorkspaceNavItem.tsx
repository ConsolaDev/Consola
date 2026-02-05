import * as Collapsible from '@radix-ui/react-collapsible';
import { Folder, GitBranch, ChevronRight, ChevronDown, Plus } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { WorkspaceActionsMenu } from './WorkspaceActionsMenu';
import { SessionNavItem } from './SessionNavItem';

interface WorkspaceNavItemProps {
  workspace: Workspace;
}

function generateSessionInstanceId(workspaceId: string): string {
  const sessionId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  return `workspace-${workspaceId}-session-${sessionId}`;
}

export function WorkspaceNavItem({ workspace }: WorkspaceNavItemProps) {
  const isExpanded = useNavigationStore((state) => state.isWorkspaceExpanded(workspace.id));
  const toggleExpanded = useNavigationStore((state) => state.toggleWorkspaceExpanded);
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const setActiveWorkspace = useNavigationStore((state) => state.setActiveWorkspace);
  const setActiveSession = useNavigationStore((state) => state.setActiveSession);

  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);
  const createSession = useWorkspaceStore((state) => state.createSession);

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

  const handleDelete = () => {
    // If this workspace is active, clear selection
    if (activeWorkspaceId === workspace.id) {
      setActiveWorkspace(null);
    }
    deleteWorkspace(workspace.id);
  };

  const handleAddSession = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const instanceId = generateSessionInstanceId(workspace.id);

    const session = createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId,
    });

    if (session) {
      setActiveSession(session.id);
      if (activeWorkspaceId !== workspace.id) {
        setActiveWorkspace(workspace.id);
      }
    }
  };

  const handleSessionClick = (sessionId: string) => {
    if (activeWorkspaceId !== workspace.id) {
      // Don't clear session when switching to this workspace
      useNavigationStore.setState({ activeWorkspaceId: workspace.id, activeSessionId: sessionId });
    } else {
      setActiveSession(sessionId);
    }
  };

  return (
    <Collapsible.Root open={isExpanded} onOpenChange={() => toggleExpanded(workspace.id)}>
      <div className="workspace-nav-item-container">
        <button
          className="workspace-expand-toggle"
          onClick={handleChevronClick}
          aria-label={isExpanded ? 'Collapse workspace' : 'Expand workspace'}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          className={`nav-item workspace-nav-item ${isActive ? 'active' : ''}`}
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
      </div>
      <Collapsible.Content className="workspace-collapsible-content">
        {/* Sessions Section */}
        <div className="workspace-sessions-section">
          <div className="section-header">
            <span>Sessions</span>
            <button onClick={handleAddSession} aria-label="Add session">
              <Plus size={12} />
            </button>
          </div>
          {visibleSessions.length === 0 ? (
            <div className="session-list-empty">No sessions</div>
          ) : (
            visibleSessions.map((session) => (
              <SessionNavItem
                key={session.id}
                session={session}
                workspaceId={workspace.id}
                isActive={activeWorkspaceId === workspace.id && activeSessionId === session.id}
                onClick={() => handleSessionClick(session.id)}
              />
            ))
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
