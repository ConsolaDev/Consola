import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { HomeView, ContentView, WorkspaceEmptyView } from '../Views';
import { InboxView } from '../Inbox';

export function MainContent() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const isInboxOpen = useNavigationStore((state) => state.isInboxOpen);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === activeWorkspaceId)
  );

  // No workspace selected - show home/welcome
  if (!activeWorkspaceId) {
    return <HomeView />;
  }

  if (!workspace) {
    return <HomeView />;
  }

  // The Inbox takes the pane over; the active session keeps running behind it
  // ("terminals outlive their views") and returns on the next sidebar click.
  if (isInboxOpen && workspace.provider) {
    return <InboxView workspace={workspace} />;
  }

  // Workspace selected, no session - show workspace actions
  if (!activeSessionId) {
    return <WorkspaceEmptyView key={workspace.id} workspace={workspace} />;
  }

  // Session active - show conversation view
  return <ContentView workspaceId={activeWorkspaceId} sessionId={activeSessionId} />;
}
