import type { InboxItem, InboxRole } from '../../../shared/workItems';
import { workItemKey } from '../../../shared/workItems';

/**
 * The one GraphQL request behind a workspace's Inbox.
 *
 * Five aliased searches in a single request: GitHub's search syntax cannot
 * OR those qualifiers into one string, and one request keeps the spec's
 * "one request per workspace" budget. `type: ISSUE` searches return both
 * issues and PRs; `__typename` tells them apart. The rollup's contexts ride
 * along so check counts can be derived without a second call per PR.
 */
export const INBOX_QUERY = `
query($direct: String!, $team: String!, $authored: String!, $assigned: String!, $involved: String!) {
  direct: search(query: $direct, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  team: search(query: $team, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  authored: search(query: $authored, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  assigned: search(query: $assigned, type: ISSUE, first: 50) { nodes { ...inboxFields } }
  involved: search(query: $involved, type: ISSUE, first: 50) { nodes { ...inboxFields } }
}
fragment inboxFields on SearchResultItem {
  __typename
  ... on Issue {
    title number state url updatedAt
    repository { nameWithOwner }
    author { login }
    comments { totalCount }
  }
  ... on PullRequest {
    title number state url updatedAt
    repository { nameWithOwner }
    author { login }
    comments { totalCount }
    isDraft reviewDecision additions deletions
    commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            state
            contexts(first: 100) {
              totalCount
              nodes {
                __typename
                ... on CheckRun { status conclusion }
                ... on StatusContext { state }
              }
            }
          }
        }
      }
    }
  }
}`;

export type InboxSearchAlias = 'direct' | 'team' | 'authored' | 'assigned' | 'involved';
export type InboxSearchStrings = Record<InboxSearchAlias, string>;

/**
 * Merge order, fixed. `direct` before `team` is what lets a team request be
 * dropped when the same PR was requested of you directly -- whatever order
 * the aliases come back in, and whatever order the driver sent them.
 */
export const INBOX_SEARCH_ALIASES: ReadonlyArray<InboxSearchAlias> = [
  'direct',
  'team',
  'authored',
  'assigned',
  'involved',
];

const ALIAS_ROLE: Record<InboxSearchAlias, InboxRole> = {
  direct: 'review-requested-direct',
  team: 'review-requested-team',
  authored: 'author',
  assigned: 'assignee',
  involved: 'involved',
};

/** The search strings for one workspace's account, org-scoped when org is set. */
export function searchStrings(accountLogin: string, org?: string): InboxSearchStrings {
  const scope = org ? ` org:${org}` : '';
  const common = `is:open archived:false${scope}`;
  return {
    direct: `user-review-requested:${accountLogin} is:pr ${common}`,
    team: `review-requested:${accountLogin} is:pr ${common}`,
    authored: `author:${accountLogin} ${common}`,
    assigned: `assignee:${accountLogin} ${common}`,
    involved: `involves:${accountLogin} ${common}`,
  };
}

interface ContextNode {
  __typename?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

interface Rollup {
  state?: string | null;
  contexts?: { totalCount?: number; nodes?: ContextNode[] } | null;
}

interface SearchNode {
  __typename?: string;
  title?: string;
  number?: number;
  state?: string;
  url?: string;
  updatedAt?: string;
  repository?: { nameWithOwner?: string };
  author?: { login?: string } | null;
  comments?: { totalCount?: number } | null;
  isDraft?: boolean;
  reviewDecision?: string | null;
  additions?: number;
  deletions?: number;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: Rollup | null } }> };
}

const CI_STATES: Record<string, NonNullable<InboxItem['ciStatus']>> = {
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

const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

type CheckVerdict = 'passed' | 'failed' | 'pending';

/**
 * One context's verdict, or null for a type this parser does not know --
 * which still counts toward `total` (through totalCount) but decides
 * nothing, so an unfamiliar check can never read as a failure.
 */
function classifyContext(node: ContextNode): CheckVerdict | null {
  if (node.__typename === 'CheckRun') {
    if (node.status !== 'COMPLETED') return 'pending';
    if (node.conclusion && PASSED_CONCLUSIONS.has(node.conclusion)) return 'passed';
    if (node.conclusion && FAILED_CONCLUSIONS.has(node.conclusion)) return 'failed';
    // STALE, null, anything newer: GitHub has not settled it either.
    return 'pending';
  }
  if (node.__typename === 'StatusContext') {
    if (node.state === 'SUCCESS') return 'passed';
    if (node.state === 'ERROR' || node.state === 'FAILURE') return 'failed';
    return 'pending';
  }
  return null;
}

/** Check counts, or undefined when there is nothing to count -- never a zeroed object. */
function checksOf(rollup: Rollup | null | undefined): InboxItem['checks'] {
  const contexts = rollup?.contexts;
  if (!contexts) return undefined;
  const checks = {
    passed: 0,
    failed: 0,
    pending: 0,
    total: contexts.totalCount ?? contexts.nodes?.length ?? 0,
  };
  for (const node of contexts.nodes ?? []) {
    const verdict = classifyContext(node);
    if (verdict) checks[verdict] += 1;
  }
  return checks;
}

type ItemFacts = Omit<InboxItem, 'roles'>;

/** Everything about one node except why it was returned -- roles are merged by the caller. */
function toItem(node: SearchNode): ItemFacts | null {
  const repo = node.repository?.nameWithOwner;
  if (!repo || typeof node.number !== 'number' || !node.title || !node.url) return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const rollupState = rollup?.state;
  return {
    workItem: {
      provider: 'github',
      repo,
      type: node.__typename === 'PullRequest' ? 'pr' : 'issue',
      number: node.number,
    },
    title: node.title,
    author: node.author?.login ?? '',
    isDraft: node.isDraft === true,
    state: (node.state ?? 'OPEN').toLowerCase(),
    reviewDecision: (node.reviewDecision && REVIEW_DECISIONS[node.reviewDecision]) || 'none',
    ciStatus: rollupState ? CI_STATES[rollupState] : undefined,
    checks: checksOf(rollup),
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
 * An item that several searches returned becomes one item carrying every
 * role, with one exception: a team review request is dropped when the same
 * PR was requested of you directly, because GitHub's own inbox files it
 * under "Needs your review" and nowhere else. Malformed nodes are skipped,
 * never thrown on -- a half-broken payload still yields the readable
 * remainder.
 *
 * Throws when the top-level payload is malformed: not an object (including
 * null), missing a `data` object entirely, `data` itself is null or not an
 * object, or `errors` exist alongside no alias with usable (array) data --
 * including the partial-failure shape where `data` is present but every
 * alias resolved to null. A payload with `data` present but a missing alias
 * key still parses -- that alias just contributes no items. Throwing here
 * (rather than degrading to []) is what lets the caller label the failure in
 * the UI instead of an unrecognised reply silently reading as "nothing to
 * do".
 */
export function parseInboxPayload(payload: unknown): InboxItem[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Inbox payload must be a JSON object');
  }

  const payloadObj = payload as Record<string, unknown>;
  const rawData = payloadObj.data;
  const hasData = 'data' in payloadObj && rawData !== null;

  // errors alongside no data at all: surface gh's own reason, e.g. a rate limit.
  if (Array.isArray(payloadObj.errors) && payloadObj.errors.length > 0 && !hasData) {
    const firstError =
      (payloadObj.errors[0] as { message?: string })?.message || 'Unknown GitHub API error';
    throw new Error(firstError);
  }

  if (!('data' in payloadObj)) {
    throw new Error('GitHub API response has no data');
  }
  if (rawData === null) {
    throw new Error('GitHub API returned no data');
  }
  if (typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new Error('GitHub API returned malformed data');
  }

  const data = rawData as Partial<Record<InboxSearchAlias, { nodes?: SearchNode[] }>>;

  // A GraphQL partial failure: `data` is a valid object but every alias
  // resolved to null and `errors` explains why. Throw rather than degrade to
  // [] -- otherwise a rate limit or field error silently reads as "nothing to
  // do". An alias with usable data alongside errors still parses; that
  // partial result is worth showing rather than discarding.
  const hasUsableAlias = INBOX_SEARCH_ALIASES.some(
    (alias) =>
      typeof data[alias] === 'object' && data[alias] !== null && Array.isArray(data[alias]?.nodes)
  );
  if (Array.isArray(payloadObj.errors) && payloadObj.errors.length > 0 && !hasUsableAlias) {
    const firstError =
      (payloadObj.errors[0] as { message?: string })?.message || 'GitHub API returned errors';
    throw new Error(firstError);
  }

  const byKey = new Map<string, InboxItem>();
  for (const alias of INBOX_SEARCH_ALIASES) {
    const role = ALIAS_ROLE[alias];
    for (const node of data[alias]?.nodes ?? []) {
      const facts = toItem(node);
      if (!facts) continue;
      const key = workItemKey(facts.workItem);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...facts, roles: [role] });
        continue;
      }
      if (role === 'review-requested-team' && existing.roles.includes('review-requested-direct')) {
        continue;
      }
      if (!existing.roles.includes(role)) existing.roles.push(role);
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
