import { useNavigationStore } from '../../stores/navigationStore';
import { SidebarToggle } from '../Sidebar/SidebarToggle';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { NewMenu } from './NewMenu';

export function AppHeader() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <div className={`app-header-sidebar ${isSidebarHidden ? 'hidden' : ''}`}>
        <SidebarToggle />
      </div>
      <div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
        <WorkspaceSwitcher />
        <NewMenu />
      </div>
    </header>
  );
}
