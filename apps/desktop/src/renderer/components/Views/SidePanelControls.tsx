import { TAB_KIND_IDS } from '../../sidePanel/tabKinds';
import type { TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { InfoPanelToggle } from './InfoPanelToggle';
import { ShortcutButton } from './ShortcutButton';
import { SidePanelToggle } from './SidePanelToggle';

/**
 * The right end of the session header: a shortcut for each of the kinds the
 * person opens most, then the info panel's toggle and the side panel's. The
 * kinds are the store's `shortcutKinds`, worked out once at launch, so
 * nothing here moves while the app runs, and they are listed in registry
 * order, so only which kinds are shown changes from one launch to the next.
 * A kind that does not apply to the session keeps its place, dimmed
 * (`ShortcutButton`).
 *
 * Drawn for every session, one without a checkout included: the toggles need
 * none, and a shortcut that does not apply says why.
 *
 * The shortcuts and the side panel's toggle must be given the same `kinds`.
 * `ShortcutButton` draws its kind's mark whenever the kind is marked, and the
 * toggle leaves a mark out only because `markPlaces` is told the same kinds
 * are in the header. Given different lists, a mark could show on both, or on
 * neither.
 */
export function SidePanelControls({ facts }: { facts: TabFacts }) {
  const shortcutKinds = useSidePanelStore((state) => state.shortcutKinds);
  const kinds = TAB_KIND_IDS.filter((kind) => shortcutKinds.includes(kind));

  return (
    <div className="side-panel-controls">
      {kinds.map((kind) => (
        <ShortcutButton key={kind} kind={kind} facts={facts} />
      ))}
      {/* An <hr> is a separator to assistive tech; this one stands upright. */}
      <hr aria-orientation="vertical" className="side-panel-controls-separator" />
      <InfoPanelToggle />
      <SidePanelToggle facts={facts} headerKinds={kinds} />
    </div>
  );
}
