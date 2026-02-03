import { PanelLeftClose, PanelLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useNavigationStore } from '../../stores/navigationStore';

export function SidebarToggle() {
  const { isSidebarCollapsed, toggleSidebar } = useNavigationStore();

  const button = (
    <button className="sidebar-toggle" onClick={toggleSidebar}>
      {isSidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
    </button>
  );

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" side="right" sideOffset={8}>
            {isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            <span className="tooltip-shortcut">⌘\</span>
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
