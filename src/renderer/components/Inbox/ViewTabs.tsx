// src/renderer/components/Inbox/ViewTabs.tsx
import { INBOX_VIEWS, type InboxViewId } from '../../../shared/inboxViews';

interface ViewTabsProps {
  active: InboxViewId;
  /** Post-filter counts -- the number a tab shows is the number it will list. */
  counts: Record<InboxViewId, number>;
  onSelect: (view: InboxViewId) => void;
}

/**
 * GitHub's left navigation, folded into a tab strip (mockup inbox-views
 * option 2) so Consola's sidebar stays Inbox · Groups · Scopes. Counts are
 * live for every tab, not just the active one: the strip is also the
 * at-a-glance answer to "is anything waiting under the other views".
 */
export function ViewTabs({ active, counts, onSelect }: ViewTabsProps) {
  return (
    <div className="inbox-view-tabs" role="tablist" aria-label="Inbox views">
      {INBOX_VIEWS.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={active === id}
          className={`inbox-view-tab ${active === id ? 'active' : ''}`}
          data-testid={`inbox-tab-${id}`}
          onClick={() => onSelect(id)}
        >
          <span>{label}</span>
          <span className="inbox-view-tab-count">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}
