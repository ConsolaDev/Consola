import { TAB_KIND_IDS, type TabFacts } from '../../sidePanel/tabKinds';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import { ShortcutButton } from './ShortcutButton';
import { SidePanelToggle } from './SidePanelToggle';

/**
 * The right end of the session header: a shortcut for each of the kinds the
 * person opens most, then the side panel's toggle. The kinds are the store's
 * `shortcutKinds`, worked out once at launch, so nothing here moves while the
 * app runs, and they are listed in registry order, so only which kinds are
 * shown changes from one launch to the next. A kind that does not apply to
 * the session keeps its place, dimmed (`ShortcutButton`).
 *
 * Drawn for every session, one without a checkout included: the toggle needs
 * none, and a shortcut that does not apply says why.
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
      {/* The info panel's toggle goes here. */}
      <SidePanelToggle facts={facts} headerKinds={kinds} />
    </div>
  );
}
