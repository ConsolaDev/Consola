import { useNavigationStore } from '../../stores/navigationStore';
import { SidebarToggle } from '../Sidebar/SidebarToggle';
import { WorkspaceMenu } from './WorkspaceMenu';
import { NewMenu } from './NewMenu';
import { AppUpdateNotice } from '../AppUpdates';

/**
 * The title bar strip over the navigation columns: traffic lights, the
 * sidebar toggle and the workspace menu. Beside it the main pane runs to the
 * window's top edge, so the open session's own row is the title bar there,
 * as in production. With the sidebar hidden the strip spans the window and
 * also carries the New menu. The scope filter sits in the sidebar, over the
 * list it narrows.
 */
export function AppHeader() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <SidebarToggle />
      <div className="app-header-context">
        <WorkspaceMenu />
      </div>
      <span className="app-header-spacer" />
      {/* The sidebar's own + buttons go with it. */}
      {isSidebarHidden && <NewMenu />}
      <AppUpdateNotice />
    </header>
  );
}
