import { useNavigationStore } from '../../stores/navigationStore';
import { SidebarToggle } from '../Sidebar/SidebarToggle';
import { WorkspaceMenu } from './WorkspaceMenu';
import { NewMenu } from './NewMenu';
import { AppUpdateNotice } from '../AppUpdates';

/**
 * The title bar strip: the traffic lights, the sidebar toggle and, while the
 * sidebar is hidden, the workspace and New menus it would otherwise hold.
 * With the sidebar shown it spans only the navigation columns, and the main
 * pane runs to the window's top edge beside it.
 */
export function AppHeader() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <div className={`app-header-sidebar ${isSidebarHidden ? 'hidden' : ''}`}>
        <SidebarToggle />
        {!isSidebarHidden && <AppUpdateNotice />}
      </div>
      {isSidebarHidden && (
        <div className="app-header-content sidebar-hidden">
          <WorkspaceMenu />
          <NewMenu />
          <AppUpdateNotice />
        </div>
      )}
    </header>
  );
}
