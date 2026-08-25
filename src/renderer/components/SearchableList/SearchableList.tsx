import { useEffect, useMemo, useRef } from 'react';
import { HighlightMatch } from '../HighlightMatch';
import { rankSearchableItems, type SearchableListItem } from './rankSearchableItems';
import './styles.css';

interface SearchableListProps<T extends SearchableListItem> {
  items: T[];
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  inputAriaLabel: string;
  emptyMessage: string;
  /** The highlighted row. Controlled, so a dialog's primary button can act on it. */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  /** Enter, or a double-click, on an enabled highlighted row. */
  onActivate: (item: T) => void;
  /** Rendered before the label — a status dot, an icon. */
  leadingSlot?: (item: T) => React.ReactNode;
}

/** Row ids double as `aria-activedescendant` targets, so they must be valid. */
function rowElementId(itemId: string): string {
  return `searchable-list-option-${encodeURIComponent(itemId)}`;
}

/**
 * A search box over a ranked, keyboard-navigable list — the picker inside
 * the link dialog. Deliberately smaller than the command palette (one flat
 * list, no sections, no modes) and built on its matcher and its listbox
 * conventions (`role="option"`, mousemove-not-mouseenter, scroll-into-view).
 */
export function SearchableList<T extends SearchableListItem>({
  items,
  query,
  onQueryChange,
  placeholder,
  inputAriaLabel,
  emptyMessage,
  activeId,
  onActiveChange,
  onActivate,
  leadingSlot,
}: SearchableListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const ranked = useMemo(() => rankSearchableItems(items, query), [items, query]);

  // Keep the highlight on something activatable: when the query drops the
  // active row, or the active row is disabled, fall to the first enabled one.
  useEffect(() => {
    const active = ranked.find((item) => item.id === activeId);
    if (active && !active.disabled) return;
    const first = ranked.find((item) => !item.disabled);
    onActiveChange(first ? first.id : null);
  }, [ranked, activeId, onActiveChange]);

  // Follow the keyboard when the selection moves past the visible rows.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const move = (delta: 1 | -1) => {
    if (ranked.length === 0) return;
    const current = ranked.findIndex((item) => item.id === activeId);
    let next = current;
    for (let step = 0; step < ranked.length; step++) {
      next = (next + delta + ranked.length) % ranked.length;
      if (!ranked[next].disabled) {
        onActiveChange(ranked[next].id);
        return;
      }
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      const active = ranked.find((item) => item.id === activeId);
      if (active && !active.disabled) {
        event.preventDefault();
        onActivate(active);
      }
    }
  };

  return (
    <div className="searchable-list">
      <input
        type="text"
        className="dialog-input searchable-list-input"
        role="combobox"
        aria-expanded
        aria-controls="searchable-list-rows"
        aria-activedescendant={activeId ? rowElementId(activeId) : undefined}
        aria-label={inputAriaLabel}
        placeholder={placeholder}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="searchable-list-rows" role="listbox" id="searchable-list-rows" ref={listRef}>
        {ranked.length === 0 && <div className="searchable-list-empty">{emptyMessage}</div>}
        {ranked.map((item) => {
          const isActive = item.id === activeId;
          return (
            <div
              key={item.id}
              id={rowElementId(item.id)}
              role="option"
              aria-selected={isActive}
              aria-disabled={item.disabled || undefined}
              data-active={isActive}
              className={`searchable-list-row ${isActive ? 'selected' : ''}`}
              // mousemove rather than mouseenter: scrolling a row under a
              // stationary cursor fires mouseenter, which would steal the
              // keyboard's selection.
              onMouseMove={() => {
                if (!item.disabled && !isActive) onActiveChange(item.id);
              }}
              onClick={() => {
                if (!item.disabled) onActiveChange(item.id);
              }}
              onDoubleClick={() => {
                if (!item.disabled) onActivate(item);
              }}
            >
              {leadingSlot?.(item)}
              {/* Wrapped: the highlighter emits one element per character. */}
              <span className="searchable-list-row-label">
                <HighlightMatch label={item.label} query={query} />
              </span>
              <span className="searchable-list-row-context">
                {item.disabled && item.disabledHint ? item.disabledHint : item.context}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
