import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, SlidersHorizontal } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';

export function NavigationSettings() {
  const showModel = useSettingsStore((state) => state.showSidebarModel);
  const setShowModel = useSettingsStore((state) => state.setShowSidebarModel);
  const showHarness = useSettingsStore((state) => state.showSidebarHarness);
  const setShowHarness = useSettingsStore((state) => state.setShowSidebarHarness);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="sidebar-navigation-settings" aria-label="Navigation settings" title="Navigation settings">
          <SlidersHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content" side="top" align="end" sideOffset={8}>
          <DropdownMenu.Label className="navigation-settings-label">Show in navigation</DropdownMenu.Label>
          <DropdownMenu.CheckboxItem
            className="dropdown-item"
            checked={showHarness}
            onCheckedChange={setShowHarness}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="navigation-settings-check">
              <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
            </span>
            Harness icon
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className="dropdown-item"
            checked={showModel}
            onCheckedChange={setShowModel}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="navigation-settings-check">
              <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
            </span>
            Model
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
