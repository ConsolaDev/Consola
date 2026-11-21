import * as Tooltip from '@radix-ui/react-tooltip';
import { PanelRight } from 'lucide-react';
import { markPlaces } from '../../sidePanel/marks';
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
 * It also carries the mark of a kind the person cannot see anywhere else:
 * one that has no header shortcut (not in `headerKinds`) and no tab in a
 * group on screen (`markPlaces`). The dot is drawn; the label says it too,
 * for whoever cannot see it.
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
  const marks = useTabMarks(facts);
  const visible = layout.visible;
  const mark = marks.find(
    (entry) => markPlaces(entry.kind, { marked: entry.mark !== null, headerKinds, layout }).toggle,
  )?.mark;
  const toggleLabel = visible ? 'Hide side panel' : 'Show side panel';
  const label = mark ? `${toggleLabel}, ${mark.onPanel}` : toggleLabel;

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
            data-agent-dot={mark ? true : undefined}
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
