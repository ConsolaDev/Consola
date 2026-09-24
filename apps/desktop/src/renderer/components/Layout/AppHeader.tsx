import { useNavigationStore } from '../../stores/navigationStore';
import { SidebarToggle } from '../Sidebar/SidebarToggle';
import { WorkspaceMenu } from './WorkspaceMenu';
import { NewMenu } from './NewMenu';
import { AppUpdateNotice } from '../AppUpdates';

export function AppHeader() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <div className={`app-header-sidebar ${isSidebarHidden ? 'hidden' : ''}`}>
        <SidebarToggle />
      </div>
      <div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
        {isSidebarHidden && <><WorkspaceMenu /><NewMenu /></>}
        <AppUpdateNotice />
      </div>
    </header>
  );
}
