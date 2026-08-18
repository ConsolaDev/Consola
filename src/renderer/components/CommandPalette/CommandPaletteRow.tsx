import { memo } from 'react';
import { ChevronRight, Folder, GitBranch, MessageSquare } from 'lucide-react';
import { FileIcon } from '../FileExplorer/FileIcon';
import { STATUS_LABELS } from '../FileExplorer/GitChangesItem';
import { fuzzyMatch } from './fuzzyMatch';
import type { PaletteItem } from './types';

interface CommandPaletteRowProps {
  item: PaletteItem;
  index: number;
  isSelected: boolean;
  query: string;
  onHover: (index: number) => void;
  onSelect: (item: PaletteItem) => void;
  registerRef: (index: number, element: HTMLDivElement | null) => void;
}

/** Row ids double as `aria-activedescendant` targets, so they must be valid. */
export function rowElementId(itemId: string): string {
  return `command-palette-option-${encodeURIComponent(itemId)}`;
}

/** Bold the characters the query actually matched. */
function HighlightedLabel({ label, query }: { label: string; query: string }) {
  const match = query.trim() ? fuzzyMatch(query.trim(), label) : null;
  if (!match || match.indices.length === 0) return <>{label}</>;

  const matched = new Set(match.indices);
  return (
    <>
      {label.split('').map((char, index) =>
        matched.has(index) ? (
          <mark key={index} className="command-palette-match">
            {char}
          </mark>
        ) : (
          <span key={index}>{char}</span>
        )
      )}
    </>
  );
}

function RowIcon({ item }: { item: PaletteItem }) {
  if (item.kind === 'action') {
    const Icon = item.icon;
    return <Icon size={15} className="command-palette-row-icon" />;
  }
  if (item.kind === 'session') {
    return <MessageSquare size={15} className="command-palette-row-icon" />;
  }
  if (item.kind === 'workspace') {
    const Icon = item.isGitRepo ? GitBranch : Folder;
    return <Icon size={15} className="command-palette-row-icon" />;
  }
  if (item.kind === 'harness') {
    return (
      <span className="command-palette-row-dot" style={{ background: item.accentColor }} />
    );
  }
  return <FileIcon filename={item.label} className="command-palette-row-file-icon" />;
}

export const CommandPaletteRow = memo(function CommandPaletteRow({
  item,
  index,
  isSelected,
  query,
  onHover,
  onSelect,
  registerRef,
}: CommandPaletteRowProps) {
  const isBranching = item.kind === 'action' && item.pushMode !== undefined;

  return (
    <div
      ref={(element) => registerRef(index, element)}
      id={rowElementId(item.id)}
      role="option"
      aria-selected={isSelected}
      className={`command-palette-row ${isSelected ? 'selected' : ''}`}
      // mousemove rather than mouseenter: scrolling a row under a stationary
      // cursor fires mouseenter, which would steal the keyboard's selection.
      onMouseMove={() => onHover(index)}
      onClick={() => onSelect(item)}
    >
      <RowIcon item={item} />

      <span className="command-palette-row-label">
        <HighlightedLabel label={item.label} query={query} />
      </span>

      {item.kind === 'file' && (
        <span className={`command-palette-row-status git-${item.status}`}>
          {STATUS_LABELS[item.status]}
        </span>
      )}

      {item.context && <span className="command-palette-row-context">{item.context}</span>}

      {item.kind === 'action' && item.shortcutHint && (
        <kbd className="command-palette-row-shortcut">{item.shortcutHint}</kbd>
      )}

      {isBranching && <ChevronRight size={14} className="command-palette-row-chevron" />}
    </div>
  );
});
