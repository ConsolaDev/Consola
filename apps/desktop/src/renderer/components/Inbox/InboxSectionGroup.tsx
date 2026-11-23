// src/renderer/components/Inbox/InboxSectionGroup.tsx
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { InboxSection } from '../../../shared/inboxSections';
import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import type { AttentionMap } from '../../utils/sessionStatus';
import type { GateMark } from './gateMarks';
import { InboxRow } from './InboxRow';
import { isRepoCloned } from './inboxPresentation';

interface InboxSectionGroupProps {
  section: InboxSection;
  label: string;
  items: InboxItem[];
  collapsed: boolean;
  onToggle: () => void;
  /** Keyed by workItemKey; computed once by the view, shared by every section. */
  sessionsByItem: Map<string, Session[]>;
  attention: AttentionMap;
  /** By item URL, the run waiting for the person at a gate on it. */
  gateMarks: Map<string, GateMark>;
  resolvedRepos: Record<string, string | null> | undefined;
  selectedKey: string | null;
  onSelectItem: (item: InboxItem) => void;
}

/**
 * One of GitHub's sections: a heading with a count that stays visible
 * while collapsed -- the count is the triage signal, the rows are the
 * detail -- and the rows beneath it when expanded.
 *
 * The item->row mapping (workItemKey, session lookup, cloned-ness) is
 * written once here; other callers of this component reuse it rather than
 * re-deriving those per-row inputs themselves.
 */
export function InboxSectionGroup({
  section,
  label,
  items,
  collapsed,
  onToggle,
  sessionsByItem,
  attention,
  gateMarks,
  resolvedRepos,
  selectedKey,
  onSelectItem,
}: InboxSectionGroupProps) {
  return (
    <section
      className={`inbox-section ${collapsed ? 'collapsed' : ''}`}
      data-testid={`inbox-section-${section}`}
    >
      <button className="inbox-section-toggle" aria-expanded={!collapsed} onClick={onToggle}>
        {collapsed ? (
          <ChevronRight size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
        <span className="inbox-section-label">{label}</span>
        <span className="inbox-section-count">{items.length}</span>
      </button>
      {!collapsed && items.length > 0 && (
        <div className="inbox-list">
          {items.map((item) => {
            const key = workItemKey(item.workItem);
            return (
              <InboxRow
                key={key}
                item={item}
                sessions={sessionsByItem.get(key) ?? []}
                attention={attention}
                gateMark={gateMarks.get(item.url)}
                cloned={isRepoCloned(resolvedRepos, item.workItem.repo)}
                selected={selectedKey === key}
                onSelect={onSelectItem}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
