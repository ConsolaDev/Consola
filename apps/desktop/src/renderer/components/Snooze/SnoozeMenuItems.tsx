import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlarmClock, CalendarClock, SlidersHorizontal } from 'lucide-react';
import { resolveSnoozePresets } from '../../../shared/snooze';
import { useSettings } from '../../contexts/SettingsContext';
import { useMinuteTick } from '../../hooks/useMinuteTick';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useSnoozeDialogStore } from '../../stores/snoozeDialogStore';
import { snoozeAtPreset } from '../../utils/snoozeActions';
import './styles.css';

interface SnoozeMenuItemsProps {
  workspaceId: string;
  sessionIds: string[];
  /** Session id to the name a toast says. */
  names: Record<string, string>;
  /**
   * Called before Custom… or Edit snooze options… opens something that takes
   * focus, so the menu does not hand focus back as it closes.
   */
  onOpenDialog?: () => void;
  /** The word on the submenu: "Snooze", or "Snooze 3 sessions" for a selection. */
  title?: string;
  /** Called once a choice is picked, before the snooze is asked for. */
  onPicked?: () => void;
}

/**
 * The Snooze ▸ submenu, as every window shows it: the person's own choices
 * from Settings, soonest first, each with the time it comes back, then
 * Custom… and the way to edit the list. Shared by a row's menu, a selection's
 * menu and the usage-limit strip, so the three cannot drift apart.
 */
export function SnoozeMenuItems({
  workspaceId,
  sessionIds,
  names,
  onOpenDialog,
  title = 'Snooze',
  onPicked,
}: SnoozeMenuItemsProps) {
  const presets = usePreferencesStore((state) => state.snoozePresets);
  // Mounted only while the menu is open, so the clock runs only then.
  const now = useMinuteTick();
  const rows = resolveSnoozePresets(presets, now);
  const { openSettings } = useSettings();

  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="dropdown-item">
        <AlarmClock size={14} />
        <span>{title}</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className="dropdown-content snooze-menu" sideOffset={4}>
          {rows.map((row) => (
            <DropdownMenu.Item
              key={row.index}
              className="dropdown-item snooze-menu-item"
              onSelect={() => {
                onPicked?.();
                void snoozeAtPreset(workspaceId, sessionIds, row, names);
              }}
            >
              <span className="snooze-menu-label">{row.label}</span>
              <span className="snooze-menu-time">{row.timeLabel}</span>
            </DropdownMenu.Item>
          ))}
          {rows.length > 0 && <DropdownMenu.Separator className="dropdown-separator" />}
          <DropdownMenu.Item
            className="dropdown-item"
            onSelect={() => {
              onOpenDialog?.();
              useSnoozeDialogStore.getState().open({ workspaceId, sessionIds, names });
            }}
          >
            <CalendarClock size={14} />
            <span>Custom…</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="dropdown-item"
            onSelect={() => {
              onOpenDialog?.();
              openSettings('sessions');
            }}
          >
            <SlidersHorizontal size={14} />
            <span>Edit snooze options…</span>
          </DropdownMenu.Item>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
