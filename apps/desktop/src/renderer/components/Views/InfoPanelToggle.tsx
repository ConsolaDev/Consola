import * as Tooltip from '@radix-ui/react-tooltip';
import { List } from 'lucide-react';
import { toggleInfoPanel, useInfoPanelShown } from '../../stores/infoPanelRoomStore';
import { INFO_PANEL_SHORTCUT_LABEL } from '../../utils/infoPanelShortcut';
import { isMac } from '../../utils/platform';

/**
 * Shows or hides the info panel, as its chord does: the header's button
 * between the shortcuts and the side panel's toggle. Whether the panel shows
 * is the same for every session. It says what is on screen: while the panel
 * has stepped aside for a narrow window it reads Show, and pressing it shows
 * the panel anyway (`toggleInfoPanel`).
 */
export function InfoPanelToggle() {
  const visible = useInfoPanelShown();
  const label = visible ? 'Hide info panel' : 'Show info panel';

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`path-display-toggle info-panel-toggle${visible ? ' active' : ''}`}
            aria-label={label}
            aria-pressed={visible}
            aria-keyshortcuts={isMac ? 'Alt+Meta+J' : 'Control+Alt+J'}
            onClick={toggleInfoPanel}
          >
            <List size={14} aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" sideOffset={5}>
            {`${label} (${INFO_PANEL_SHORTCUT_LABEL})`}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
