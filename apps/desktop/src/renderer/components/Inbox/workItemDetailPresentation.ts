import type {
  DiffSide,
  WorkItemCommentItem,
  WorkItemCommitItem,
  WorkItemDetails,
  WorkItemEvent,
  WorkItemLabel,
  WorkItemPerson,
  WorkItemReactionContent,
  WorkItemReference,
  WorkItemReviewItem,
  WorkItemStateReason,
  WorkItemThread,
  WorkItemTimelineItem,
} from '../../../shared/workItemDetails';
import type { WorkItemRef } from '../../../shared/workItems';
import { formatAge } from './inboxPresentation';

type WorkItemType = WorkItemRef['type'];

/**
 * Presentation for the remote detail panel: how GitHub's raw states read,
 * and which semantic colour each one takes. Pure, so the wording is tested
 * once here rather than asserted through the DOM.
 *
 * A tone names a theme token, never a colour: `neutral` is secondary text,
 * `merged` is the one hue GitHub reserves for merged and completed work.
 */
export type Tone = 'success' | 'error' | 'warning' | 'merged' | 'accent' | 'neutral';

export interface Meta {
  label: string;
  tone: Tone;
}

type Check = WorkItemDetails['checks'][number];
export type CheckOutcome = 'failing' | 'pending' | 'passing' | 'skipped';

/** The states that offer "Fix failing checks in a session". */
const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const SKIPPED = new Set(['NEUTRAL', 'SKIPPED', 'STALE']);

export function isFailingCheck(state: string): boolean {
  return FAILING.has(state);
}

/** Anything GitHub has not finished deciding reads as pending, new states included. */
export function checkOutcome(state: string): CheckOutcome {
  if (FAILING.has(state)) return 'failing';
  if (state === 'SUCCESS') return 'passing';
  if (SKIPPED.has(state)) return 'skipped';
  return 'pending';
}

export const OUTCOME_TONE: Record<CheckOutcome, Tone> = {
  failing: 'error',
  pending: 'warning',
  passing: 'success',
  skipped: 'neutral',
};

const CHECK_LABELS: Record<string, string> = {
  SUCCESS: 'Passed',
  FAILURE: 'Failed',
  ERROR: 'Errored',
  STARTUP_FAILURE: 'Failed to start',
};

/** `IN_PROGRESS` → "In progress". */
function sentence(state: string): string {
  const words = state.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function checkLabel(state: string): string {
  return CHECK_LABELS[state] ?? sentence(state);
}

export interface CheckSummary {
  failing: number;
  pending: number;
  passing: number;
  skipped: number;
  total: number;
}

export function summarizeChecks(checks: Check[]): CheckSummary {
  const summary: CheckSummary = { failing: 0, pending: 0, passing: 0, skipped: 0, total: checks.length };
  for (const check of checks) summary[checkOutcome(check.state)]++;
  return summary;
}

const OUTCOME_ORDER: CheckOutcome[] = ['failing', 'pending', 'passing', 'skipped'];

/** Failing first, as github.com lists them; stable within a group. */
export function sortChecks(checks: Check[]): Check[] {
  return checks
    .map((check, index) => ({ check, index, rank: OUTCOME_ORDER.indexOf(checkOutcome(check.state)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ check }) => check);
}

export function checksSentence(summary: CheckSummary): string {
  if (summary.total === 0) return 'No checks';
  const parts = [
    summary.failing && `${summary.failing} failing`,
    summary.pending && `${summary.pending} pending`,
    summary.passing && `${summary.passing} passed`,
    summary.skipped && `${summary.skipped} skipped`,
  ];
  return parts.filter(Boolean).join(' · ');
}

export type StatusKind = 'pr-open' | 'pr-draft' | 'pr-merged' | 'pr-closed' | 'issue-open' | 'issue-closed' | 'issue-not-planned';

/**
 * The state badge. A completed issue is purple on GitHub, not red; one
 * closed as not planned (or as a duplicate) is grey, as GitHub greys it.
 */
export function itemStatus(
  type: WorkItemType,
  state: string,
  isDraft: boolean,
  stateReason?: WorkItemStateReason
): Meta & { kind: StatusKind } {
  if (type === 'issue') {
    if (state === 'open') return { label: 'Open', tone: 'success', kind: 'issue-open' };
    if (stateReason === 'not-planned') return { label: 'Closed as not planned', tone: 'neutral', kind: 'issue-not-planned' };
    if (stateReason === 'duplicate') return { label: 'Closed as duplicate', tone: 'neutral', kind: 'issue-not-planned' };
    return { label: 'Closed', tone: 'merged', kind: 'issue-closed' };
  }
  if (state === 'merged') return { label: 'Merged', tone: 'merged', kind: 'pr-merged' };
  if (state === 'closed') return { label: 'Closed', tone: 'error', kind: 'pr-closed' };
  if (isDraft) return { label: 'Draft', tone: 'neutral', kind: 'pr-draft' };
  return { label: 'Open', tone: 'success', kind: 'pr-open' };
}

/** Same words as the Inbox row (reviewStateLabel), so the two never disagree. */
export function reviewMeta(decision: string | undefined): Meta {
  switch (decision) {
    case 'APPROVED':
      return { label: 'Approved', tone: 'success' };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', tone: 'error' };
    case 'REVIEW_REQUIRED':
      return { label: 'Awaiting approval', tone: 'warning' };
    default:
      return { label: 'No review yet', tone: 'neutral' };
  }
}

/** GitHub's mergeStateStatus, in words a reviewer acts on. */
export function mergeStateMeta(state: string, baseBranch: string | undefined): Meta {
  switch (state) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { label: 'Ready to merge', tone: 'success' };
    case 'UNSTABLE':
      return { label: 'Mergeable, but checks are not passing', tone: 'warning' };
    case 'BLOCKED':
      return { label: 'Blocked until requirements pass', tone: 'warning' };
    case 'BEHIND':
      return { label: `Behind ${baseBranch ?? 'the base branch'}`, tone: 'warning' };
    case 'DIRTY':
      return { label: 'Merge conflicts', tone: 'error' };
    case 'UNKNOWN':
      return { label: 'Checking mergeability', tone: 'neutral' };
    default:
      return { label: sentence(state), tone: 'neutral' };
  }
}

/**
 * GitHub's merge button for a mergeStateStatus, which GitHub keeps for us.
 *
 * - `go`: green, nothing stands in the way (CLEAN, HAS_HOOKS).
 * - `plain`: allowed, but not green -- only optional checks are failing
 *   (UNSTABLE), so GitHub merges on request without endorsing it.
 * - `disabled`: GitHub would refuse. Blocked by requirements, behind a base
 *   that must be merged in, conflicted, a draft, or still being worked out.
 *
 * `canQueue` is whether auto-merge can wait out the refusal instead, as
 * GitHub offers "Enable auto-merge" in place of the disabled button. Only
 * requirements can be waited out: conflicts need a person, and a PR that
 * can merge now has nothing to wait for. Unrecognised and absent states are
 * refused, since green must never promise a merge GitHub will reject.
 */
export interface MergeGate {
  button: 'go' | 'plain' | 'disabled';
  canQueue: boolean;
}

export function mergeGate(state: string | undefined): MergeGate {
  switch (state) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { button: 'go', canQueue: false };
    case 'UNSTABLE':
      return { button: 'plain', canQueue: false };
    case 'BLOCKED':
    case 'BEHIND':
      return { button: 'disabled', canQueue: true };
    default:
      return { button: 'disabled', canQueue: false };
  }
}

/** What a review card's header says its author did. Only verdicts carry a colour. */
export function reviewVerb(state: WorkItemReviewItem['state']): { verb: string; tone?: Tone } {
  switch (state) {
    case 'APPROVED':
      return { verb: 'approved these changes', tone: 'success' };
    case 'CHANGES_REQUESTED':
      return { verb: 'requested changes', tone: 'error' };
    case 'DISMISSED':
      return { verb: 'left a review, since dismissed' };
    default:
      return { verb: 'reviewed' };
  }
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** "3h ago" for recent activity, a date once relative time stops helping. */
export function commentAge(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  if (now - at < MONTH_MS) return formatAge(at, now);
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'context' | 'note';
  /** The raw line, sign included, so copying a diff copies the diff. */
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A unified-diff patch as rows, each side numbered from its hunk header. */
export function parsePatch(patch: string): DiffRow[] {
  const lines = patch.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of lines) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text });
    } else if (text.startsWith('\\')) {
      rows.push({ kind: 'note', text });
    } else if (text.startsWith('+')) {
      rows.push({ kind: 'add', text, newLine: newLine++ });
    } else if (text.startsWith('-')) {
      rows.push({ kind: 'del', text, oldLine: oldLine++ });
    } else {
      rows.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return rows;
}

/** GitHub's five-square diffstat: the split between added and removed lines. */
export function diffBlocks(additions: number, deletions: number): ('add' | 'del' | 'none')[] {
  const total = additions + deletions;
  if (total === 0) return Array(5).fill('none');
  let added = Math.round((5 * additions) / total);
  if (additions > 0 && added === 0) added = 1;
  if (deletions > 0 && added === 5) added = 4;
  return Array.from({ length: 5 }, (_, index) => (index < added ? 'add' : 'del'));
}

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

export function fileStatus(status: string): Meta {
  switch (status) {
    case 'added':
      return { label: 'Added', tone: 'success' };
    case 'removed':
      return { label: 'Deleted', tone: 'error' };
    case 'renamed':
      return { label: 'Renamed', tone: 'accent' };
    case 'copied':
      return { label: 'Copied', tone: 'accent' };
    case 'unchanged':
      return { label: 'Unchanged', tone: 'neutral' };
    default:
      return { label: 'Modified', tone: 'warning' };
  }
}

/** One letter for the avatar: the first one a login has. */
export function initial(login: string): string {
  return (login.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
}

// ---------------------------------------------------------------------------
// The conversation stream: what the timeline becomes on screen.

/** A piece of an event's sentence. Plain text, or something drawn its own way. */
export type Segment =
  | { text: string }
  | { strong: string }
  | { code: string }
  | { del: string }
  | { label: WorkItemLabel }
  | { ref: WorkItemReference };

/** Names an icon; the component owns the drawing. */
export type EventIcon =
  | 'label' | 'pencil' | 'push' | 'eye' | 'person' | 'link' | 'draft' | 'ready' | 'pr-closed' | 'issue-closed'
  | 'not-planned' | 'reopened' | 'merged' | 'branch' | 'approved' | 'changes' | 'review' | 'commit';

export interface StreamEvent {
  kind: 'event';
  id: string;
  actor: WorkItemPerson;
  createdAt: string;
  icon: EventIcon;
  tone?: Tone;
  sentence: Segment[];
}

export type StreamEntry =
  | { kind: 'comment'; item: WorkItemCommentItem }
  | { kind: 'review'; item: WorkItemReviewItem; threads: WorkItemThread[] }
  | { kind: 'commits'; id: string; commits: WorkItemCommitItem[] }
  | StreamEvent;

/** One sentence per event, as GitHub words it. `type` is the item the timeline belongs to. */
export function eventSentence(event: WorkItemEvent, type: WorkItemType): { icon: EventIcon; tone?: Tone; sentence: Segment[] } {
  const noun = type === 'pr' ? 'pull request' : 'issue';
  switch (event.kind) {
    case 'labeled':
      return { icon: 'label', sentence: [{ text: 'added' }, { label: event.label }] };
    case 'unlabeled':
      return { icon: 'label', sentence: [{ text: 'removed' }, { label: event.label }] };
    case 'renamed':
      return { icon: 'pencil', sentence: [{ text: 'changed the title' }, { del: event.from }, { strong: event.to }] };
    case 'force-pushed':
      return {
        icon: 'push',
        sentence: event.before && event.after
          ? [{ text: 'force-pushed' }, { code: event.ref }, { text: 'from' }, { code: event.before }, { text: 'to' }, { code: event.after }]
          : [{ text: 'force-pushed' }, { code: event.ref }],
      };
    case 'review-requested':
      return event.reviewer === event.actor.login
        ? { icon: 'eye', sentence: [{ text: 'requested their own review' }] }
        : { icon: 'eye', sentence: [{ text: 'requested a review from' }, { strong: event.reviewer }] };
    case 'review-request-removed':
      return { icon: 'eye', sentence: [{ text: 'removed the request for review from' }, { strong: event.reviewer }] };
    case 'assigned':
      return event.assignee === event.actor.login
        ? { icon: 'person', sentence: [{ text: 'self-assigned this' }] }
        : { icon: 'person', sentence: [{ text: 'assigned' }, { strong: event.assignee }] };
    case 'unassigned':
      return event.assignee === event.actor.login
        ? { icon: 'person', sentence: [{ text: 'removed their assignment' }] }
        : { icon: 'person', sentence: [{ text: 'unassigned' }, { strong: event.assignee }] };
    case 'cross-referenced':
      return {
        icon: 'link',
        sentence: event.willClose
          ? [{ text: `linked a pull request that will close this ${noun}` }, { ref: event.source }]
          : [{ text: 'mentioned this in' }, { ref: event.source }],
      };
    case 'ready-for-review':
      return { icon: 'ready', tone: 'success', sentence: [{ text: 'marked this pull request as ready for review' }] };
    case 'converted-to-draft':
      return { icon: 'draft', sentence: [{ text: 'marked this pull request as draft' }] };
    case 'closed':
      if (type === 'pr') return { icon: 'pr-closed', tone: 'error', sentence: [{ text: 'closed this' }] };
      if (event.stateReason === 'not-planned') return { icon: 'not-planned', tone: 'neutral', sentence: [{ text: 'closed this as not planned' }] };
      if (event.stateReason === 'duplicate') return { icon: 'not-planned', tone: 'neutral', sentence: [{ text: 'closed this as a duplicate' }] };
      return {
        icon: 'issue-closed',
        tone: 'merged',
        sentence: [{ text: event.stateReason === 'completed' ? 'closed this as completed' : 'closed this' }],
      };
    case 'reopened':
      return { icon: 'reopened', tone: 'success', sentence: [{ text: 'reopened this' }] };
    case 'merged':
      return {
        icon: 'merged',
        tone: 'merged',
        sentence: event.commit
          ? [{ text: 'merged commit' }, { code: event.commit }, { text: 'into' }, { code: event.base }]
          : [{ text: 'merged this into' }, { code: event.base }],
      };
    case 'base-ref-changed':
      return { icon: 'branch', sentence: [{ text: 'changed the base branch from' }, { code: event.from }, { text: 'to' }, { code: event.to }] };
    case 'head-ref-deleted':
      return { icon: 'branch', sentence: [{ text: 'deleted the' }, { code: event.ref }, { text: 'branch' }] };
    case 'head-ref-restored':
      return { icon: 'branch', sentence: [{ text: 'restored the head branch' }] };
  }
}

/** A sentence as plain words, for tests and accessible names. */
export function sentenceText(sentence: Segment[]): string {
  return sentence
    .map((segment) =>
      'text' in segment ? segment.text
        : 'strong' in segment ? segment.strong
          : 'code' in segment ? segment.code
            : 'del' in segment ? segment.del
              : 'label' in segment ? segment.label.name
                : `${segment.ref.title} #${segment.ref.number}`)
    .join(' ');
}

const LABEL_GROUP_MS = 60_000;
const isLabelEvent = (item: WorkItemTimelineItem): item is Extract<WorkItemEvent, { kind: 'labeled' | 'unlabeled' }> =>
  item.kind === 'labeled' || item.kind === 'unlabeled';

/** "added frontend catalog and removed bug": one line for one person's labelling, as GitHub folds it. */
function labelSentence(events: Extract<WorkItemEvent, { kind: 'labeled' | 'unlabeled' }>[]): Segment[] {
  const added = events.filter((event) => event.kind === 'labeled').map((event) => ({ label: event.label }));
  const removed = events.filter((event) => event.kind === 'unlabeled').map((event) => ({ label: event.label }));
  if (added.length && removed.length) return [{ text: 'added' }, ...added, { text: 'and removed' }, ...removed];
  return added.length ? [{ text: 'added' }, ...added] : [{ text: 'removed' }, ...removed];
}

/**
 * The timeline as the stream draws it, oldest first:
 *
 * - Comments are cards. A review is a card when it says something (a body)
 *   or opened threads; its threads sit inside it, as on GitHub.
 * - A review that only replied to threads already open has no card: its
 *   replies are in those threads. One with only a verdict is a line.
 * - Consecutive commits are one run, whoever wrote them.
 * - One person's labelling in the same minute is one line.
 *
 * A thread is placed by the review its first comment was written in. One
 * whose review is not in the timeline still shows, in a card of its own at
 * its first comment's time, rather than vanish. Threads still pending (the
 * viewer's own draft review) are not history yet, so they are left to Files
 * changed.
 */
export function buildStream(timeline: WorkItemTimelineItem[], threads: WorkItemThread[], type: WorkItemType): StreamEntry[] {
  const submitted = threads.filter((thread) => thread.comments.length > 0 && !thread.comments[0].pending);
  const byReview = new Map<string, WorkItemThread[]>();
  for (const thread of submitted) {
    const review = thread.comments[0].reviewId ?? '';
    byReview.set(review, [...(byReview.get(review) ?? []), thread]);
  }
  const reviewIds = new Set(timeline.filter((item) => item.kind === 'review').map((item) => item.id));

  const entries: StreamEntry[] = [];
  for (let index = 0; index < timeline.length; index++) {
    const item = timeline[index];
    if (item.kind === 'comment') {
      entries.push({ kind: 'comment', item });
    } else if (item.kind === 'review') {
      const own = byReview.get(item.id) ?? [];
      if (item.body.trim() || own.length > 0) {
        entries.push({ kind: 'review', item, threads: own });
      } else if (item.state !== 'COMMENTED') {
        const { verb, tone } = reviewVerb(item.state);
        entries.push({
          kind: 'event', id: item.id, actor: item.author, createdAt: item.createdAt,
          icon: item.state === 'APPROVED' ? 'approved' : item.state === 'CHANGES_REQUESTED' ? 'changes' : 'review',
          ...(tone ? { tone } : {}), sentence: [{ text: verb }],
        });
      }
    } else if (item.kind === 'commit') {
      const commits = [item];
      while (timeline[index + 1]?.kind === 'commit') commits.push(timeline[++index] as WorkItemCommitItem);
      entries.push({ kind: 'commits', id: item.id, commits });
    } else if (isLabelEvent(item)) {
      const group = [item];
      for (let next = timeline[index + 1]; next && isLabelEvent(next) && next.actor.login === item.actor.login
        && Math.abs(Date.parse(next.createdAt) - Date.parse(item.createdAt)) <= LABEL_GROUP_MS; next = timeline[index + 1]) {
        group.push(next);
        index++;
      }
      entries.push({ kind: 'event', id: item.id, actor: item.actor, createdAt: item.createdAt, icon: 'label', sentence: labelSentence(group) });
    } else {
      entries.push({ kind: 'event', id: item.id, actor: item.actor, createdAt: item.createdAt, ...eventSentence(item, type) });
    }
  }

  // Threads whose review the timeline does not have, each placed at its time.
  for (const [review, orphans] of byReview) {
    if (reviewIds.has(review)) continue;
    for (const thread of orphans) {
      const first = thread.comments[0];
      const card: StreamEntry = {
        kind: 'review',
        threads: [thread],
        item: { kind: 'review', id: `thread:${thread.id}`, author: first.author, body: '', url: first.url, createdAt: first.createdAt, reactions: [], viewerCanEdit: false, state: 'COMMENTED' },
      };
      const at = entries.findIndex((entry) => entryTime(entry) > first.createdAt);
      entries.splice(at < 0 ? entries.length : at, 0, card);
    }
  }
  return entries;
}

function entryTime(entry: StreamEntry): string {
  return entry.kind === 'commits' ? entry.commits[0].createdAt : entry.kind === 'event' ? entry.createdAt : entry.item.createdAt;
}

/** "simon-sprocket added 3 commits", or "… and others" when they are not all one person's. */
export function commitRunSentence(commits: WorkItemCommitItem[]): { actor: WorkItemPerson; text: string } {
  const actor = commits[0].author;
  const others = commits.some((commit) => commit.author.login !== actor.login);
  return { actor, text: `${others ? 'and others ' : ''}added ${commits.length} commit${commits.length === 1 ? '' : 's'}` };
}

/** Only comments and reviews: what the Conversation tab counts. */
export function conversationCount(timeline: WorkItemTimelineItem[]): number {
  return timeline.filter((item) => item.kind === 'comment' || item.kind === 'review').length;
}

export const REACTION_EMOJI: Record<WorkItemReactionContent, string> = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
};

/** A comment quoted for a reply, as GitHub's Quote reply does: every line marked, then room to write. */
export function quoteReply(body: string): string {
  return `${body.trim().split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n`;
}

// ---------------------------------------------------------------------------
// The merge card.

export interface MergeRow {
  key: 'reviews' | 'checks' | 'branch' | 'draft';
  tone: Tone;
  title: string;
  detail: string;
  /** Whether this row is something that stops the merge, so the card need not say so twice. */
  blocking: boolean;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One row per thing that stands between the pull request and a merge, in GitHub's order. */
export function mergeRows(details: Pick<WorkItemDetails, 'isDraft' | 'reviewDecision' | 'reviewers' | 'checks' | 'mergeState' | 'baseBranch'>): MergeRow[] {
  if (details.isDraft) {
    return [{ key: 'draft', tone: 'neutral', title: 'This pull request is still a draft', detail: 'It can’t be merged until it’s marked ready for review.', blocking: true }];
  }
  const rows: MergeRow[] = [];
  const approvals = details.reviewers.filter((reviewer) => reviewer.state === 'approved').length;
  const changes = details.reviewers.filter((reviewer) => reviewer.state === 'changes-requested').length;
  const awaiting = details.reviewers.filter((reviewer) => reviewer.state === 'requested').length;
  const waiting = awaiting ? ` · ${awaiting} awaiting review` : '';
  if (details.reviewDecision === 'CHANGES_REQUESTED' || changes > 0) {
    rows.push({ key: 'reviews', tone: 'error', title: 'Changes requested', detail: `${count(Math.max(changes, 1), 'review')} requesting changes${waiting}`, blocking: details.reviewDecision === 'CHANGES_REQUESTED' });
  } else if (details.reviewDecision === 'REVIEW_REQUIRED') {
    rows.push({
      key: 'reviews', tone: 'warning', title: 'Review required',
      detail: `${approvals ? `${count(approvals, 'approving review')}, more required` : 'At least one approving review is required'}${waiting}`,
      blocking: true,
    });
  } else if (details.reviewDecision === 'APPROVED' || approvals > 0) {
    rows.push({ key: 'reviews', tone: 'success', title: 'Approved', detail: `${count(Math.max(approvals, 1), 'approving review')}${waiting}`, blocking: false });
  } else {
    rows.push({ key: 'reviews', tone: 'neutral', title: 'No reviews yet', detail: awaiting ? `${awaiting} awaiting review` : 'Reviews aren’t required to merge', blocking: false });
  }

  const summary = summarizeChecks(details.checks);
  if (summary.total > 0) {
    const detail = checksSentence(summary);
    if (summary.failing) rows.push({ key: 'checks', tone: 'error', title: 'Some checks were not successful', detail, blocking: true });
    else if (summary.pending) rows.push({ key: 'checks', tone: 'warning', title: 'Checks pending', detail, blocking: true });
    else if (summary.passing) rows.push({ key: 'checks', tone: 'success', title: 'All checks have passed', detail, blocking: false });
    else rows.push({ key: 'checks', tone: 'neutral', title: 'All checks were skipped', detail, blocking: false });
  }

  const base = details.baseBranch ?? 'the base branch';
  switch (details.mergeState) {
    case 'BEHIND':
      rows.push({ key: 'branch', tone: 'warning', title: `This branch is behind ${base}`, detail: `Merge the latest changes from ${base} into this branch.`, blocking: true });
      break;
    case 'DIRTY':
      rows.push({ key: 'branch', tone: 'error', title: 'This branch has conflicts', detail: 'They must be resolved before it can merge.', blocking: true });
      break;
    case 'UNKNOWN':
    case undefined:
      rows.push({ key: 'branch', tone: 'neutral', title: 'Checking mergeability…', detail: 'GitHub is working out whether this can merge.', blocking: true });
      break;
    default:
      rows.push({ key: 'branch', tone: 'success', title: 'No conflicts with the base branch', detail: 'Merging can be performed automatically.', blocking: false });
  }
  return rows;
}

/**
 * Why GitHub refuses, when none of the rows already says it — a ruleset,
 * signed commits — over the button it explains. Empty when a row does.
 */
export function mergeRefusal(rows: MergeRow[], gate: MergeGate, mergeState: string | undefined, baseBranch: string | undefined): string {
  if (gate.button === 'go' || rows.some((row) => row.blocking && row.tone !== 'success')) return '';
  const label = mergeStateMeta(mergeState ?? 'UNKNOWN', baseBranch).label;
  return gate.button === 'disabled' ? `Can’t merge yet: ${label.charAt(0).toLowerCase()}${label.slice(1)}.` : `${label}.`;
}

export const MERGE_METHODS = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
} as const;
export type MergeMethod = keyof typeof MERGE_METHODS;

/** The comment box's close button, which takes typed text along as GitHub's does. */
export function closeLabel(type: WorkItemType, hasText: boolean): string {
  if (hasText) return 'Close with comment';
  return type === 'pr' ? 'Close pull request' : 'Close issue';
}

export function reopenLabel(type: WorkItemType, hasText: boolean): string {
  if (hasText) return 'Reopen with comment';
  return type === 'pr' ? 'Reopen pull request' : 'Reopen issue';
}

// ---------------------------------------------------------------------------
// Commenting on lines of a diff.

export interface LineAnchor {
  side: DiffSide;
  line: number;
}

/** Where a comment on this row lands. Added and unchanged lines are the new side, removed lines the old. */
export function rowAnchor(row: DiffRow): LineAnchor | null {
  if (row.kind === 'add' && row.newLine) return { side: 'RIGHT', line: row.newLine };
  if (row.kind === 'del' && row.oldLine) return { side: 'LEFT', line: row.oldLine };
  if (row.kind === 'context' && row.newLine) return { side: 'RIGHT', line: row.newLine };
  return null;
}

/** For each row, the index of the hunk it is in. */
export function hunkOf(rows: DiffRow[]): number[] {
  let hunk = -1;
  return rows.map((row) => (row.kind === 'hunk' ? ++hunk : Math.max(hunk, 0)));
}

export interface LineRange {
  line: number;
  side: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
}

/**
 * The lines a selection from row `a` to row `b` comments on, either way
 * round. Null when either end is not a line, or the two are in different
 * hunks: GitHub anchors a range inside one hunk.
 */
export function selectionRange(rows: DiffRow[], a: number, b: number): LineRange | null {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const start = rows[from] && rowAnchor(rows[from]);
  const end = rows[to] && rowAnchor(rows[to]);
  if (!start || !end) return null;
  const hunks = hunkOf(rows);
  if (hunks[from] !== hunks[to]) return null;
  return from === to ? end : { ...end, startLine: start.line, startSide: start.side };
}

const sign = (side: DiffSide) => (side === 'LEFT' ? '−' : '+');

/** "Commenting on lines +21 to +22". */
export function rangeLabel(range: LineRange): string {
  const end = `${sign(range.side)}${range.line}`;
  return range.startLine === undefined
    ? `Commenting on line ${end}`
    : `Commenting on lines ${sign(range.startSide!)}${range.startLine} to ${end}`;
}

/**
 * The selected lines as they read after the change, for "Suggest a change".
 * Null when the selection has none (only removed lines): there is nothing on
 * the new side to suggest a replacement for.
 */
export function suggestionText(rows: DiffRow[], a: number, b: number): string | null {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const lines = rows.slice(from, to + 1).filter((row) => row.kind === 'add' || row.kind === 'context').map((row) => row.text.slice(1));
  return lines.length ? lines.join('\n') : null;
}

/** The row a thread sits under in the diff, or -1 when its line is not in this patch. */
export function threadRow(rows: DiffRow[], thread: Pick<WorkItemThread, 'line' | 'side'>): number {
  if (thread.line === undefined) return -1;
  return rows.findIndex((row) => {
    const anchor = rowAnchor(row);
    if (thread.side === 'LEFT') return (row.kind === 'del' || row.kind === 'context') && row.oldLine === thread.line;
    return anchor?.side === 'RIGHT' && anchor.line === thread.line;
  });
}

/** "src/billing.ts:7", or the line it was written on once outdated. */
export function threadLocation(thread: Pick<WorkItemThread, 'path' | 'line' | 'originalLine' | 'startLine'>): string {
  const { name } = splitPath(thread.path);
  const line = thread.line ?? thread.originalLine;
  if (line === undefined) return name;
  return thread.startLine !== undefined && thread.line !== undefined ? `${name}:${thread.startLine}–${line}` : `${name}:${line}`;
}

// ---------------------------------------------------------------------------
// Label colours: GitHub's own, in Consola's tinted pill.

type Rgb = [number, number, number];

const PANE_BACKGROUND: Record<'dark' | 'light', Rgb> = { dark: [5, 5, 5], light: [255, 255, 255] };
export const LABEL_FILL_ALPHA = 0.18;
export const LABEL_BORDER_ALPHA = 0.4;
const MIN_CONTRAST = 4.5;

const hexRgb = (hex: string): Rgb => [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb;
const toHex = (rgb: Rgb) => `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const over = (color: Rgb, alpha: number, background: Rgb): Rgb =>
  color.map((channel, index) => channel * alpha + background[index] * (1 - alpha)) as Rgb;

function rgbToHsl([r, g, b]: Rgb): Rgb {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: Rgb): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/**
 * A label's text in its own hue, lightened (dark theme) or darkened (light)
 * until it reads at 4.5:1 on its own pill: the label's colour at low alpha
 * over the pane.
 */
function readableOn(color: Rgb, theme: 'dark' | 'light'): Rgb {
  const fill = over(color, LABEL_FILL_ALPHA, PANE_BACKGROUND[theme]);
  const [h, s, l] = rgbToHsl(color);
  const step = theme === 'dark' ? 0.01 : -0.01;
  for (let lightness = l; lightness >= 0 && lightness <= 1; lightness += step) {
    const candidate = hslToRgb([h, s, lightness]).map(Math.round) as Rgb;
    if (contrast(candidate, fill) >= MIN_CONTRAST) return candidate;
  }
  return theme === 'dark' ? [255, 255, 255] : [0, 0, 0];
}

export interface LabelColors {
  fill: string;
  border: string;
  /** Text on the dark theme's pane, and on the light one's. */
  dark: string;
  light: string;
}

const labelColorCache = new Map<string, LabelColors>();

export function labelColors(hex: string): LabelColors {
  const key = /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : '888888';
  const known = labelColorCache.get(key);
  if (known) return known;
  const rgb = hexRgb(key);
  const colors = {
    fill: `rgba(${rgb.join(', ')}, ${LABEL_FILL_ALPHA})`,
    border: `rgba(${rgb.join(', ')}, ${LABEL_BORDER_ALPHA})`,
    dark: toHex(readableOn(rgb, 'dark')),
    light: toHex(readableOn(rgb, 'light')),
  };
  labelColorCache.set(key, colors);
  return colors;
}

/** For tests: how a label's text reads on its pill in each theme. */
export function labelContrast(hex: string, theme: 'dark' | 'light'): number {
  const rgb = hexRgb(hex);
  return contrast(hexRgb(labelColors(hex)[theme].slice(1)), over(rgb, LABEL_FILL_ALPHA, PANE_BACKGROUND[theme]));
}
