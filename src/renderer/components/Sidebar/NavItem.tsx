import type { ReactNode } from 'react';
import { useNavigationStore } from '../../stores/navigationStore';

interface NavItemProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  shortcut?: string;
}

export function NavItem({ icon, label, onClick, shortcut }: NavItemProps) {
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const isActive = activeWorkspaceId === null;

  return (
    <button
      className={`nav-item ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <span className="nav-item-icon">{icon}</span>
      <span className="nav-item-label">{label}</span>
      {shortcut && <span className="nav-item-shortcut">{shortcut}</span>}
    </button>
  );
}
