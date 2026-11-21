import * as Tooltip from '@radix-ui/react-tooltip';
import { isInFront } from '../../sidePanel/layout';
import { tabKind, type TabFacts, type TabKindId } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { useTabMark } from '../SidePanel/tabMarks';

/**
 * A header button for one tab kind: it opens the kind's tab, and hides the
 * side panel while that tab is in front on screen. While the kind does not
 * apply to the session it says why instead. It is never `disabled`, which
 * would stop its tooltip from opening, only marked so and deaf to clicks.
 *
 * It carries its kind's mark, if it has one: the header shortcut is the
 * first place a mark goes (`markPlaces`), so the toggle then leaves it out.
 */
export function ShortcutButton({ kind, facts }: { kind: TabKindId; facts: TabFacts }) {
  const inFront = useSidePanelStore((state) => isInFront(state.layout, kind));
  const pressShortcut = useSidePanelStore((state) => state.pressShortcut);
  const mark = useTabMark(kind, facts);
  const entry = tabKind(kind);
  if (!entry) return null;

  const title = entry.title(facts);
  const label = mark ? `${title}, ${mark.onKind}` : title;
  const availability = entry.availability(facts);
  const Icon = entry.icon;
  const tooltip = !availability.available
    ? availability.reason
    : entry.chord
      ? `${label} (${entry.chord})`
      : label;

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`path-display-toggle ${inFront ? 'active' : ''}`}
            aria-label={label}
            aria-pressed={inFront}
            aria-disabled={availability.available ? undefined : true}
            data-agent-dot={mark ? true : undefined}
            onClick={() => {
              if (availability.available) pressShortcut(kind);
            }}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" sideOffset={5}>
            {tooltip}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
