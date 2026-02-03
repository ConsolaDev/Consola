import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { TabContent } from './TabContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useCreateWorkspace } from '../../contexts/CreateWorkspaceContext';
import './styles.css';

export function Layout() {
  const { openDialog } = useCreateWorkspace();
  const location = useLocation();
  useKeyboardShortcuts({ onNewWorkspace: openDialog });
  useTheme();

  // Settings uses Outlet, everything else uses tab-based navigation
  const isSettings = location.pathname === '/settings';

  return (
    <div className="layout">
      <AppHeader />
      <div className="layout-body">
        <Sidebar />
        <main className="content-area">
          {isSettings ? <Outlet /> : <TabContent />}
        </main>
      </div>
    </div>
  );
}
