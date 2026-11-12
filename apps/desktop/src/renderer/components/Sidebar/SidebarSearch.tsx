import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useCommandPalette } from '../../contexts/CommandPaletteContext';
import { COMMAND_PALETTE_SHORTCUT_LABEL } from '../../utils/platform';

/**
 * The sidebar's search field: a visible way into the command palette for
 * anyone who has not learned its chord yet. It is a button, not an input —
 * the palette owns typing, ranking and results, so a second text box here
 * would only be a place for half a query to get stranded.
 *
 * `children` sit beside the field: the sidebar's own display settings and
 * the New menu, which moved here when the workspace menu went up to the
 * title bar.
 */
export function SidebarSearch({ children }: { children?: ReactNode }) {
  const { openPalette } = useCommandPalette();
  return (
    <div className="sidebar-search">
      <button type="button" className="sidebar-search-field" onClick={() => openPalette()}
        aria-label="Search sessions, workspaces, files and actions" title={`Search (${COMMAND_PALETTE_SHORTCUT_LABEL})`}>
        <Search size={14} aria-hidden="true" />
        <span className="sidebar-search-placeholder">Search</span>
        <kbd className="sidebar-search-shortcut">{COMMAND_PALETTE_SHORTCUT_LABEL}</kbd>
      </button>
      {children}
    </div>
  );
}
