import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { TabContent } from './TabContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useCreateWorkspace } from '../../contexts/CreateWorkspaceContext';
import { useTabStore } from '../../stores/tabStore';
import './styles.css';

export function Layout() {
  const { openDialog } = useCreateWorkspace();
  const location = useLocation();
  const activeTabId = useTabStore((state) => state.activeTabId);
  const closeTab = useTabStore((state) => state.closeTab);
  useKeyboardShortcuts({
    onNewWorkspace: openDialog,
    onCloseActiveTab: () => closeTab(activeTabId),
  });
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
