// src/main/providers/github/inboxQuery.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import { INBOX_QUERY, INBOX_SEARCH_ALIASES, parseInboxPayload, searchStrings } from './inboxQuery';

const canned = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/graphql-inbox.json'),
    'utf8'
  )
);

/** One PullRequest node carrying every field the fragment asks for. */
function prNode(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    title: `PR ${number}`,
    number,
    state: 'OPEN',
    url: `https://github.com/o/r/pull/${number}`,
    updatedAt: '2026-08-20T00:00:00Z',
    repository: { nameWithOwner: 'o/r' },
    author: { login: 'someone' },
    comments: { totalCount: 0 },
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    additions: 1,
    deletions: 1,
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  };
}

/** A `commits` field whose rollup carries the given state and contexts. */
function rollup(state: string, contexts?: { totalCount: number; nodes: unknown[] }) {
  return {
    commits: {
      nodes: [{ commit: { statusCheckRollup: { state, ...(contexts ? { contexts } : {}) } } }],
    },
  };
}

const checkRun = (status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  status,
  conclusion,
});
const statusContext = (state: string) => ({ __typename: 'StatusContext', state });

/** A payload with nodes under the named aliases and every other alias empty. */
function payloadWith(nodesByAlias: Partial<Record<string, unknown[]>>): unknown {
  const data: Record<string, { nodes: unknown[] }> = {};
  for (const alias of INBOX_SEARCH_ALIASES) data[alias] = { nodes: nodesByAlias[alias] ?? [] };
  return { data };
}

const only = (payload: unknown): InboxItem => {
  const items = parseInboxPayload(payload);
  expect(items).toHaveLength(1);
  return items[0];
};

describe('searchStrings', () => {
  it('builds the five qualifiers, org-scoped', () => {
    expect(searchStrings('SymJavi', 'sympower')).toEqual({
      direct: 'user-review-requested:SymJavi is:pr is:open archived:false org:sympower',
      team: 'review-requested:SymJavi is:pr is:open archived:false org:sympower',
      authored: 'author:SymJavi is:open archived:false org:sympower',
      assigned: 'assignee:SymJavi is:open archived:false org:sympower',
      involved: 'involves:SymJavi is:open archived:false org:sympower',
    });
  });

  it('omits the org qualifier when the workspace has none -- all repos for the account', () => {
    expect(searchStrings('SymJavi').involved).toBe('involves:SymJavi is:open archived:false');
  });
});

describe('INBOX_QUERY', () => {
  it('declares one variable and one aliased search per alias, first: 50 each', () => {
    for (const alias of INBOX_SEARCH_ALIASES) {
      expect(INBOX_QUERY).toContain(`$${alias}: String!`);
      expect(INBOX_QUERY).toContain(`${alias}: search(query: $${alias}, type: ISSUE, first: 50)`);
    }
  });

  it('asks for the fields check counts, authorship and comment counts derive from', () => {
    expect(INBOX_QUERY).toContain('contexts(first: 100)');
    expect(INBOX_QUERY).toContain('... on CheckRun { status conclusion }');
    expect(INBOX_QUERY).toContain('... on StatusContext { state }');
    expect(INBOX_QUERY).toContain('comments { totalCount }');
    expect(INBOX_QUERY).toContain('author { login }');
    expect(INBOX_QUERY).toContain('isDraft');
  });
});

describe('parseInboxPayload over the canned fixture', () => {
  const items = parseInboxPayload(canned);
  const byNumber = (number: number) => items.find((item) => item.workItem.number === number);

  it('yields nine distinct items from twelve nodes', () => {
    expect(items).toHaveLength(9);
  });

  it('keeps a directly requested review out of the team role', () => {
    expect(byNumber(51)?.roles).toEqual(['review-requested-direct']);
  });

  it('marks a team-only request as such', () => {
    expect(byNumber(60)?.roles).toEqual(['review-requested-team']);
  });

  it('merges every role an item was returned under', () => {
    expect(byNumber(70)?.roles).toEqual(['author', 'involved']);
    expect(byNumber(12)?.roles).toEqual(['assignee', 'involved']);
  });

  it('keeps items only the involves search returned', () => {
    expect(byNumber(200)?.roles).toEqual(['involved']);
    expect(byNumber(300)?.roles).toEqual(['involved']);
  });

  it('reads author, draft flag, comment count and diff size', () => {
    expect(byNumber(70)?.author).toBe('SymJavi');
    expect(byNumber(70)?.isDraft).toBe(true);
    expect(byNumber(51)?.isDraft).toBe(false);
    expect(byNumber(12)?.commentCount).toBe(3);
    expect(byNumber(51)?.additions).toBe(210);
    expect(byNumber(51)?.deletions).toBe(88);
  });

  it('normalises the review decision', () => {
    expect(byNumber(90)?.reviewDecision).toBe('approved');
    expect(byNumber(80)?.reviewDecision).toBe('changes-requested');
    expect(byNumber(51)?.reviewDecision).toBe('review-required');
    expect(byNumber(70)?.reviewDecision).toBe('none');
    expect(byNumber(12)?.reviewDecision).toBe('none');
  });

  it('derives check counts and the CI verdict from the rollup', () => {
    expect(byNumber(51)?.checks).toEqual({ passed: 2, failed: 1, pending: 0, total: 3 });
    expect(byNumber(51)?.ciStatus).toBe('failing');
    expect(byNumber(90)?.checks).toEqual({ passed: 4, failed: 0, pending: 0, total: 4 });
    expect(byNumber(90)?.ciStatus).toBe('passing');
    expect(byNumber(100)?.checks).toEqual({ passed: 0, failed: 0, pending: 2, total: 2 });
    expect(byNumber(100)?.ciStatus).toBe('pending');
  });

  it('leaves checks and ciStatus undefined when there is no rollup', () => {
    expect(byNumber(70)?.checks).toBeUndefined();
    expect(byNumber(70)?.ciStatus).toBeUndefined();
    expect(byNumber(12)?.checks).toBeUndefined();
    expect(byNumber(12)?.ciStatus).toBeUndefined();
  });

  it('maps Issue nodes to issue work items and PullRequest nodes to pr', () => {
    expect(byNumber(12)?.workItem).toEqual({
      provider: 'github',
      repo: 'sympower/msa-resource-bff',
      type: 'issue',
      number: 12,
    });
    expect(byNumber(51)?.workItem.type).toBe('pr');
    expect(byNumber(51)?.state).toBe('open');
  });

  it('sorts newest-updated first', () => {
    const stamps = items.map((item) => item.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });
});

describe('parseInboxPayload derivation rules', () => {
  it('classifies completed CheckRuns by conclusion', () => {
    const node = prNode(
      1,
      rollup('FAILURE', {
        totalCount: 8,
        nodes: [
          checkRun('COMPLETED', 'SUCCESS'),
          checkRun('COMPLETED', 'NEUTRAL'),
          checkRun('COMPLETED', 'SKIPPED'),
          checkRun('COMPLETED', 'FAILURE'),
          checkRun('COMPLETED', 'CANCELLED'),
          checkRun('COMPLETED', 'TIMED_OUT'),
          checkRun('COMPLETED', 'ACTION_REQUIRED'),
          checkRun('COMPLETED', 'STARTUP_FAILURE'),
        ],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 3,
      failed: 5,
      pending: 0,
      total: 8,
    });
  });

  it('treats an unfinished or stale CheckRun as pending', () => {
    const node = prNode(
      1,
      rollup('PENDING', {
        totalCount: 3,
        nodes: [
          checkRun('IN_PROGRESS', null),
          checkRun('QUEUED', null),
          checkRun('COMPLETED', 'STALE'),
        ],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 0,
      failed: 0,
      pending: 3,
      total: 3,
    });
  });

  it('classifies StatusContexts by state', () => {
    const node = prNode(
      1,
      rollup('FAILURE', {
        totalCount: 5,
        nodes: [
          statusContext('SUCCESS'),
          statusContext('ERROR'),
          statusContext('FAILURE'),
          statusContext('PENDING'),
          statusContext('EXPECTED'),
        ],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 1,
      failed: 2,
      pending: 2,
      total: 5,
    });
  });

  it('counts an unrecognised context type in the total only', () => {
    const node = prNode(
      1,
      rollup('SUCCESS', {
        totalCount: 2,
        nodes: [{ __typename: 'Mystery' }, checkRun('COMPLETED', 'SUCCESS')],
      })
    );
    expect(only(payloadWith({ authored: [node] })).checks).toEqual({
      passed: 1,
      failed: 0,
      pending: 0,
      total: 2,
    });
  });

  it('maps the rollup state to ciStatus', () => {
    const verdict = (state: string) =>
      only(payloadWith({ authored: [prNode(1, rollup(state))] })).ciStatus;
    expect(verdict('SUCCESS')).toBe('passing');
    expect(verdict('FAILURE')).toBe('failing');
    expect(verdict('ERROR')).toBe('failing');
    expect(verdict('PENDING')).toBe('pending');
    expect(verdict('EXPECTED')).toBe('pending');
    expect(verdict('SOMETHING_NEW')).toBeUndefined();
  });

  it('reports no checks when the rollup carries no contexts -- never a zeroed object', () => {
    const item = only(payloadWith({ authored: [prNode(1, rollup('SUCCESS'))] }));
    expect(item.ciStatus).toBe('passing');
    expect(item.checks).toBeUndefined();
  });

  it('reads a null or unfamiliar reviewDecision as none', () => {
    expect(only(payloadWith({ authored: [prNode(1, { reviewDecision: null })] })).reviewDecision).toBe(
      'none'
    );
    expect(
      only(payloadWith({ authored: [prNode(1, { reviewDecision: 'SOMETHING_NEW' })] })).reviewDecision
    ).toBe('none');
  });

  it('defaults a missing author and comment count', () => {
    const item = only(payloadWith({ authored: [prNode(1, { author: null, comments: undefined })] }));
    expect(item.author).toBe('');
    expect(item.commentCount).toBe(0);
  });

  it('gives each role to an item several searches returned', () => {
    const item = only(payloadWith({ authored: [prNode(1)], assigned: [prNode(1)] }));
    expect(item.roles).toEqual(['author', 'assignee']);
  });

  it('suppresses the team role when the item was requested directly, whatever the payload order', () => {
    const payload = { data: { team: { nodes: [prNode(1)] }, direct: { nodes: [prNode(1)] } } };
    expect(only(payload).roles).toEqual(['review-requested-direct']);
  });

  it('never records a role twice', () => {
    expect(only(payloadWith({ authored: [prNode(1), prNode(1)] })).roles).toEqual(['author']);
  });

  it('skips malformed nodes rather than throwing', () => {
    const payload = { data: { assigned: { nodes: [{ __typename: 'Issue', title: 'no repo' }] } } };
    expect(parseInboxPayload(payload)).toEqual([]);
  });

  it('parses data present with a missing alias key as empty for that alias', () => {
    expect(parseInboxPayload({ data: { assigned: { nodes: [] } } })).toEqual([]);
  });

  // Controller ruling: a non-object payload, null, and a payload with no
  // `data` object all keep throwing -- an empty inbox and a broken fetch
  // must never look the same to the caller.
  it('throws when the payload is not an object', () => {
    expect(() => parseInboxPayload('not an object')).toThrow('Inbox payload must be a JSON object');
    expect(() => parseInboxPayload(42)).toThrow();
    expect(() => parseInboxPayload(true)).toThrow();
    expect(() => parseInboxPayload([])).toThrow();
  });

  it('throws when the payload is null', () => {
    expect(() => parseInboxPayload(null)).toThrow('Inbox payload must be a JSON object');
  });

  it('throws when the payload has no data object', () => {
    expect(() => parseInboxPayload({})).toThrow('GitHub API response has no data');
  });

  it('throws when payload.data is null', () => {
    expect(() => parseInboxPayload({ data: null })).toThrow('GitHub API returned no data');
  });

  it('throws when errors exist without data, carrying the message', () => {
    expect(() => parseInboxPayload({ errors: [{ message: 'API rate limit exceeded' }] })).toThrow(
      'API rate limit exceeded'
    );
  });

  it('tolerates errors alongside usable data', () => {
    expect(parseInboxPayload({ ...(payloadWith({}) as object), errors: [{ message: 'warning' }] })).toEqual(
      []
    );
  });

  // A GraphQL partial failure: `data` is present but every alias resolved to
  // null and `errors` explains why. That must not read as "nothing to do".
  it('throws when errors accompany data whose aliases are all null, carrying the message', () => {
    const payload = {
      data: { direct: null, team: null, authored: null, assigned: null, involved: null },
      errors: [{ message: 'field error on direct' }],
    };
    expect(() => parseInboxPayload(payload)).toThrow('field error on direct');
  });

  it('parses when errors accompany at least one alias with usable data', () => {
    const payload = {
      data: {
        direct: { nodes: [prNode(1)] },
        team: null,
        authored: null,
        assigned: null,
        involved: null,
      },
      errors: [{ message: 'partial failure' }],
    };
    expect(parseInboxPayload(payload)).toHaveLength(1);
  });

  it.each([
    { label: 'a string', value: 'x' },
    { label: 'a number', value: 42 },
    { label: 'an array', value: [] },
    { label: 'a boolean', value: true },
  ])('throws when data is $label instead of an object', ({ value }) => {
    expect(() => parseInboxPayload({ data: value })).toThrow('GitHub API returned malformed data');
  });
});
