import { z } from 'zod';
import type {
  WorkItemCommitItem,
  WorkItemDetails,
  WorkItemLabel,
  WorkItemPerson,
  WorkItemPost,
  WorkItemReference,
  WorkItemReviewer,
  WorkItemStateReason,
  WorkItemThread,
  WorkItemThreadComment,
  WorkItemTimelineItem,
} from '../../../shared/workItemDetails';
import { WORK_ITEM_REACTIONS } from '../../../shared/workItemDetails';

/**
 * An item's details from GitHub's GraphQL API, read into the neutral shapes
 * of shared/workItemDetails.
 *
 * GraphQL rather than REST because the timeline (`timelineItems` filtered to
 * the kinds the pane draws, so an unknown kind never arrives), review threads
 * with the ids resolving needs, the viewer's pending review, reactions and
 * avatars all come in a handful of queries. Changed files and their patches
 * stay on REST, which is the only place GitHub serves them.
 *
 * Parsing is strict about shape: a reply that is not the one asked for
 * throws, so a parse failure can never read as an item with no history.
 * Lenient only where GitHub is: a deleted author is `null` (a "ghost"), an
 * empty body is `null`.
 */

/** Requested once for every avatar, so the cache holds one image per person: 20px drawn on a 2× display. */
export const AVATAR_SIZE = 40;

const ACTOR = `__typename login avatarUrl(size: ${AVATAR_SIZE})`;
const REACTIONS = 'reactionGroups { content viewerHasReacted reactors { totalCount } }';
const POST = `id author { ${ACTOR} } body createdAt lastEditedAt url viewerCanUpdate ${REACTIONS}`;
const COMMENT = `${POST} isMinimized minimizedReason`;
const EVENT = `id createdAt actor { ${ACTOR} }`;
const REFERENCE = 'number title url state repository { nameWithOwner }';
const LABELS = 'labels(first: 100) { nodes { name color } }';
const ASSIGNEES = `assignees(first: 100) { nodes { ${ACTOR} } }`;
const CHECK_CONTEXT = '__typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }';
const THREAD_COMMENT = `${COMMENT} diffHunk state viewerCanDelete pullRequestReview { id }`;

/** What the timeline asks for, per type: the events the pane has a sentence for, and nothing else. */
const ISSUE_TIMELINE: Record<string, string> = {
  ISSUE_COMMENT: `... on IssueComment { ${COMMENT} }`,
  LABELED_EVENT: `... on LabeledEvent { ${EVENT} label { name color } }`,
  UNLABELED_EVENT: `... on UnlabeledEvent { ${EVENT} label { name color } }`,
  RENAMED_TITLE_EVENT: `... on RenamedTitleEvent { ${EVENT} previousTitle currentTitle }`,
  ASSIGNED_EVENT: `... on AssignedEvent { ${EVENT} assignee { ... on Actor { login } } }`,
  UNASSIGNED_EVENT: `... on UnassignedEvent { ${EVENT} assignee { ... on Actor { login } } }`,
  CROSS_REFERENCED_EVENT: `... on CrossReferencedEvent { ${EVENT} willCloseTarget source { __typename ... on Issue { ${REFERENCE} } ... on PullRequest { ${REFERENCE} } } }`,
  CLOSED_EVENT: `... on ClosedEvent { ${EVENT} stateReason }`,
  REOPENED_EVENT: `... on ReopenedEvent { ${EVENT} }`,
};

const PULL_REQUEST_TIMELINE: Record<string, string> = {
  ...ISSUE_TIMELINE,
  PULL_REQUEST_REVIEW: `... on PullRequestReview { ${COMMENT} state submittedAt }`,
  PULL_REQUEST_COMMIT: `... on PullRequestCommit { id url commit { oid messageHeadline committedDate statusCheckRollup { state } author { name avatarUrl(size: ${AVATAR_SIZE}) user { ${ACTOR} } } } }`,
  HEAD_REF_FORCE_PUSHED_EVENT: `... on HeadRefForcePushedEvent { ${EVENT} beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } ref { name } }`,
  REVIEW_REQUESTED_EVENT: `... on ReviewRequestedEvent { ${EVENT} requestedReviewer { __typename ... on Actor { login } ... on Team { name } } }`,
  REVIEW_REQUEST_REMOVED_EVENT: `... on ReviewRequestRemovedEvent { ${EVENT} requestedReviewer { __typename ... on Actor { login } ... on Team { name } } }`,
  READY_FOR_REVIEW_EVENT: `... on ReadyForReviewEvent { ${EVENT} }`,
  CONVERT_TO_DRAFT_EVENT: `... on ConvertToDraftEvent { ${EVENT} }`,
  MERGED_EVENT: `... on MergedEvent { ${EVENT} commit { abbreviatedOid } mergeRefName }`,
  BASE_REF_CHANGED_EVENT: `... on BaseRefChangedEvent { ${EVENT} previousRefName currentRefName }`,
  HEAD_REF_DELETED_EVENT: `... on HeadRefDeletedEvent { ${EVENT} headRefName }`,
  HEAD_REF_RESTORED_EVENT: `... on HeadRefRestoredEvent { ${EVENT} }`,
};

const ITEM_ARGS = '$owner: String!, $name: String!, $number: Int!';
const field = (type: 'pr' | 'issue') => (type === 'pr' ? 'pullRequest' : 'issue');

export const PULL_REQUEST_QUERY = `query ConsolaPullRequest(${ITEM_ARGS}) {
  viewer { ${ACTOR} }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${POST} title state isDraft ${LABELS} ${ASSIGNEES}
      reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on Actor { login avatarUrl(size: ${AVATAR_SIZE}) } ... on Team { name } } } }
      latestReviews(first: 100) { nodes { state author { ${ACTOR} } } }
      headRefOid headRefName baseRefName mergeStateStatus reviewDecision additions deletions viewerCanUpdateBranch
      reviews(states: [PENDING], first: 5) { nodes { id viewerDidAuthor comments { totalCount } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes { ${CHECK_CONTEXT} } } } } } }
    }
  }
}`;

export const ISSUE_QUERY = `query ConsolaIssue(${ITEM_ARGS}) {
  viewer { ${ACTOR} }
  repository(owner: $owner, name: $name) {
    issue(number: $number) { ${POST} title state stateReason ${LABELS} ${ASSIGNEES} }
  }
}`;

/** Paginated with `gh api --paginate`, which follows the one pageInfo in the reply: no other connection here may ask for one. */
export function timelineQuery(type: 'pr' | 'issue'): string {
  const kinds = type === 'pr' ? PULL_REQUEST_TIMELINE : ISSUE_TIMELINE;
  return `query Consola${type === 'pr' ? 'PullRequest' : 'Issue'}Timeline(${ITEM_ARGS}, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    ${field(type)}(number: $number) {
      timelineItems(first: 100, after: $endCursor, itemTypes: [${Object.keys(kinds).join(', ')}]) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename ${Object.values(kinds).join(' ')} }
      }
    }
  }
}`;
}

/** Paginated like the timeline; a thread with more than 100 comments is completed by THREAD_COMMENTS_QUERY. */
export const REVIEW_THREADS_QUERY = `query ConsolaReviewThreads(${ITEM_ARGS}, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine diffSide startDiffSide
          viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first: 100) { totalCount nodes { ${THREAD_COMMENT} } }
        }
      }
    }
  }
}`;

export const THREAD_COMMENTS_QUERY = `query ConsolaThreadComments($id: ID!, $endCursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT} } }
    }
  }
}`;

/** Only when the header's first hundred checks were not all of them. */
export const CHECKS_QUERY = `query ConsolaChecks(${ITEM_ARGS}, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT} } }
      } } } }
    }
  }
}`;

export const PULL_REQUEST_ID_QUERY = `query ConsolaPullRequestId(${ITEM_ARGS}) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

/** What a write addressed by id expects that id to be. */
export type OwnedNodeType = 'PullRequestReviewThread' | 'PullRequestReview' | 'PullRequestReviewComment' | 'IssueComment';

const OWNER_FIELDS = [
  '... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } }',
  '... on PullRequestReview { pullRequest { number repository { nameWithOwner } } }',
  '... on PullRequestReviewComment { pullRequest { number repository { nameWithOwner } } }',
  '... on IssueComment { issue { number } repository { nameWithOwner } }',
].join(' ');

/** One alias per id (`n0`, `n1`…), each asking which item it belongs to. */
export function nodeOwnersQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  return `query ConsolaNodeOwners(${indexes.map((index) => `$n${index}: ID!`).join(', ')}) {
  ${indexes.map((index) => `n${index}: node(id: $n${index}) { __typename ${OWNER_FIELDS} }`).join('\n  ')}
}`;
}

export const MUTATIONS = {
  submitReview: `mutation ConsolaSubmitReview($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) { pullRequestReview { id } }
}`,
  discardReview: `mutation ConsolaDiscardReview($id: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $id }) { pullRequestReview { id } }
}`,
  startReview: `mutation ConsolaStartReview($pullRequestId: ID!, $commit: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commit }) { pullRequestReview { id } }
}`,
  addThread: `mutation ConsolaAddThread($reviewId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, body: $body, path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide }) { thread { id } }
}`,
  reply: `mutation ConsolaReply($threadId: ID!, $body: String!, $reviewId: ID) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body, pullRequestReviewId: $reviewId }) { comment { id } }
}`,
  resolveThread: `mutation ConsolaResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`,
  unresolveThread: `mutation ConsolaUnresolveThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`,
  editComment: `mutation ConsolaEditComment($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } }
}`,
  editReview: `mutation ConsolaEditReview($id: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { pullRequestReview { id } }
}`,
  editReviewComment: `mutation ConsolaEditReviewComment($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id } }
}`,
  deleteReviewComment: `mutation ConsolaDeleteReviewComment($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) { pullRequestReview { id } }
}`,
} as const;

// ---------------------------------------------------------------------------
// Schemas.

const GHOST: WorkItemPerson = { login: 'ghost', isBot: false };

const actor = z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string().nullish() });
const nullableActor = actor.nullable();
type Actor = z.infer<typeof actor>;

function person(raw: Actor | null | undefined): WorkItemPerson {
  if (!raw) return GHOST;
  return { login: raw.login, ...(raw.avatarUrl ? { avatarUrl: raw.avatarUrl } : {}), isBot: raw.__typename === 'Bot' };
}

const reactionGroups = z
  .array(z.object({ content: z.enum(WORK_ITEM_REACTIONS), viewerHasReacted: z.boolean(), reactors: z.object({ totalCount: z.number() }) }))
  .nullish();

const post = z.object({
  id: z.string(),
  author: nullableActor,
  body: z.string().nullish(),
  createdAt: z.string(),
  lastEditedAt: z.string().nullish(),
  url: z.string(),
  viewerCanUpdate: z.boolean(),
  reactionGroups,
});
const minimizable = { isMinimized: z.boolean(), minimizedReason: z.string().nullish() };
const comment = post.extend(minimizable);
type RawPost = z.infer<typeof post> & { isMinimized?: boolean; minimizedReason?: string | null };

function toPost(raw: RawPost): WorkItemPost {
  return {
    id: raw.id,
    author: person(raw.author),
    body: raw.body ?? '',
    url: raw.url,
    createdAt: raw.createdAt,
    ...(raw.lastEditedAt ? { editedAt: raw.lastEditedAt } : {}),
    reactions: (raw.reactionGroups ?? [])
      .filter((group) => group.reactors.totalCount > 0)
      .map((group) => ({ content: group.content, count: group.reactors.totalCount, viewerReacted: group.viewerHasReacted })),
    ...(raw.isMinimized ? { minimized: (raw.minimizedReason ?? 'hidden').toLowerCase().replace(/_/g, ' ') } : {}),
    viewerCanEdit: raw.viewerCanUpdate,
  };
}

const label = z.object({ name: z.string(), color: z.string().regex(/^[0-9a-f]{6}$/i) });
const toLabel = (raw: z.infer<typeof label>): WorkItemLabel => ({ name: raw.name, color: raw.color.toLowerCase() });
const event = z.object({ id: z.string(), createdAt: z.string(), actor: nullableActor });
const named = z.object({ login: z.string() }).partial().nullable();
const reviewer = z.object({ __typename: z.string(), login: z.string().optional(), name: z.string().optional() }).nullable();
const reference = z.object({
  __typename: z.enum(['Issue', 'PullRequest']),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
});
const reviewState = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);

const timelineNode = z.discriminatedUnion('__typename', [
  comment.extend({ __typename: z.literal('IssueComment') }),
  comment.extend({ __typename: z.literal('PullRequestReview'), state: reviewState, submittedAt: z.string().nullish() }),
  z.object({
    __typename: z.literal('PullRequestCommit'),
    id: z.string(),
    url: z.string(),
    commit: z.object({
      oid: z.string(),
      messageHeadline: z.string(),
      committedDate: z.string(),
      statusCheckRollup: z.object({ state: z.string() }).nullish(),
      author: z.object({ name: z.string().nullish(), avatarUrl: z.string().nullish(), user: nullableActor.optional() }).nullable(),
    }),
  }),
  event.extend({
    __typename: z.literal('HeadRefForcePushedEvent'),
    beforeCommit: z.object({ abbreviatedOid: z.string() }).nullable(),
    afterCommit: z.object({ abbreviatedOid: z.string() }).nullable(),
    ref: z.object({ name: z.string() }).nullable(),
  }),
  event.extend({ __typename: z.literal('LabeledEvent'), label }),
  event.extend({ __typename: z.literal('UnlabeledEvent'), label }),
  event.extend({ __typename: z.literal('RenamedTitleEvent'), previousTitle: z.string(), currentTitle: z.string() }),
  event.extend({ __typename: z.literal('ReviewRequestedEvent'), requestedReviewer: reviewer }),
  event.extend({ __typename: z.literal('ReviewRequestRemovedEvent'), requestedReviewer: reviewer }),
  event.extend({ __typename: z.literal('AssignedEvent'), assignee: named }),
  event.extend({ __typename: z.literal('UnassignedEvent'), assignee: named }),
  event.extend({ __typename: z.literal('CrossReferencedEvent'), willCloseTarget: z.boolean(), source: reference }),
  event.extend({ __typename: z.literal('ReadyForReviewEvent') }),
  event.extend({ __typename: z.literal('ConvertToDraftEvent') }),
  event.extend({ __typename: z.literal('ClosedEvent'), stateReason: z.string().nullish() }),
  event.extend({ __typename: z.literal('ReopenedEvent') }),
  event.extend({ __typename: z.literal('MergedEvent'), commit: z.object({ abbreviatedOid: z.string() }).nullable(), mergeRefName: z.string() }),
  event.extend({ __typename: z.literal('BaseRefChangedEvent'), previousRefName: z.string(), currentRefName: z.string() }),
  event.extend({ __typename: z.literal('HeadRefDeletedEvent'), headRefName: z.string() }),
  event.extend({ __typename: z.literal('HeadRefRestoredEvent') }),
]);
type TimelineNode = z.infer<typeof timelineNode>;

const STATE_REASONS: Record<string, WorkItemStateReason> = {
  COMPLETED: 'completed',
  NOT_PLANNED: 'not-planned',
  DUPLICATE: 'duplicate',
  REOPENED: 'reopened',
};
/** An open enum: a reason GitHub adds later reads as a plain close rather than failing the pane. */
const stateReason = (raw: string | null | undefined) => (raw ? STATE_REASONS[raw] : undefined);

const reviewerName = (raw: z.infer<typeof reviewer>) => raw?.login ?? raw?.name ?? 'ghost';

function commitAuthor(raw: z.infer<typeof timelineNode> & { __typename: 'PullRequestCommit' }): WorkItemPerson {
  const author = raw.commit.author;
  if (author?.user) return person(author.user);
  const name = author?.name ?? 'unknown';
  return { login: name, ...(author?.avatarUrl ? { avatarUrl: author.avatarUrl } : {}), isBot: /\[bot\]$/.test(name) };
}

function toReference(raw: z.infer<typeof reference>): WorkItemReference {
  return {
    type: raw.__typename === 'PullRequest' ? 'pr' : 'issue',
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state.toLowerCase(),
  };
}

/** Null for the viewer's own pending review: it is not history yet, and the details carry it apart. */
function toTimelineItem(node: TimelineNode): WorkItemTimelineItem | null {
  const base = 'actor' in node ? { id: node.id, createdAt: node.createdAt, actor: person(node.actor) } : null;
  switch (node.__typename) {
    case 'IssueComment':
      return { kind: 'comment', ...toPost(node) };
    case 'PullRequestReview':
      if (node.state === 'PENDING') return null;
      return { kind: 'review', ...toPost(node), createdAt: node.submittedAt ?? node.createdAt, state: node.state };
    case 'PullRequestCommit': {
      const item: WorkItemCommitItem = {
        kind: 'commit',
        id: node.id,
        createdAt: node.commit.committedDate,
        oid: node.commit.oid,
        headline: node.commit.messageHeadline,
        author: commitAuthor(node),
        url: node.url,
        ...(node.commit.statusCheckRollup ? { checkState: node.commit.statusCheckRollup.state } : {}),
      };
      return item;
    }
    case 'HeadRefForcePushedEvent':
      return {
        kind: 'force-pushed',
        ...base!,
        ref: node.ref?.name ?? '',
        ...(node.beforeCommit ? { before: node.beforeCommit.abbreviatedOid } : {}),
        ...(node.afterCommit ? { after: node.afterCommit.abbreviatedOid } : {}),
      };
    case 'LabeledEvent':
    case 'UnlabeledEvent':
      return { kind: node.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled', ...base!, label: toLabel(node.label) };
    case 'RenamedTitleEvent':
      return { kind: 'renamed', ...base!, from: node.previousTitle, to: node.currentTitle };
    case 'ReviewRequestedEvent':
    case 'ReviewRequestRemovedEvent':
      return {
        kind: node.__typename === 'ReviewRequestedEvent' ? 'review-requested' : 'review-request-removed',
        ...base!,
        reviewer: reviewerName(node.requestedReviewer),
      };
    case 'AssignedEvent':
    case 'UnassignedEvent':
      return { kind: node.__typename === 'AssignedEvent' ? 'assigned' : 'unassigned', ...base!, assignee: node.assignee?.login ?? 'ghost' };
    case 'CrossReferencedEvent':
      return { kind: 'cross-referenced', ...base!, source: toReference(node.source), willClose: node.willCloseTarget };
    case 'ReadyForReviewEvent':
      return { kind: 'ready-for-review', ...base! };
    case 'ConvertToDraftEvent':
      return { kind: 'converted-to-draft', ...base! };
    case 'ReopenedEvent':
      return { kind: 'reopened', ...base! };
    case 'HeadRefRestoredEvent':
      return { kind: 'head-ref-restored', ...base! };
    case 'ClosedEvent': {
      const reason = stateReason(node.stateReason);
      return { kind: 'closed', ...base!, ...(reason ? { stateReason: reason } : {}) };
    }
    case 'MergedEvent':
      return { kind: 'merged', ...base!, ...(node.commit ? { commit: node.commit.abbreviatedOid } : {}), base: node.mergeRefName };
    case 'BaseRefChangedEvent':
      return { kind: 'base-ref-changed', ...base!, from: node.previousRefName, to: node.currentRefName };
    case 'HeadRefDeletedEvent':
      return { kind: 'head-ref-deleted', ...base!, ref: node.headRefName };
  }
}

const threadComment = comment.extend({
  diffHunk: z.string(),
  state: z.enum(['PENDING', 'SUBMITTED']),
  viewerCanDelete: z.boolean(),
  pullRequestReview: z.object({ id: z.string() }).nullable(),
});
type RawThreadComment = z.infer<typeof threadComment>;

const side = z.enum(['LEFT', 'RIGHT']);
const thread = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  startLine: z.number().nullable(),
  originalLine: z.number().nullable(),
  diffSide: side,
  startDiffSide: side.nullable(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  viewerCanReply: z.boolean(),
  comments: z.object({ totalCount: z.number(), nodes: z.array(threadComment) }),
});
export type RawThread = z.infer<typeof thread>;

function toThreadComment(raw: RawThreadComment): WorkItemThreadComment {
  return {
    ...toPost(raw),
    pending: raw.state === 'PENDING',
    viewerCanDelete: raw.viewerCanDelete,
    ...(raw.pullRequestReview ? { reviewId: raw.pullRequestReview.id } : {}),
  };
}

function toThread(raw: RawThread, comments: RawThreadComment[] = raw.comments.nodes): WorkItemThread {
  return {
    id: raw.id,
    path: raw.path,
    ...(raw.line !== null ? { line: raw.line } : {}),
    ...(raw.startLine !== null ? { startLine: raw.startLine } : {}),
    side: raw.diffSide,
    ...(raw.startDiffSide ? { startSide: raw.startDiffSide } : {}),
    ...(raw.originalLine !== null ? { originalLine: raw.originalLine } : {}),
    diffHunk: comments[0]?.diffHunk ?? '',
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    viewerCanResolve: raw.viewerCanResolve,
    viewerCanUnresolve: raw.viewerCanUnresolve,
    viewerCanReply: raw.viewerCanReply,
    comments: comments.map(toThreadComment),
  };
}

const checkContext = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
  }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string(), state: z.string(), targetUrl: z.string().nullable() }),
]);
type RawCheck = z.infer<typeof checkContext>;

/** A run still going has no conclusion yet: its status (IN_PROGRESS, QUEUED) is the state. */
const toCheck = (raw: RawCheck) =>
  raw.__typename === 'CheckRun'
    ? { name: raw.name, state: raw.conclusion || raw.status || 'PENDING', url: raw.detailsUrl ?? '' }
    : { name: raw.context, state: raw.state || 'PENDING', url: raw.targetUrl ?? '' };

const page = <T extends z.ZodTypeAny>(nodes: T) =>
  z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }), nodes: z.array(nodes) });

const pullRequestHeader = post.extend({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  labels: z.object({ nodes: z.array(label) }),
  assignees: z.object({ nodes: z.array(actor) }),
  reviewRequests: z.object({
    nodes: z.array(z.object({
      requestedReviewer: z.object({ __typename: z.string(), login: z.string().optional(), avatarUrl: z.string().nullish(), name: z.string().optional() }).nullable(),
    })),
  }),
  latestReviews: z.object({ nodes: z.array(z.object({ state: reviewState, author: nullableActor })) }),
  headRefOid: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  viewerCanUpdateBranch: z.boolean(),
  reviews: z.object({
    nodes: z.array(z.object({ id: z.string(), viewerDidAuthor: z.boolean(), comments: z.object({ totalCount: z.number() }) })),
  }),
  commits: z.object({
    nodes: z.array(z.object({
      commit: z.object({
        statusCheckRollup: z.object({ contexts: z.object({ totalCount: z.number(), nodes: z.array(checkContext) }) }).nullable(),
      }),
    })),
  }),
});

const issueHeader = post.extend({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().nullable(),
  labels: z.object({ nodes: z.array(label) }),
  assignees: z.object({ nodes: z.array(actor) }),
});

const headerReply = <T extends z.ZodTypeAny>(name: 'pullRequest' | 'issue', item: T) =>
  z.object({ data: z.object({ viewer: actor, repository: z.object({ [name]: item.nullable() }).nullable() }) });

const pullRequestReply = headerReply('pullRequest', pullRequestHeader);
const issueReply = headerReply('issue', issueHeader);

/** `--paginate --slurp`: every page's whole reply, in order. */
const pages = <T extends z.ZodTypeAny>(reply: T) => z.array(reply).min(1);

const timelineReply = (name: 'pullRequest' | 'issue') =>
  pages(z.object({ data: z.object({ repository: z.object({ [name]: z.object({ timelineItems: page(timelineNode) }).nullable() }).nullable() }) }));

const threadsReply = pages(z.object({
  data: z.object({ repository: z.object({ pullRequest: z.object({ reviewThreads: page(thread) }).nullable() }).nullable() }),
}));

const threadCommentsReply = pages(z.object({
  data: z.object({ node: z.object({ comments: page(threadComment) }).nullable() }),
}));

const checksReply = pages(z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ contexts: page(checkContext) }).nullable() }) })) }),
      }).nullable(),
    }).nullable(),
  }),
}));

export const githubFileSchema = z.object({
  filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number(), patch: z.string().optional(),
});

function strict<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Unrecognised ${what} from GitHub${issue ? ` at ${issue.path.join('.') || 'the top'}: ${issue.message}` : ''}.`);
  }
  return parsed.data;
}

function missing(type: 'pr' | 'issue'): never {
  throw new Error(`GitHub did not return this ${type === 'pr' ? 'pull request' : 'issue'}.`);
}

// ---------------------------------------------------------------------------
// Readers.

export type PullRequestHeader = z.infer<typeof pullRequestHeader> & { viewer: Actor };
export type IssueHeader = z.infer<typeof issueHeader> & { viewer: Actor };

export function parsePullRequestHeader(raw: unknown): PullRequestHeader {
  const reply = strict(pullRequestReply, raw, 'pull request');
  const item = reply.data.repository?.pullRequest as z.infer<typeof pullRequestHeader> | null | undefined;
  if (!item) missing('pr');
  return { ...item, viewer: reply.data.viewer };
}

export function parseIssueHeader(raw: unknown): IssueHeader {
  const reply = strict(issueReply, raw, 'issue');
  const item = reply.data.repository?.issue as z.infer<typeof issueHeader> | null | undefined;
  if (!item) missing('issue');
  return { ...item, viewer: reply.data.viewer };
}

export function parseTimeline(raw: unknown, type: 'pr' | 'issue'): WorkItemTimelineItem[] {
  const replies = strict(timelineReply(field(type)), raw, 'timeline');
  return replies.flatMap((reply) => {
    const item = (reply.data.repository as Record<string, { timelineItems: { nodes: TimelineNode[] } } | null> | null)?.[field(type)];
    if (!item) missing(type);
    return item.timelineItems.nodes.map(toTimelineItem).filter((entry): entry is WorkItemTimelineItem => entry !== null);
  });
}

export function parseThreads(raw: unknown): RawThread[] {
  return strict(threadsReply, raw, 'review threads').flatMap((reply) => {
    const pullRequest = reply.data.repository?.pullRequest;
    if (!pullRequest) missing('pr');
    return pullRequest.reviewThreads.nodes;
  });
}

/** Threads whose first page of comments was not all of them. */
export const incompleteThreads = (threads: RawThread[]) =>
  threads.filter((entry) => entry.comments.totalCount > entry.comments.nodes.length);

export function parseThreadComments(raw: unknown): RawThreadComment[] {
  return strict(threadCommentsReply, raw, 'thread comments').flatMap((reply) => {
    if (!reply.data.node) throw new Error('GitHub did not return a review thread.');
    return reply.data.node.comments.nodes;
  });
}

/** Whether the header's checks were cut at its first hundred. */
export function checksIncomplete(header: PullRequestHeader): boolean {
  const contexts = header.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  return !!contexts && contexts.totalCount > contexts.nodes.length;
}

export function parseChecks(raw: unknown): WorkItemDetails['checks'] {
  return strict(checksReply, raw, 'checks').flatMap((reply) => {
    const pullRequest = reply.data.repository?.pullRequest;
    if (!pullRequest) missing('pr');
    return (pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toCheck);
  });
}

export function parseFiles(rows: unknown[]): WorkItemDetails['files'] {
  return strict(z.array(githubFileSchema), rows, 'file list').map((file) => ({
    path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: file.patch,
  }));
}

const REVIEWER_STATES = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
} as const;

/**
 * Who reviews, and where each stands: their latest review, overridden by a
 * request still open (asking again is how a re-review is asked for). The
 * author's own replies are reviews to GitHub, never a reviewer here.
 */
function reviewersOf(header: PullRequestHeader): WorkItemReviewer[] {
  const authorLogin = header.author?.login;
  const reviewers = new Map<string, WorkItemReviewer>();
  for (const review of header.latestReviews.nodes) {
    if (review.state === 'PENDING' || !review.author || review.author.login === authorLogin) continue;
    reviewers.set(`user:${review.author.login}`, { who: person(review.author), isTeam: false, state: REVIEWER_STATES[review.state] });
  }
  for (const { requestedReviewer: requested } of header.reviewRequests.nodes) {
    if (!requested) continue;
    const isTeam = requested.__typename === 'Team';
    const login = isTeam ? requested.name : requested.login;
    if (!login) continue;
    reviewers.set(`${isTeam ? 'team' : 'user'}:${login}`, {
      who: { login, ...(!isTeam && requested.avatarUrl ? { avatarUrl: requested.avatarUrl } : {}), isBot: requested.__typename === 'Bot' },
      isTeam,
      state: 'requested',
    });
  }
  return [...reviewers.values()];
}

export function pullRequestDetails(
  header: PullRequestHeader,
  timeline: WorkItemTimelineItem[],
  threads: WorkItemThread[],
  files: WorkItemDetails['files'],
  checks: WorkItemDetails['checks'] = (header.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
): WorkItemDetails {
  const pending = header.reviews.nodes.find((review) => review.viewerDidAuthor);
  const description = toPost(header);
  return {
    title: header.title,
    body: description.body,
    state: header.state.toLowerCase(),
    isDraft: header.isDraft,
    author: description.author.login,
    url: header.url,
    viewer: person(header.viewer),
    description,
    labels: header.labels.nodes.map(toLabel),
    assignees: header.assignees.nodes.map(person),
    reviewers: reviewersOf(header),
    timeline,
    threads,
    ...(pending ? { pendingReview: { id: pending.id, commentCount: pending.comments.totalCount } } : {}),
    checks,
    files,
    additions: header.additions,
    deletions: header.deletions,
    headOid: header.headRefOid,
    headBranch: header.headRefName,
    baseBranch: header.baseRefName,
    mergeState: header.mergeStateStatus,
    ...(header.reviewDecision ? { reviewDecision: header.reviewDecision } : {}),
    canUpdateBranch: header.viewerCanUpdateBranch,
  };
}

export function issueDetails(header: IssueHeader, timeline: WorkItemTimelineItem[]): WorkItemDetails {
  const description = toPost(header);
  const reason = stateReason(header.stateReason);
  return {
    title: header.title,
    body: description.body,
    state: header.state.toLowerCase(),
    ...(reason && header.state === 'CLOSED' ? { stateReason: reason } : {}),
    isDraft: false,
    author: description.author.login,
    url: header.url,
    viewer: person(header.viewer),
    description,
    labels: header.labels.nodes.map(toLabel),
    assignees: header.assignees.nodes.map(person),
    reviewers: [],
    timeline,
    threads: [],
    checks: [],
    files: [],
  };
}

export { toThread };

const owner = z.object({
  __typename: z.string(),
  pullRequest: z.object({ number: z.number(), repository: z.object({ nameWithOwner: z.string() }) }).optional(),
  issue: z.object({ number: z.number() }).optional(),
  repository: z.object({ nameWithOwner: z.string() }).optional(),
}).nullable();

/**
 * Throws unless every id names a thing of the expected kind on `repo#number`.
 * A write addressed by id would otherwise skip the check that keeps a
 * workspace's actions inside its own organization and item.
 */
export function assertOwners(raw: unknown, expected: Array<{ type: OwnedNodeType }>, repo: string, number: number): void {
  const reply = strict(z.object({ data: z.record(owner) }), raw, 'reply');
  expected.forEach(({ type }, index) => {
    const node = reply.data[`n${index}`];
    const where = node?.pullRequest
      ? { repo: node.pullRequest.repository.nameWithOwner, number: node.pullRequest.number }
      : node?.issue && node.repository
        ? { repo: node.repository.nameWithOwner, number: node.issue.number }
        : null;
    if (!node || node.__typename !== type || !where || where.repo.toLowerCase() !== repo.toLowerCase() || where.number !== number) {
      throw new Error('That comment or thread does not belong to this item.');
    }
  });
}

export function parsePullRequestId(raw: unknown): string {
  const reply = strict(z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ id: z.string() }).nullable() }).nullable() }) }), raw, 'reply');
  const id = reply.data.repository?.pullRequest?.id;
  if (!id) missing('pr');
  return id;
}

export function parseStartedReviewId(raw: unknown): string {
  return strict(
    z.object({ data: z.object({ addPullRequestReview: z.object({ pullRequestReview: z.object({ id: z.string() }) }) }) }),
    raw,
    'reply'
  ).data.addPullRequestReview.pullRequestReview.id;
}
