import type { InboxItem, InboxRole } from '../../../shared/workItems';

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
 * The one role a row leads with: the reason you were asked (a requested
 * review) outranks the reason you are merely attached (assignee, author) —
 * the precedence the parser used to apply before items carried every role.
 */
const ROLE_PRECEDENCE: InboxRole[] = [
  'review-requested-direct',
  'review-requested-team',
  'assignee',
  'author',
  'involved',
];

export function primaryRole(item: InboxItem): InboxRole | undefined {
  return ROLE_PRECEDENCE.find((role) => item.roles.includes(role));
}

export function roleLabelFor(item: InboxItem): string {
  switch (primaryRole(item)) {
    case 'review-requested-direct':
    case 'review-requested-team':
      return 'review requested';
    case 'assignee':
      return 'assigned to you';
    case 'author':
      return item.workItem.type === 'pr' ? 'your PR' : 'your issue';
    default:
      return 'involves you';
  }
}

/** The one-line subtitle under an item: repo · role · CI · review · +a −d. */
export function metaLineFor(item: InboxItem): string {
  const parts: string[] = [
    item.workItem.repo.split('/').pop() ?? item.workItem.repo,
    roleLabelFor(item),
  ];
  if (item.ciStatus) parts.push(`CI ${item.ciStatus}`);
  if (item.reviewDecision === 'changes-requested') parts.push('changes requested');
  if (item.reviewDecision === 'approved') parts.push('approved');
  if (item.additions !== undefined || item.deletions !== undefined) {
    parts.push(`+${item.additions ?? 0} −${item.deletions ?? 0}`);
  }
  return parts.join(' · ');
}

/** Status dot class: failing CI screams, requested reviews nudge, rest idle. */
export function dotClassFor(item: InboxItem): string {
  if (item.ciStatus === 'failing') return 'inbox-dot--err';
  const role = primaryRole(item);
  if (role === 'review-requested-direct' || role === 'review-requested-team') return 'inbox-dot--att';
  return 'inbox-dot--idle';
}
