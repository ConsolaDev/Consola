import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { INBOX_QUERY, parseInboxPayload, searchStrings } from './parseInbox';

const canned = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../tests/fixtures/stub-gh/graphql-inbox.json'),
    'utf8'
  )
);

describe('searchStrings', () => {
  it('scopes every search to the org when one is set', () => {
    const searches = searchStrings('SymJavi', 'sympower');
    expect(searches.assigned).toBe('assignee:SymJavi is:open archived:false org:sympower');
    expect(searches.authored).toBe('author:SymJavi is:open archived:false org:sympower');
    expect(searches.reviewRequested).toBe(
      'review-requested:SymJavi is:open is:pr archived:false org:sympower'
    );
  });

  it('omits the org qualifier when the workspace has none — all repos for the account', () => {
    expect(searchStrings('SymJavi').assigned).toBe('assignee:SymJavi is:open archived:false');
  });
});

describe('INBOX_QUERY', () => {
  it('declares the three aliased searches the parser reads', () => {
    for (const alias of ['assigned:', 'authored:', 'reviewRequested:']) {
      expect(INBOX_QUERY).toContain(alias);
    }
  });
});

describe('parseInboxPayload', () => {
  const items = parseInboxPayload(canned);

  it('parses the canned payload into deduplicated items', () => {
    // 5 nodes in the fixture, but PR #42 appears under two roles.
    expect(items).toHaveLength(4);
  });

  it('dedupes with role precedence review-requested > assigned > author', () => {
    const pr42 = items.find((item) => item.workItem.number === 42);
    expect(pr42?.role).toBe('review-requested');
  });

  it('maps PullRequest nodes to pr work items with CI and review fields', () => {
    const pr51 = items.find((item) => item.workItem.number === 51);
    expect(pr51?.workItem).toEqual({
      provider: 'github',
      repo: 'sympower/controller-app',
      type: 'pr',
      number: 51,
    });
    expect(pr51?.ciStatus).toBe('failing');
    expect(pr51?.reviewDecision).toBe('REVIEW_REQUIRED');
    expect(pr51?.additions).toBe(210);
    expect(pr51?.deletions).toBe(88);
    expect(pr51?.state).toBe('open');
  });

  it('maps Issue nodes to issue work items without CI fields', () => {
    const issue87 = items.find((item) => item.workItem.number === 87);
    expect(issue87?.workItem.type).toBe('issue');
    expect(issue87?.role).toBe('assigned');
    expect(issue87?.ciStatus).toBeUndefined();
  });

  it('sorts newest-updated first', () => {
    const stamps = items.map((item) => item.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it('maps SUCCESS to passing and PENDING to pending', () => {
    const payload = {
      data: {
        assigned: { nodes: [] },
        authored: { nodes: [] },
        reviewRequested: {
          nodes: [
            {
              __typename: 'PullRequest',
              title: 'A',
              number: 1,
              state: 'OPEN',
              url: 'https://github.com/o/r/pull/1',
              updatedAt: '2026-08-20T00:00:00Z',
              repository: { nameWithOwner: 'o/r' },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
            },
          ],
        },
      },
    };
    expect(parseInboxPayload(payload)[0].ciStatus).toBe('pending');
  });

  it('skips malformed nodes rather than throwing', () => {
    const payload = { data: { assigned: { nodes: [{ __typename: 'Issue', title: 'no repo' }] } } };
    expect(parseInboxPayload(payload)).toEqual([]);
  });

  it('returns [] for a payload with no data at all', () => {
    expect(parseInboxPayload({})).toEqual([]);
    expect(parseInboxPayload(null)).toEqual([]);
  });

  // Top-level validation: Rule 1 — reject non-objects
  it('throws when payload is a string', () => {
    expect(() => parseInboxPayload('not an object')).toThrow();
  });

  it('throws when payload is a number', () => {
    expect(() => parseInboxPayload(42)).toThrow();
  });

  it('throws when payload is a boolean', () => {
    expect(() => parseInboxPayload(true)).toThrow();
  });

  it('throws when payload is an array', () => {
    expect(() => parseInboxPayload([])).toThrow();
  });

  // Top-level validation: Rule 2 — reject data: null
  it('throws when payload.data is null', () => {
    expect(() => parseInboxPayload({ data: null })).toThrow('GitHub API returned no data');
  });

  // Top-level validation: Rule 3 — reject errors without data
  it('throws when payload.errors exists with no data, carrying the error message', () => {
    const payload = {
      errors: [{ message: 'API rate limit exceeded' }],
    };
    expect(() => parseInboxPayload(payload)).toThrow('API rate limit exceeded');
  });

  it('does not throw when errors exist but data is present and valid', () => {
    const payload = {
      data: {
        assigned: { nodes: [] },
        authored: { nodes: [] },
        reviewRequested: { nodes: [] },
      },
      errors: [{ message: 'Some warning' }],
    };
    expect(parseInboxPayload(payload)).toEqual([]);
  });
});
