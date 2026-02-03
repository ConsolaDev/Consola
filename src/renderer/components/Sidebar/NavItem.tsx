import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';

interface NavItemProps {
  icon: ReactNode;
  label: string;
  to: string;
  shortcut?: string;
}

export function NavItem({ icon, label, to, shortcut }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
    >
      <span className="nav-item-icon">{icon}</span>
      <span className="nav-item-label">{label}</span>
      {shortcut && <span className="nav-item-shortcut">{shortcut}</span>}
    </NavLink>
  );
}
