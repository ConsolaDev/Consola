import { INBOX_SECTIONS, sectionFor, type InboxSection } from './inboxSections';
import type { InboxItem } from './workItems';

/**
 * GitHub's own navigation over one workspace's cache: Inbox is the sectioned
 * triage, the other four are flat lists. Five lenses, one fetch -- a view
 * never costs a request.
 */
export type InboxViewId = 'inbox' | 'authored' | 'assigned' | 'involved' | 'review-requests';

/** Tab order and labels, as on github.com. */
export const INBOX_VIEWS: ReadonlyArray<{ id: InboxViewId; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'authored', label: 'Authored by me' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'involved', label: 'Involves me' },
  { id: 'review-requests', label: 'Review requests' },
];

function byUpdatedDesc(a: InboxItem, b: InboxItem): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The items one view shows, newest first.
 *
 * "involved" is deliberately unfiltered: every item in the merged cache is
 * there because some search returned it, so "any role" means "everything" --
 * including an item no Inbox section wants, which is exactly the case the
 * spec calls out ("absent from the Inbox view but present in Involves me").
 */
export function itemsForView(items: InboxItem[], view: InboxViewId): InboxItem[] {
  switch (view) {
    case 'inbox':
      return items.filter((item) => sectionFor(item) !== null).sort(byUpdatedDesc);
    case 'authored':
      return items.filter((item) => item.roles.includes('author')).sort(byUpdatedDesc);
    case 'assigned':
      return items.filter((item) => item.roles.includes('assignee')).sort(byUpdatedDesc);
    case 'involved':
      return [...items].sort(byUpdatedDesc);
    case 'review-requests':
      return items
        .filter(
          (item) =>
            item.roles.includes('review-requested-direct') ||
            item.roles.includes('review-requested-team')
        )
        .sort(byUpdatedDesc);
  }
}

export interface SectionedItems {
  section: InboxSection;
  items: InboxItem[];
}

/**
 * The sectioned Inbox view: every section in INBOX_SECTIONS' display order,
 * empty ones included, so the list always shows the same seven headings with
 * their counts -- as GitHub does -- rather than a shape that shifts with the
 * data.
 */
export function groupBySection(items: InboxItem[]): SectionedItems[] {
  const buckets = new Map<InboxSection, InboxItem[]>();
  for (const { id } of INBOX_SECTIONS) buckets.set(id, []);
  for (const item of items) {
    const section = sectionFor(item);
    if (section) buckets.get(section)?.push(item);
  }
  return INBOX_SECTIONS.map(({ id }) => ({
    section: id,
    items: (buckets.get(id) ?? []).sort(byUpdatedDesc),
  }));
}
