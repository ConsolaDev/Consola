import { z } from 'zod';

/**
 * A pull request or issue as the Inbox pane reads it: the whole timeline,
 * review threads, the viewer's pending review. Provider-neutral: each
 * GitProviderDriver maps its own API onto these shapes, and the renderer
 * never sees the provider's.
 */

/** Someone shown beside what they did. */
export interface WorkItemPerson {
  login: string;
  /** Absent for a deleted account, or a commit author with no account. */
  avatarUrl?: string;
  isBot: boolean;
}

export interface WorkItemLabel {
  name: string;
  /** Six hex digits without '#', as the repository set it. */
  color: string;
}

export const WORK_ITEM_REACTIONS = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'] as const;
export type WorkItemReactionContent = (typeof WORK_ITEM_REACTIONS)[number];

export interface WorkItemReaction {
  content: WorkItemReactionContent;
  count: number;
  viewerReacted: boolean;
}

/** The description, a comment, a review's body, a comment in a thread. */
export interface WorkItemPost {
  /** The provider's id for it, which an edit is addressed by. */
  id: string;
  author: WorkItemPerson;
  body: string;
  url: string;
  createdAt: string;
  editedAt?: string;
  /** Only reactions someone gave. */
  reactions: WorkItemReaction[];
  /** Why it is hidden (`outdated`, `spam`, …), when it is. */
  minimized?: string;
  viewerCanEdit: boolean;
}

export interface WorkItemThreadComment extends WorkItemPost {
  /** In the viewer's pending review: nobody else can see it yet. */
  pending: boolean;
  viewerCanDelete: boolean;
  /** The review it was written in. */
  reviewId?: string;
}

export type DiffSide = 'LEFT' | 'RIGHT';

/** A conversation on lines of a pull request's diff. */
export interface WorkItemThread {
  id: string;
  path: string;
  /** Absent once outdated (the line is gone from the diff), or for a comment on the whole file. */
  line?: number;
  startLine?: number;
  side: DiffSide;
  startSide?: DiffSide;
  /** Where it was written, for an outdated thread's label. */
  originalLine?: number;
  /** The diff the first comment was made on, ending at its line. */
  diffHunk: string;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  viewerCanReply: boolean;
  comments: WorkItemThreadComment[];
}

export type WorkItemReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
export type WorkItemStateReason = 'completed' | 'not-planned' | 'duplicate' | 'reopened';

/** Another item an event points at. */
export interface WorkItemReference {
  type: 'pr' | 'issue';
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Lowercased: 'open', 'closed', 'merged'. */
  state: string;
}

interface TimelineBase {
  id: string;
  createdAt: string;
}

interface EventBase extends TimelineBase {
  actor: WorkItemPerson;
}

export type WorkItemCommentItem = WorkItemPost & { kind: 'comment' };
export type WorkItemReviewItem = WorkItemPost & { kind: 'review'; state: WorkItemReviewState };
export type WorkItemCommitItem = TimelineBase & {
  kind: 'commit';
  oid: string;
  headline: string;
  author: WorkItemPerson;
  url: string;
  /** The commit's combined check state, as the provider names it (SUCCESS, FAILURE, PENDING…). */
  checkState?: string;
};

export type WorkItemEvent =
  | (EventBase & { kind: 'labeled' | 'unlabeled'; label: WorkItemLabel })
  | (EventBase & { kind: 'renamed'; from: string; to: string })
  | (EventBase & { kind: 'force-pushed'; ref: string; before?: string; after?: string })
  | (EventBase & { kind: 'review-requested' | 'review-request-removed'; reviewer: string })
  | (EventBase & { kind: 'assigned' | 'unassigned'; assignee: string })
  | (EventBase & { kind: 'cross-referenced'; source: WorkItemReference; willClose: boolean })
  | (EventBase & { kind: 'ready-for-review' | 'converted-to-draft' | 'reopened' | 'head-ref-restored' })
  | (EventBase & { kind: 'closed'; stateReason?: WorkItemStateReason })
  | (EventBase & { kind: 'merged'; commit?: string; base: string })
  | (EventBase & { kind: 'base-ref-changed'; from: string; to: string })
  | (EventBase & { kind: 'head-ref-deleted'; ref: string });

/** In the order the provider lists them, oldest first. */
export type WorkItemTimelineItem = WorkItemCommentItem | WorkItemReviewItem | WorkItemCommitItem | WorkItemEvent;

export interface WorkItemReviewer {
  /** A team has its name as `login` and no avatar. */
  who: WorkItemPerson;
  isTeam: boolean;
  /** Their latest review, or `requested` while a review is asked of them. */
  state: 'approved' | 'changes-requested' | 'commented' | 'dismissed' | 'requested';
}

export interface WorkItemDetails {
  title: string;
  body: string;
  /** Lowercased: 'open', 'closed', 'merged'. */
  state: string;
  /** Issues: why it was closed. */
  stateReason?: WorkItemStateReason;
  isDraft: boolean;
  /** The author's login, as the pane's meta line shows it. */
  author: string;
  url: string;
  /** The account the details were read as. */
  viewer: WorkItemPerson;
  /** The description as the first post: author, time, reactions, whether the viewer may edit it. */
  description: WorkItemPost;
  labels: WorkItemLabel[];
  assignees: WorkItemPerson[];
  /** Pull requests only. */
  reviewers: WorkItemReviewer[];
  timeline: WorkItemTimelineItem[];
  /** Pull requests only, pending ones included (only the viewer sees those). */
  threads: WorkItemThread[];
  /** The viewer's review still being written, if any: one per person, as GitHub allows. */
  pendingReview?: { id: string; commentCount: number };
  checks: { name: string; state: string; url: string }[];
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
  additions?: number;
  deletions?: number;
  headOid?: string;
  headBranch?: string;
  baseBranch?: string;
  mergeState?: string;
  reviewDecision?: string;
  /** Whether the viewer may merge the base branch into this one. */
  canUpdateBranch?: boolean;
}

const body = z.string().trim().min(1).max(65536);
const optionalBody = z.string().trim().max(65536).optional();
/** A provider's opaque id for a comment, thread or review. */
const nodeId = z.string().min(1).max(200).regex(/^[\w=-]+$/);
const lineNumber = z.number().int().positive().max(10_000_000);
const side = z.enum(['LEFT', 'RIGHT']);
const commitOid = z.string().regex(/^[a-f0-9]{40,64}$/i);

export const workItemMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), body }),
  /** With a pending review, that review is the one submitted, its comments with it. */
  z.object({
    kind: z.literal('review'),
    event: z.enum(['approve', 'request-changes', 'comment']),
    body: z.string().trim().max(65536),
    pendingReviewId: nodeId.optional(),
  }),
  /** `comment` is posted as the item closes; `reason` is for issues. */
  z.object({ kind: z.literal('close'), reason: z.enum(['completed', 'not-planned']).optional(), comment: optionalBody }),
  z.object({ kind: z.literal('reopen'), comment: optionalBody }),
  z.object({ kind: z.literal('ready'), draft: z.boolean() }),
  z.object({ kind: z.literal('merge'), method: z.enum(['squash', 'merge', 'rebase']), headOid: commitOid, auto: z.boolean() }),
  z.object({ kind: z.literal('edit'), title: z.string().trim().min(1).max(256), body: z.string().max(65536) }),
  /** Merges the base branch into the head branch. */
  z.object({ kind: z.literal('update-branch') }),
  z.object({ kind: z.literal('edit-comment'), target: z.enum(['comment', 'review', 'review-comment']), id: nodeId, body }),
  /** Only a comment in the viewer's pending review can be deleted here. */
  z.object({ kind: z.literal('delete-comment'), id: nodeId }),
  z.object({ kind: z.literal('reply'), threadId: nodeId, body, pendingReviewId: nodeId.optional() }),
  z.object({ kind: z.literal('resolve-thread'), threadId: nodeId, resolved: z.boolean() }),
  /**
   * A comment on lines of the diff as it was at `headOid`. `single` posts it
   * at once; `review` holds it in the viewer's pending review, starting one
   * when there is none.
   */
  z.object({
    kind: z.literal('line-comment'),
    mode: z.enum(['single', 'review']),
    pendingReviewId: nodeId.optional(),
    headOid: commitOid,
    path: z.string().min(1).max(4096).regex(/^[^\0]+$/),
    line: lineNumber,
    side,
    startLine: lineNumber.optional(),
    startSide: side.optional(),
    body,
  }),
  z.object({ kind: z.literal('discard-review'), reviewId: nodeId }),
]);
export type WorkItemMutation = z.infer<typeof workItemMutationSchema>;
