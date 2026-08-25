import type { InboxItem } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';
import type { Session } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import { sessionStatusFor, worstStatus, type SessionStatus } from '../../utils/sessionStatus';

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
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
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
  repo: string
): boolean {
  if (!resolved) return true;
  return resolved[repo] !== null;
}

/** The strongest reason an item is in the inbox, for the strip's meta line. */
export function roleLabelFor(item: InboxItem): string {
  if (item.roles.includes('review-requested-direct')) return 'review requested';
  if (item.roles.includes('review-requested-team')) return 'team review requested';
  if (item.roles.includes('author')) return item.workItem.type === 'pr' ? 'your PR' : 'your issue';
  if (item.roles.includes('assignee')) return 'assigned to you';
  return 'involves you';
}

/** The one-line subtitle the strip shows: repo · role · CI · review · +a −d. */
export function metaLineFor(item: InboxItem): string {
  const parts: string[] = [
    item.workItem.repo.split('/').pop() ?? item.workItem.repo,
    roleLabelFor(item),
  ];
  if (item.ciStatus) parts.push(`CI ${item.ciStatus}`);
  const review = reviewStateLabel(item);
  if (review) parts.push(review.toLowerCase());
  if (item.additions !== undefined || item.deletions !== undefined) {
    parts.push(`+${item.additions ?? 0} −${item.deletions ?? 0}`);
  }
  return parts.join(' · ');
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
export function worstStatusForItem(
  linked: Session[],
  terminals: Record<string, TerminalState>
): SessionStatus {
  return worstStatus(linked.map((session) => sessionStatusFor(terminals[session.instanceId])));
}

/**
 * Status dot class for the still-live `Inbox/index.tsx` row: failing CI
 * screams, requested reviews nudge, everything else idles. Kept alongside
 * the GitHub-shaped helpers above -- rather than folded into roleLabelFor's
 * precedence -- because it only ever cared about the review-requested roles,
 * not the full strongest-reason ordering those now express.
 */
export function dotClassFor(item: InboxItem): string {
  if (item.ciStatus === 'failing') return 'inbox-dot--err';
  if (item.roles.includes('review-requested-direct') || item.roles.includes('review-requested-team')) {
    return 'inbox-dot--att';
  }
  return 'inbox-dot--idle';
}
