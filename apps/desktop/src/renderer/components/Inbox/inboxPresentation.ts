import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import { isParked, worstStatus, type Attention } from '../../../shared/attention';
import type { AttentionMap } from '../../utils/sessionStatus';
import { relativeSince } from '../../utils/relativeSince';

/** Human age of a fetch: 'just now', '2m ago', '3h ago', '2d ago', 'never'. */
export function formatAge(fetchedAt: number, now: number = Date.now()): string {
  if (!fetchedAt) return 'never';
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Compact age for a row -- "5h", "2w" -- because the row is lean on purpose
 * and "Updated 5 hours ago" is the pane's job. Weeks and months are the
 * calendar-free kind (7 and 30 days); a row does not need better.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  return relativeSince(then, now);
}

/** GitHub's wording for the review decision; nothing for a PR nobody has to decide on. */
export function reviewStateLabel(item: InboxItem): string | null {
  switch (item.reviewDecision) {
    case 'approved':
      return 'Approved';
    case 'changes-requested':
      return 'Changes requested';
    case 'review-required':
      return 'Awaiting approval';
    default:
      return null;
  }
}

export interface ChecksLabel {
  text: string;
  tone: 'ok' | 'warn' | 'bad';
}

/**
 * "3/5" toned by the worst thing in the set: one failure is red however
 * many passed, one pending check is amber, all green is green.
 */
export function checksLabel(checks: InboxItem['checks']): ChecksLabel | null {
  if (!checks || checks.total === 0) return null;
  const tone: ChecksLabel['tone'] = checks.failed > 0 ? 'bad' : checks.pending > 0 ? 'warn' : 'ok';
  return { text: `${checks.passed}/${checks.total}`, tone };
}

/** The left accent bar marks reviews asked of you personally, as on github.com. */
export function hasAccentBar(item: InboxItem): boolean {
  return item.roles.includes('review-requested-direct');
}

/**
 * Whether the repo has a local clone, given main's answer so far. Unknown
 * reads as cloned: the resolution is fire-and-forget after each snapshot,
 * and the launch path re-checks authoritatively, so an optimistic row can
 * never mis-launch -- while a pessimistic one would grey every row for the
 * first half-second of every refresh.
 */
export function isRepoCloned(
  resolved: Record<string, string | null> | undefined,
  repo: string,
): boolean {
  if (!resolved) return true;
  return resolved[repo] !== null;
}

/**
 * A workspace's sessions bucketed by the item they are linked to, keyed by
 * workItemKey so repo casing never splits one item in two. Computed once
 * per render of the list rather than once per row.
 */
export function groupSessionsByWorkItem(sessions: Session[]): Map<string, Session[]> {
  const grouped = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.workItem) continue;
    const key = workItemKey(session.workItem);
    const bucket = grouped.get(key) ?? [];
    bucket.push(session);
    grouped.set(key, bucket);
  }
  return grouped;
}

/** The one dot a row shows for its sessions: the most urgent of them. */
export function worstStatusForItem(linked: Session[], attention: AttentionMap): Attention {
  // A snoozed or settled session is put away: it says nothing about the item.
  return (
    worstStatus(
      linked
        .map((session) => attention[session.id] ?? 'ready')
        .filter((status) => !isParked(status)),
    ) ?? 'ready'
  );
}

/** The platform's modifier, as its keycap reads. */
export const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

/** ⌘↵ (Ctrl+Enter elsewhere): what submits every multi-line field in the Inbox. */
export const isSubmitChord = (event: { key: string; metaKey: boolean; ctrlKey: boolean }) =>
  event.key === 'Enter' && (event.metaKey || event.ctrlKey);

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
