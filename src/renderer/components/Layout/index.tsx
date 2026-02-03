import { Outlet } from 'react-router-dom';
import { Sidebar } from '../Sidebar';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import './styles.css';

export function Layout() {
  useKeyboardShortcuts();
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
