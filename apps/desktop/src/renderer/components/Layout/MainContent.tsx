import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { HomeView, ContentView, WorkspaceEmptyView } from '../Views';
import { InboxView } from '../Inbox';
import { AutomationsView } from '../Automations';

export function MainContent() {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const activeSessionId = useNavigationStore((state) => state.activeSessionId);
  const overlay = useNavigationStore((state) => state.overlay);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === activeWorkspaceId)
  );

  // No workspace selected - show home/welcome
  if (!activeWorkspaceId || !workspace) {
    return <><ContentDragRegion /><HomeView /></>;
  }

  // An overlay takes the pane over; the active session keeps running behind it
  // ("terminals outlive their views") and returns on the next sidebar click.
  if (overlay === 'inbox') {
    return <InboxView workspace={workspace} />;
  }
  if (overlay === 'automations') {
    return <AutomationsView workspace={workspace} />;
  }

  // Workspace selected, no session - show workspace actions
  if (!activeSessionId) {
    return <><ContentDragRegion /><WorkspaceEmptyView key={workspace.id} workspace={workspace} /></>;
  }

  // Session active - show conversation view
  return <ContentView workspaceId={activeWorkspaceId} sessionId={activeSessionId} />;
}

/**
 * The main pane reaches the window's top edge, where a view's header is the
 * title bar. A view with no header of its own still needs a strip there to
 * drag the window by — in flow, not overlaid, so scrolled content never
 * passes under it and turns into a drag handle.
 */
function ContentDragRegion() {
  return <div className="content-drag-region" aria-hidden="true" />;
}
