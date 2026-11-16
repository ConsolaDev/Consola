import { ChevronDown, ChevronRight } from 'lucide-react';

interface ShelfHeaderProps {
  title: string;
  /** Live leaf count: sessions, with a conductor counted beside its children. */
  count: number;
  open: boolean;
  onToggle: () => void;
  /** The shelf's chord, shown on hover. */
  shortcutHint?: string;
}

/**
 * The header of a collapsible shelf. Shared by Working and Settled: the count is
 * live, so a collapsed shelf still says how much is behind it.
 */
export function ShelfHeader({ title, count, open, onToggle, shortcutHint }: ShelfHeaderProps) {
  return (
    <button
      type="button"
      className="shelf-header"
      aria-expanded={open}
      title={shortcutHint ? `${title} (${shortcutHint})` : undefined}
      onClick={onToggle}
    >
      {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      <span className="shelf-header-title">{title}</span>
      <span className="shelf-header-count">{count}</span>
    </button>
  );
}
