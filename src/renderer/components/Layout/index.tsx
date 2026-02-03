import { Outlet } from 'react-router-dom';
import { Sidebar } from '../Sidebar';
import './styles.css';

export function Layout() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="content-area">
        <Outlet />
      </main>
    </div>
  );
}
