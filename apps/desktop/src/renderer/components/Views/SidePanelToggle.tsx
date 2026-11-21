import * as Tooltip from '@radix-ui/react-tooltip';
import { PanelRight } from 'lucide-react';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { isMac } from '../../utils/platform';
import { SIDE_PANEL_SHORTCUT_LABEL } from '../../utils/sidePanelShortcut';

/**
 * Shows or hides the side panel, as its chord does. The header's last
 * button, and one that needs no checkout: a side panel with nothing open
 * shows the "+" list, which says what applies to the session.
 */
export function SidePanelToggle() {
  const visible = useSidePanelStore((state) => state.layout.visible);
  const toggleVisible = useSidePanelStore((state) => state.toggleVisible);
  const label = visible ? 'Hide side panel' : 'Show side panel';

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`path-display-toggle side-panel-toggle ${visible ? 'active' : ''}`}
            aria-label={label}
            aria-pressed={visible}
            aria-keyshortcuts={isMac ? 'Alt+Meta+B' : 'Control+Alt+B'}
            onClick={toggleVisible}
          >
            <PanelRight size={14} aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" sideOffset={5}>
            {`${label} (${SIDE_PANEL_SHORTCUT_LABEL})`}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
