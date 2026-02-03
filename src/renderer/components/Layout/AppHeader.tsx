import { useNavigationStore } from '../../stores/navigationStore';
import { SidebarToggle } from '../Sidebar/SidebarToggle';
import { TabBar } from '../TabBar';

export function AppHeader() {
  const isSidebarHidden = useNavigationStore((state) => state.isSidebarHidden);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <div className={`app-header-sidebar ${isSidebarHidden ? 'hidden' : ''}`}>
        <SidebarToggle />
      </div>
      <div className={`app-header-content ${isSidebarHidden ? 'sidebar-hidden' : ''}`}>
        <TabBar />
      </div>
    </header>
  );
}
