import { Outlet } from 'react-router-dom';
import { Sidebar } from '../Sidebar';
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
      <Sidebar />
      <main className="content-area">
        <Outlet />
      </main>
    </div>
  );
}
