import type { InboxItem } from './workItems';

/**
 * The Inbox's sections — GitHub's own PR inbox, verbatim, plus the issues
 * assigned to you. Pure over InboxItem so the renderer sections the cache
 * and the settings panel filters actions by section without a round trip.
 */
export type InboxSection =
  | 'needs-your-review'
  | 'needs-team-review'
  | 'your-drafts'
  | 'needs-action'
  | 'ready-to-merge'
  | 'waiting'
  | 'issues';

/** Which item type a section holds. Every section but `issues` is PR-only. */
export function sectionItemType(section: InboxSection): 'pr' | 'issue' {
  return section === 'issues' ? 'issue' : 'pr';
}

/**
 * Display order (GitHub's, with Issues last). Precedence when an item
 * qualifies for several sections is sectionFor's business, not this list's.
 */
export const INBOX_SECTIONS: ReadonlyArray<{ id: InboxSection; label: string }> = [
  { id: 'needs-your-review', label: 'Needs your review' },
  { id: 'needs-team-review', label: "Needs your teams' review" },
  { id: 'your-drafts', label: 'Your drafts' },
  { id: 'waiting', label: 'Waiting for review or checks' },
  { id: 'needs-action', label: 'Needs action' },
  { id: 'ready-to-merge', label: 'Ready to merge' },
  { id: 'issues', label: 'Issues assigned to you' },
];

/** Sections that start collapsed: nothing in them is waiting on you. */
export const DEFAULT_COLLAPSED_SECTIONS: ReadonlySet<InboxSection> = new Set<InboxSection>([
  'needs-team-review',
  'your-drafts',
  'ready-to-merge',
]);

/**
 * The one section an item belongs to, or null when it belongs to none.
 *
 * First match wins, in the spec's order: the reason you were asked (a review
 * request) outranks the reason you are merely attached (authorship). An item
 * matching no row is absent from the Inbox view but still in "Involves me".
 */
export function sectionFor(item: InboxItem): InboxSection | null {
  const { roles } = item;
  if (item.workItem.type === 'pr') {
    if (roles.includes('review-requested-direct')) return 'needs-your-review';
    if (roles.includes('review-requested-team')) return 'needs-team-review';
    if (!roles.includes('author')) return null;
    if (item.isDraft) return 'your-drafts';
    if (item.reviewDecision === 'changes-requested' || item.ciStatus === 'failing') {
      return 'needs-action';
    }
    if (
      item.reviewDecision === 'approved' &&
      (item.ciStatus === 'passing' || item.ciStatus === undefined)
    ) {
      return 'ready-to-merge';
    }
    return 'waiting';
  }
  return roles.includes('assignee') ? 'issues' : null;
}
