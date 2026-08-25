import type { InboxItem, InboxRole } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';

/**
 * The one GraphQL request behind a workspace's Inbox.
 *
 * Three aliased searches — assigned, authored, review-requested — in a single
 * request: GitHub's search syntax cannot OR those qualifiers in one string,
 * but one request keeps the spec's "one GraphQL request per workspace"
 * budget. `type: ISSUE` searches return both issues and PRs; `__typename`
 * tells them apart. Phase D grows this to the five-alias query.
 */
export const INBOX_QUERY = `
query($assigned: String!, $authored: String!, $reviewRequested: String!) {
  assigned: search(query: $assigned, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  authored: search(query: $authored, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  reviewRequested: search(query: $reviewRequested, type: ISSUE, first: 50) { nodes { ...inboxFields } }
}
fragment inboxFields on SearchResultItem {
  __typename
  ... on Issue {
    title number state url updatedAt
    author { login }
    comments { totalCount }
    repository { nameWithOwner }
  }
  ... on PullRequest {
    title number state url updatedAt isDraft
    author { login }
    comments { totalCount }
    repository { nameWithOwner }
    reviewDecision additions deletions
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }
}`;

/** The search strings for one workspace's account, org-scoped when org is set. */
export function searchStrings(
  accountLogin: string,
  org?: string
): { assigned: string; authored: string; reviewRequested: string } {
  const scope = org ? ` org:${org}` : '';
  return {
    assigned: `assignee:${accountLogin} is:open archived:false${scope}`,
    authored: `author:${accountLogin} is:open archived:false${scope}`,
    reviewRequested: `review-requested:${accountLogin} is:open is:pr archived:false${scope}`,
  };
}

interface SearchNode {
  __typename?: string;
  title?: string;
  number?: number;
  state?: string;
  url?: string;
  updatedAt?: string;
  isDraft?: boolean;
  author?: { login?: string } | null;
  comments?: { totalCount?: number } | null;
  repository?: { nameWithOwner?: string };
  reviewDecision?: string | null;
  additions?: number;
  deletions?: number;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> };
}

const CI_STATES: Record<string, InboxItem['ciStatus']> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

/** GitHub's enum, folded to the provider-neutral verdict; anything else is 'none'. */
const REVIEW_DECISIONS: Record<string, InboxItem['reviewDecision']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};

function toItem(node: SearchNode, role: InboxRole): InboxItem | null {
  const repo = node.repository?.nameWithOwner;
  if (!repo || typeof node.number !== 'number' || !node.title || !node.url) return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    workItem: {
      provider: 'github',
      repo,
      type: node.__typename === 'PullRequest' ? 'pr' : 'issue',
      number: node.number,
    },
    title: node.title,
    author: node.author?.login ?? '',
    roles: [role],
    isDraft: node.isDraft === true,
    state: (node.state ?? 'OPEN').toLowerCase(),
    reviewDecision: REVIEW_DECISIONS[node.reviewDecision ?? ''] ?? 'none',
    ciStatus: rollup ? CI_STATES[rollup] : undefined,
    commentCount: node.comments?.totalCount ?? 0,
    additions: node.additions,
    deletions: node.deletions,
    updatedAt: node.updatedAt ?? '',
    url: node.url,
  };
}

/**
 * Flatten a gh graphql payload into deduplicated, newest-first inbox items.
 *
 * An item can match several searches; it comes out once, carrying every
 * role, in the order below — the reason you were asked (a requested review)
 * ahead of the reason you are merely attached (assignee, author). The
 * sections decide what the roles mean. Malformed nodes are skipped, never
 * thrown on — a half-broken payload still yields the readable remainder.
 *
 * Throws when the top-level payload is malformed (not an object, null, missing
 * or null `data`, or `errors` alongside no usable `data`), so InboxService can
 * turn the throw into a labelled stale snapshot rather than silently treating
 * an unrecognised reply as an empty inbox.
 */
export function parseInboxPayload(payload: unknown): InboxItem[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Inbox payload must be a JSON object');
  }

  const payloadObj = payload as Record<string, unknown>;
  const hasData = 'data' in payloadObj && payloadObj.data !== null;

  // errors alongside no usable data: surface gh's own reason, e.g. a rate limit.
  if (Array.isArray(payloadObj.errors) && payloadObj.errors.length > 0 && !hasData) {
    const firstError =
      (payloadObj.errors[0] as { message?: string })?.message || 'Unknown GitHub API error';
    throw new Error(firstError);
  }

  if (!('data' in payloadObj)) {
    throw new Error('GitHub API response has no data');
  }
  if (payloadObj.data === null) {
    throw new Error('GitHub API returned no data');
  }

  const data = payloadObj.data as Record<string, { nodes?: SearchNode[] } | undefined>;
  // B maps every review request to the direct role; D splits direct from team.
  const aliases: Array<[InboxRole, string]> = [
    ['review-requested-direct', 'reviewRequested'],
    ['assignee', 'assigned'],
    ['author', 'authored'],
  ];
  const byKey = new Map<string, InboxItem>();
  for (const [role, alias] of aliases) {
    for (const node of data[alias]?.nodes ?? []) {
      const item = toItem(node, role);
      if (!item) continue;
      const key = workItemKey(item.workItem);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, item);
      } else if (!existing.roles.includes(role)) {
        existing.roles.push(role);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
