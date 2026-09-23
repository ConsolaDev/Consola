// src/renderer/components/Inbox/ViewTabs.tsx
import { useRef } from 'react';
import { INBOX_VIEWS, type InboxViewId } from '../../../shared/inboxViews';

interface ViewTabsProps {
  active: InboxViewId;
  /** Post-filter counts -- the number a tab shows is the number it will list. */
  counts: Record<InboxViewId, number>;
  onSelect: (view: InboxViewId) => void;
  /** id of the tabpanel this strip controls, shared with index.tsx so each
      tab's own id (derived from it) and the panel's aria-labelledby agree. */
  panelId: string;
}

/**
 * GitHub's left navigation, folded into a tab strip (mockup inbox-views
 * option 2) so Consola's sidebar stays Inbox · Groups · Scopes. Counts are
 * live for every tab, not just the active one: the strip is also the
 * at-a-glance answer to "is anything waiting under the other views".
 *
 * Wired as the APG tablist pattern with automatic activation (arrowing to a
 * tab selects it immediately, matching the existing click behaviour): only
 * the active tab is a page tab stop, and Left/Right/Home/End move both
 * focus and selection among the rest.
 */
export function ViewTabs({ active, counts, onSelect, panelId }: ViewTabsProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % INBOX_VIEWS.length;
    else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + INBOX_VIEWS.length) % INBOX_VIEWS.length;
    } else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = INBOX_VIEWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = INBOX_VIEWS[nextIndex];
    onSelect(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <div className="inbox-view-tabs" role="tablist" aria-label="Inbox views">
      {INBOX_VIEWS.map(({ id, label }, index) => (
        <button
          key={id}
          ref={(element) => {
            tabRefs.current[id] = element;
          }}
          role="tab"
          id={`${panelId}-tab-${id}`}
          aria-controls={panelId}
          aria-selected={active === id}
          tabIndex={active === id ? 0 : -1}
          className={`inbox-view-tab ${active === id ? 'active' : ''}`}
          data-testid={`inbox-tab-${id}`}
          onClick={() => onSelect(id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          <span>{label}</span>
          <span className="inbox-view-tab-count">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}
