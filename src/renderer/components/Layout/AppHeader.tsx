import { useNavigationStore } from '../../stores/navigationStore';
import { SidebarToggle } from '../Sidebar/SidebarToggle';

export function AppHeader() {
  const isSidebarCollapsed = useNavigationStore((state) => state.isSidebarCollapsed);

  return (
    <header className="app-header">
      <div className="app-header-drag-region" />
      <div className={`app-header-sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <SidebarToggle />
      </div>
      <div className="app-header-content">
        {/* Future: Tab bar will go here */}
      </div>
    </header>
  );
}
