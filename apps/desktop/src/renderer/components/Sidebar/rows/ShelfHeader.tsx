import { ChevronDown } from 'lucide-react';

interface ShelfHeaderProps {
  title: string;
  /** Live leaf count: sessions, with a conductor counted beside its children. */
  count: number;
  /** Whether the shelf is open. Ignored by a header with no `onToggle`. */
  open?: boolean;
  /**
   * Folds the shelf. A header without one is a label: it names the list under
   * it and nothing more. Both exist because every section needs a header —
   * a run of rows under no heading reads as the previous shelf's contents
   * having escaped it — but Needs you is never folded away.
   */
  onToggle?: () => void;
  /** The shelf's chord, shown on hover. */
  shortcutHint?: string;
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
export function ShelfHeader({ title, count, open = true, onToggle, shortcutHint }: ShelfHeaderProps) {
  const body = (
    <>
      <span className="shelf-header-title">{title}</span>
      {/* Keyed on the value: a changed count remounts and replays its tick-over,
          so a row arriving in a folded shelf is still visible as an arrival. */}
      <span key={count} className="shelf-header-count">{count}</span>
      {onToggle && <ChevronDown className="shelf-header-chevron" size={12} aria-hidden="true" data-open={open || undefined} />}
    </>
  );

  if (!onToggle) return <div className="shelf-header shelf-header--label">{body}</div>;

  return (
    <button
      type="button"
      className="shelf-header"
      // An empty shelf recedes rather than disappearing: hiding it would make
      // the chord that opens it point at nothing, and the count is the answer
      // to "did anything settle?" even when the answer is no.
      data-empty={count === 0 || undefined}
      aria-expanded={open}
      title={shortcutHint ? `${title} (${shortcutHint})` : undefined}
      onClick={onToggle}
    >
      {body}
    </button>
  );
}
