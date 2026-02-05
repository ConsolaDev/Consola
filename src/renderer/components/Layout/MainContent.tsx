import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { HomeView, ContentView, NewSessionView } from '../Views';

export function MainContent() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  // No workspace selected - show home/welcome
  if (!activeWorkspaceId) {
    return <HomeView />;
  }

  const workspace = getWorkspace(activeWorkspaceId);

  if (!workspace) {
    return <HomeView />;
  }

  // Workspace selected, no session - show centered input
  if (!activeSessionId) {
    return <NewSessionView workspace={workspace} />;
  }

  // Session active - show conversation view
  return <ContentView workspaceId={activeWorkspaceId} sessionId={activeSessionId} />;
}
