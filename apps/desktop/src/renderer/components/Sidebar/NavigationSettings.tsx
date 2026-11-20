import { useRef, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Cpu, FolderGit2 } from 'lucide-react';
import { SIDEBAR_DENSITIES, isSidebarDensity, useSettingsStore } from '../../stores/settingsStore';
import { HarnessIcon } from '../HarnessIcon';
import { DENSITY_COPY, DensitySketch } from './DensityPreview';
import { NavigationGlyph } from './NavigationGlyph';

/** Space between the sidebar's edge and the menu standing beside it. */
const BESIDE_SIDEBAR_GAP = 6;

/**
 * How the sidebar's list looks: its density, what each row shows, and
 * whether running sessions get their own section.
 *
 * Every choice applies at once and the menu stays open, so it is tried
 * rather than guessed at. For the same reason the menu stands beside the
 * sidebar instead of dropping over it: the list it changes stays in view,
 * and each click is answered by the rows themselves.
 */
export function NavigationSettings() {
  const showModel = useSettingsStore((state) => state.showSidebarModel);
  const setShowModel = useSettingsStore((state) => state.setShowSidebarModel);
  const showHarness = useSettingsStore((state) => state.showSidebarHarness);
  const setShowHarness = useSettingsStore((state) => state.setShowSidebarHarness);
  const showWorktree = useSettingsStore((state) => state.showSidebarWorktree);
  const setShowWorktree = useSettingsStore((state) => state.setShowSidebarWorktree);
  const workingSection = useSettingsStore((state) => state.sidebarWorkingSection);
  const setWorkingSection = useSettingsStore((state) => state.setSidebarWorkingSection);
  const density = useSettingsStore((state) => state.sidebarDensity);
  const setDensity = useSettingsStore((state) => state.setSidebarDensity);

  const triggerRef = useRef<HTMLButtonElement>(null);
  // Measured as the menu opens, so it clears the sidebar at whatever width
  // the person dragged it to.
  const [besideSidebar, setBesideSidebar] = useState(BESIDE_SIDEBAR_GAP);
  const handleOpenChange = (open: boolean) => {
    if (!open) return;
    const trigger = triggerRef.current;
    const sidebar = trigger?.closest('.sidebar');
    if (!trigger || !sidebar) return;
    const gap = sidebar.getBoundingClientRect().right - trigger.getBoundingClientRect().right;
    setBesideSidebar(Math.max(0, gap) + BESIDE_SIDEBAR_GAP);
  };

  return (
    <DropdownMenu.Root onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className="sidebar-navigation-settings"
          aria-label="Navigation settings"
          title="Navigation settings"
        >
          <NavigationGlyph />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content navigation-settings"
          side="right"
          align="start"
          sideOffset={besideSidebar}
          collisionPadding={8}
        >
          <DropdownMenu.Label className="navigation-settings-heading">Rows</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            className="navigation-density"
            value={density}
            onValueChange={(value) => {
              if (isSidebarDensity(value)) setDensity(value);
            }}
          >
            {SIDEBAR_DENSITIES.map((option) => (
              <DropdownMenu.RadioItem
                key={option}
                value={option}
                className="navigation-density-option"
                title={DENSITY_COPY[option].hint}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="navigation-density-frame">
                  <DensitySketch density={option} />
                </span>
                <span className="navigation-density-label">{DENSITY_COPY[option].label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="dropdown-separator" />
          <DropdownMenu.Label className="navigation-settings-heading">
            Show on each row
          </DropdownMenu.Label>
          <ToggleItem
            label="Harness icon"
            icon={
              <HarnessIcon driverId="claude" decorative className="navigation-toggle-harness" />
            }
            checked={showHarness}
            onChange={setShowHarness}
          />
          {/* Compact rows keep the model for the tooltip; only Detailed has room to print it. */}
          <ToggleItem
            label="Model"
            hint={density === 'compact' ? 'Detailed rows only' : undefined}
            icon={<Cpu size={13} aria-hidden="true" />}
            checked={showModel}
            onChange={setShowModel}
          />
          <ToggleItem
            label="Worktree"
            hint={density === 'compact' ? 'As a mark beside the name' : undefined}
            icon={
              <FolderGit2 size={13} aria-hidden="true" className="navigation-toggle-worktree" />
            }
            checked={showWorktree}
            onChange={setShowWorktree}
          />

          <DropdownMenu.Separator className="dropdown-separator" />
          {/* Off, a running session keeps its place in the list instead of
            moving down to Working and back up when it stops. */}
          <ToggleItem
            label="Working section"
            hint="Running sessions move to their own section"
            icon={<span className="navigation-toggle-working" aria-hidden="true" />}
            checked={workingSection}
            onChange={setWorkingSection}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * One on/off choice, drawn as a switch. It is still a menu checkbox to
 * assistive technology and to the keyboard, named by its label alone: the
 * hint under it describes, it does not rename.
 */
function ToggleItem({
  label,
  hint,
  icon,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  icon: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <DropdownMenu.CheckboxItem
      className="dropdown-item navigation-toggle"
      checked={checked}
      onCheckedChange={onChange}
      onSelect={(event) => event.preventDefault()}
      aria-label={label}
    >
      <span className="navigation-toggle-icon">{icon}</span>
      <span className="navigation-toggle-text">
        <span className="navigation-toggle-label">{label}</span>
        {hint && <span className="navigation-toggle-hint">{hint}</span>}
      </span>
      <span className="navigation-switch" aria-hidden="true">
        <span className="navigation-switch-thumb" />
      </span>
    </DropdownMenu.CheckboxItem>
  );
}
