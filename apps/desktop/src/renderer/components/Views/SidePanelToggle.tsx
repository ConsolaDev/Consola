import * as Tooltip from '@radix-ui/react-tooltip';
import { PanelRight } from 'lucide-react';
import { labelWithMarks, markDots, marksOnToggle } from '../../sidePanel/marks';
import type { TabFacts, TabKindId } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { isMac } from '../../utils/platform';
import { SIDE_PANEL_SHORTCUT_LABEL } from '../../utils/sidePanelShortcut';
import { useTabMarks } from '../SidePanel/tabMarks';

/**
 * Shows or hides the side panel, as its chord does. The header's last
 * button, and one that needs no checkout: a side panel with nothing open
 * shows the "+" list, which says what applies to the session.
 *
 * It also carries the marks of the kinds the person cannot see anywhere
 * else: each one that has no header shortcut (not in `headerKinds`) and no
 * tab in a group on screen (`markPlaces`). So it can carry two, an agent's
 * and an alert, one dot each. The dots are drawn; the label says each mark
 * too, for whoever cannot see them.
 */
export function SidePanelToggle({
  facts,
  headerKinds,
}: {
  facts: TabFacts;
  headerKinds: readonly TabKindId[];
}) {
  const layout = useSidePanelStore((state) => state.layout);
  const toggleVisible = useSidePanelStore((state) => state.toggleVisible);
  const marks = marksOnToggle(useTabMarks(facts), { headerKinds, layout });
  const visible = layout.visible;
  const label = labelWithMarks(
    visible ? 'Hide side panel' : 'Show side panel',
    marks.map((mark) => mark.onPanel),
  );

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`path-display-toggle side-panel-toggle${visible ? ' active' : ''}`}
            aria-label={label}
            aria-pressed={visible}
            aria-keyshortcuts={isMac ? 'Alt+Meta+B' : 'Control+Alt+B'}
            {...markDots(marks)}
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
