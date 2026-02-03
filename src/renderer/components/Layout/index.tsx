import { Outlet } from 'react-router-dom';
import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useCreateWorkspace } from '../../contexts/CreateWorkspaceContext';
import './styles.css';

export function Layout() {
  const { openDialog } = useCreateWorkspace();
  useKeyboardShortcuts({ onNewWorkspace: openDialog });
  useTheme();

  return (
    <div className="layout">
      <AppHeader />
      <div className="layout-body">
        <Sidebar />
        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
