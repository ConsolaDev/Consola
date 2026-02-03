import { NavLink } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';
import type { ReactNode } from 'react';

interface NavItemProps {
  icon: ReactNode;
  label: string;
  to: string;
  shortcut?: string;
}

export function NavItem({ icon, label, to, shortcut }: NavItemProps) {
  const isSidebarCollapsed = useNavigationStore((state) => state.isSidebarCollapsed);

  const content = (
    <NavLink
      to={to}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
    >
      <span className="nav-item-icon">{icon}</span>
      {!isSidebarCollapsed && (
        <>
          <span className="nav-item-label">{label}</span>
          {shortcut && <span className="nav-item-shortcut">{shortcut}</span>}
        </>
      )}
    </NavLink>
  );

  if (isSidebarCollapsed) {
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{content}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
              {label}
              {shortcut && <span className="tooltip-shortcut">{shortcut}</span>}
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }

  return content;
}
