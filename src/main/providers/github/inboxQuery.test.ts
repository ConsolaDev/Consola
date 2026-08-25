// src/main/providers/github/inboxQuery.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { INBOX_QUERY, parseInboxPayload, searchStrings } from './inboxQuery';

const canned = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/graphql-inbox.json'),
    'utf8'
  )
);

/** A minimal PullRequest node under one alias; overrides shape the case. */
function payloadWith(alias: string, node: Record<string, unknown>) {
  return {
    data: {
      assigned: { nodes: [] },
      authored: { nodes: [] },
      reviewRequested: { nodes: [] },
      [alias]: {
        nodes: [
          {
            __typename: 'PullRequest',
            title: 'A',
            number: 1,
            state: 'OPEN',
            url: 'https://github.com/o/r/pull/1',
            updatedAt: '2026-08-20T00:00:00Z',
            repository: { nameWithOwner: 'o/r' },
            ...node,
          },
        ],
      },
    },
  };
}

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

  it('asks for the fields the provider-neutral item is built from', () => {
    for (const field of ['isDraft', 'author { login }', 'comments { totalCount }', 'reviewDecision']) {
      expect(INBOX_QUERY).toContain(field);
    }
  });
});

describe('parseInboxPayload', () => {
  const items = parseInboxPayload(canned);

  it('parses the canned payload into deduplicated items', () => {
    // 5 nodes in the fixture, but PR #42 appears under two aliases.
    expect(items).toHaveLength(4);
  });

  it('merges the roles of an item that appears under several aliases, request first', () => {
    const pr42 = items.find((item) => item.workItem.number === 42);
    expect(pr42?.roles).toEqual(['review-requested-direct', 'assignee']);
  });

  it('maps PullRequest nodes to pr items with author, comments, CI and a normalised review verdict', () => {
    const pr51 = items.find((item) => item.workItem.number === 51);
    expect(pr51?.workItem).toEqual({
      provider: 'github',
      repo: 'sympower/controller-app',
      type: 'pr',
      number: 51,
    });
    expect(pr51?.roles).toEqual(['review-requested-direct']);
    expect(pr51?.author).toBe('anna');
    expect(pr51?.isDraft).toBe(false);
    expect(pr51?.commentCount).toBe(3);
    expect(pr51?.ciStatus).toBe('failing');
    expect(pr51?.reviewDecision).toBe('review-required');
    expect(pr51?.additions).toBe(210);
    expect(pr51?.deletions).toBe(88);
    expect(pr51?.state).toBe('open');
    expect(pr51?.checks).toBeUndefined();
  });

  it('maps Issue nodes to issue items with no CI and no review verdict', () => {
    const issue87 = items.find((item) => item.workItem.number === 87);
    expect(issue87?.workItem.type).toBe('issue');
    expect(issue87?.roles).toEqual(['assignee']);
    expect(issue87?.author).toBe('mira');
    expect(issue87?.commentCount).toBe(4);
    expect(issue87?.isDraft).toBe(false);
    expect(issue87?.ciStatus).toBeUndefined();
    expect(issue87?.reviewDecision).toBe('none');
  });

  it('labels the authored alias as author', () => {
    const pr204 = items.find((item) => item.workItem.number === 204);
    expect(pr204?.roles).toEqual(['author']);
    expect(pr204?.reviewDecision).toBe('changes-requested');
  });

  it('sorts newest-updated first', () => {
    const stamps = items.map((item) => item.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it('maps SUCCESS to passing and PENDING to pending', () => {
    const passing = payloadWith('reviewRequested', {
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    });
    const pending = payloadWith('reviewRequested', {
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
    });
    expect(parseInboxPayload(passing)[0].ciStatus).toBe('passing');
    expect(parseInboxPayload(pending)[0].ciStatus).toBe('pending');
  });

  it('normalises APPROVED and treats a missing verdict as none', () => {
    expect(parseInboxPayload(payloadWith('authored', { reviewDecision: 'APPROVED' }))[0].reviewDecision).toBe('approved');
    expect(parseInboxPayload(payloadWith('authored', { reviewDecision: null }))[0].reviewDecision).toBe('none');
  });

  it('carries isDraft through and defaults author and comments when GitHub omits them', () => {
    const [draft] = parseInboxPayload(payloadWith('authored', { isDraft: true }));
    expect(draft.isDraft).toBe(true);
    expect(draft.author).toBe('');
    expect(draft.commentCount).toBe(0);
  });

  it('skips malformed nodes rather than throwing', () => {
    const payload = { data: { assigned: { nodes: [{ __typename: 'Issue', title: 'no repo' }] } } };
    expect(parseInboxPayload(payload)).toEqual([]);
  });

  // A driver must throw on an unrecognised reply, never return an empty list —
  // an empty inbox and a broken fetch must never look the same to the caller.
  it('throws when the payload has no data object', () => {
    expect(() => parseInboxPayload({})).toThrow(/data/);
  });

  it('throws when the payload is null', () => {
    expect(() => parseInboxPayload(null)).toThrow();
  });

  it('throws when the payload is not an object', () => {
    expect(() => parseInboxPayload('not an object')).toThrow('Inbox payload must be a JSON object');
    expect(() => parseInboxPayload(42)).toThrow();
    expect(() => parseInboxPayload(true)).toThrow();
    expect(() => parseInboxPayload([])).toThrow();
  });

  it('throws when payload.data is null', () => {
    expect(() => parseInboxPayload({ data: null })).toThrow('GitHub API returned no data');
  });

  it('throws when payload.errors exists with no data, carrying the error message', () => {
    expect(() => parseInboxPayload({ errors: [{ message: 'API rate limit exceeded' }] })).toThrow(
      'API rate limit exceeded'
    );
  });

  it('does not throw when errors exist but data is present and valid', () => {
    const payload = {
      data: { assigned: { nodes: [] }, authored: { nodes: [] }, reviewRequested: { nodes: [] } },
      errors: [{ message: 'Some warning' }],
    };
    expect(parseInboxPayload(payload)).toEqual([]);
  });

  it('parses data present with a missing alias key as empty for that alias', () => {
    expect(parseInboxPayload({ data: { assigned: { nodes: [] } } })).toEqual([]);
  });
});
