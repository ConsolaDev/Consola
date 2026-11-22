/**
 * What the info panel's Pull request section says about an item, one line
 * per fact: its checks, its review, its unresolved threads, what stands in
 * the way of a merge, and an issue's comments. Pure, so the wording is
 * decided here and the section only draws it. The words for a decision or a
 * merge state are the pane's own (`reviewMeta`, `mergeStateMeta`), so the two
 * never disagree.
 */
import type {
  WorkItemDetails,
  WorkItemPerson,
  WorkItemThread,
  WorkItemTimelineItem,
} from '../../shared/workItemDetails';
import {
  mergeStateMeta,
  reviewMeta,
  summarizeChecks,
} from '../components/Inbox/workItemDetailPresentation';
import { plural } from './branchLines';

/** Where in the Pull request tab's pane a line has its place: the merge card, or Files changed. */
export type RevealTarget = 'merge' | 'files';

export function isRevealTarget(target: string): target is RevealTarget {
  return target === 'merge' || target === 'files';
}

export interface InfoLine {
  text: string;
  /** A short fact at the line's end. */
  value?: string;
  tone?: 'error' | 'muted';
  /** The place the pane has for this line; without one, the line opens the tab only. */
  reveal?: RevealTarget;
}

/** A reviewer's ring: a verdict, or still to give one. */
export type ReviewerRing = 'approved' | 'changes-requested' | 'waiting';

/**
 * The checks, worst first: any failing, else any still running, else how
 * many passed, else that every one was skipped. The value counts the passed
 * beside a failure or a run, and the skipped beside a pass. A skipped,
 * neutral or stale check never counts as passed, as in the pane's own
 * `2 passed · 1 skipped`.
 */
export function checksLine(checks: WorkItemDetails['checks']): InfoLine | null {
  const summary = summarizeChecks(checks);
  if (summary.total === 0) return null;
  const passed = `${summary.passing} ✓`;
  if (summary.failing > 0) {
    return {
      text: `${plural(summary.failing, 'check', 'checks')} failing`,
      value: passed,
      tone: 'error',
      reveal: 'merge',
    };
  }
  if (summary.pending > 0) return { text: 'Checks running', value: passed, reveal: 'merge' };
  if (summary.passing > 0) {
    return {
      text: `${plural(summary.passing, 'check', 'checks')} passed`,
      ...(summary.skipped > 0 ? { value: `${summary.skipped} skipped` } : {}),
      reveal: 'merge',
    };
  }
  return { text: `${plural(summary.skipped, 'check', 'checks')} skipped`, reveal: 'merge' };
}

/**
 * The review decision, and everyone a review is asked of or came from, each
 * ringed by where they stand: a verdict, or waiting (asked, commented, or
 * dismissed, which is no verdict).
 */
export function reviewLine(
  details: Pick<WorkItemDetails, 'reviewDecision' | 'reviewers'>,
): InfoLine & { reviewers: Array<{ who: WorkItemPerson; isTeam: boolean; ring: ReviewerRing }> } {
  return {
    text: reviewMeta(details.reviewDecision).label,
    ...(details.reviewDecision === 'CHANGES_REQUESTED' ? { tone: 'error' as const } : {}),
    reviewers: details.reviewers.map(({ who, isTeam, state }) => ({
      who,
      isTeam,
      ring: state === 'approved' || state === 'changes-requested' ? state : 'waiting',
    })),
  };
}

const RING_WORDS: Record<ReviewerRing, string> = {
  approved: 'approved',
  'changes-requested': 'changes requested',
  waiting: 'waiting',
};

/** Who the review line's avatars are, and where each stands, for its tooltip. */
export function reviewersSaid(
  reviewers: ReadonlyArray<{ who: WorkItemPerson; ring: ReviewerRing }>,
): string {
  return reviewers.map(({ who, ring }) => `${who.login}: ${RING_WORDS[ring]}`).join(', ');
}

/**
 * The threads still to resolve that others can see: a thread whose every
 * comment sits in the viewer's own draft review is not yet anyone's to answer.
 */
export function threadsLine(threads: readonly WorkItemThread[]): InfoLine | null {
  const unresolved = threads.filter(
    (thread) => !thread.isResolved && thread.comments.some((comment) => !comment.pending),
  ).length;
  if (unresolved === 0) return null;
  return { text: plural(unresolved, 'unresolved thread', 'unresolved threads'), reveal: 'files' };
}

/** What stands between an open pull request and a merge, in the pane's words. Nothing once it is done. */
export function mergeLine(
  details: Pick<WorkItemDetails, 'state' | 'mergeState' | 'baseBranch'>,
): InfoLine | null {
  if (details.state !== 'open' || !details.mergeState) return null;
  return {
    text: mergeStateMeta(details.mergeState, details.baseBranch).label,
    tone: 'muted',
    reveal: 'merge',
  };
}

/** An issue's comments: comments only, not the events between them. */
export function commentsLine(timeline: readonly WorkItemTimelineItem[]): InfoLine {
  const comments = timeline.filter((item) => item.kind === 'comment').length;
  return { text: plural(comments, 'comment', 'comments') };
}
