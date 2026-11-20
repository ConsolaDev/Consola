import { ChevronDown } from 'lucide-react';

interface ShelfHeaderProps {
  title: string;
  /** Live leaf count: sessions, with a conductor counted beside its children. */
  count: number;
  /** Whether the shelf is open. */
  open: boolean;
  /** Folds or unfolds the shelf. */
  onToggle: () => void;
  /** The shelf's chord, shown on hover. */
  shortcutHint?: string;
  /** Whether what is on the shelf is running: the header turns the same arc its rows do. */
  live?: boolean;
  /** What the shelf is for, on hover. */
  tooltip?: string;
}

/**
 * The header of one section of the list. The count is live, so a folded shelf
 * still says how much is behind it.
 *
 * The chevron sits at the trailing edge rather than the leading one. Leading,
 * it indented the two foldable titles past the two that are not, and past the
 * rows underneath — three left edges in a list whose whole job is to be
 * scanned down. Trailing, every title and every row name starts on one line,
 * and the chevron reads as what it is: the control, beside the count.
 */
export function ShelfHeader({
  title,
  count,
  open,
  onToggle,
  shortcutHint,
  live,
  tooltip,
}: ShelfHeaderProps) {
  return (
    <button
      type="button"
      className="shelf-header"
      // Settled, empty, recedes rather than disappearing: its count is the
      // answer to "did anything settle?" even when the answer is no. Working
      // is never drawn empty; the sidebar drops it instead.
      data-empty={count === 0 || undefined}
      aria-expanded={open}
      title={shortcutHint ? `${title} (${shortcutHint})` : tooltip}
      onClick={onToggle}
    >
      <span className="shelf-header-title">{title}</span>
      {/* Folded, the rows are out of sight but still turning; the header says
          so in the same motion they would, so a fold never reads as stopped. */}
      {live && <span className="shelf-header-live" aria-hidden="true" />}
      {/* Keyed on the value: a changed count remounts and replays its tick-over,
          so a row arriving in a folded shelf is still visible as an arrival. */}
      <span key={count} className="shelf-header-count">
        {count}
      </span>
      <ChevronDown
        className="shelf-header-chevron"
        size={12}
        aria-hidden="true"
        data-open={open || undefined}
      />
    </button>
  );
}
