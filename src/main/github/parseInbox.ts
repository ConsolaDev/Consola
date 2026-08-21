import type { InboxItem } from '../../shared/github';
import { workItemKey } from '../../shared/github';

/**
 * The one GraphQL request behind a workspace's Inbox.
 *
 * Three aliased searches — assigned, authored, review-requested — in a single
 * request: GitHub's search syntax cannot OR those qualifiers in one string,
 * but one request keeps the spec's "one GraphQL search per workspace" budget.
 * `type: ISSUE` searches return both issues and PRs; `__typename` tells them
 * apart.
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
    repository { nameWithOwner }
  }
  ... on PullRequest {
    title number state url updatedAt
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

function toItem(node: SearchNode, role: InboxItem['role']): InboxItem | null {
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
    state: (node.state ?? 'OPEN').toLowerCase(),
    role,
    ciStatus: rollup ? CI_STATES[rollup] : undefined,
    reviewDecision: node.reviewDecision ?? undefined,
    updatedAt: node.updatedAt ?? '',
    url: node.url,
    additions: node.additions,
    deletions: node.deletions,
  };
}

/**
 * Flatten a gh graphql payload into deduplicated, newest-first inbox items.
 *
 * An item can match several searches; the first role below wins because the
 * reason you were asked (a requested review) outranks the reason you are
 * merely attached (assignee, author). Malformed nodes are skipped, never
 * thrown on — a half-broken payload still yields the readable remainder.
 */
export function parseInboxPayload(payload: unknown): InboxItem[] {
  const data =
    (payload as { data?: Record<string, { nodes?: SearchNode[] } | undefined> } | null)?.data ?? {};
  const roles: Array<[InboxItem['role'], string]> = [
    ['review-requested', 'reviewRequested'],
    ['assigned', 'assigned'],
    ['author', 'authored'],
  ];
  const byKey = new Map<string, InboxItem>();
  for (const [role, alias] of roles) {
    for (const node of data[alias]?.nodes ?? []) {
      const item = toItem(node, role);
      if (!item) continue;
      const key = workItemKey(item.workItem);
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
