import * as Tooltip from '@radix-ui/react-tooltip';
import { isInFront } from '../../sidePanel/layout';
import { markDots } from '../../sidePanel/marks';
import { shortcutActs, tabKind } from '../../sidePanel/tabKinds';
import type { TabFacts, TabKindId } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { useTabMark } from '../SidePanel/tabMarks';

/**
 * A header button for one tab kind: it opens the kind's tab, and hides the
 * side panel while that tab is in front on screen. While the kind does not
 * apply to the session its tooltip says why, and while that also means a
 * press would do nothing (`shortcutActs`) it is dimmed and deaf to clicks. A
 * kind in front never is, as its chord is not: pressing it only hides the
 * side panel. It is never `disabled`, which would stop its tooltip from
 * opening, only marked so.
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
  const acts = shortcutActs(entry, facts, inFront);
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
            aria-disabled={acts ? undefined : true}
            aria-keyshortcuts={entry.keyshortcuts}
            {...markDots(mark ? [mark] : [])}
            onClick={() => {
              if (acts) pressShortcut(kind);
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
