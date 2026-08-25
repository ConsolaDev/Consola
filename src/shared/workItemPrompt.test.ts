import { describe, expect, it } from 'vitest';
import { PROVIDER_META } from './providers';
import type { InboxItem, WorkItemRef } from './workItems';
import { fallbackWorkItemTitle, renderActionPrompt, renderSeedHeader, substitutePlaceholders } from './workItemPrompt';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
const issue87: WorkItemRef = { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 };

const item51: InboxItem = {
  workItem: pr51,
  title: 'Extract billing client',
  author: 'anna',
  roles: ['review-requested-direct'],
  isDraft: false,
  state: 'open',
  reviewDecision: 'review-required',
  ciStatus: 'failing',
  commentCount: 3,
  updatedAt: '2026-08-20T07:55:00Z',
  url: 'https://github.com/sympower/controller-app/pull/51',
};

describe('fallbackWorkItemTitle', () => {
  it('names the item by type and number when the inbox has no title for it', () => {
    expect(fallbackWorkItemTitle(pr51)).toBe('PR #51');
    expect(fallbackWorkItemTitle(issue87)).toBe('Issue #87');
  });
});

describe('substitutePlaceholders', () => {
  it('fills every placeholder from the cached item', () => {
    expect(
      substitutePlaceholders('{{type}} {{number}} in {{repo}}: "{{title}}" ({{url}})', pr51, item51)
    ).toBe(
      'pull request 51 in sympower/controller-app: "Extract billing client" (https://github.com/sympower/controller-app/pull/51)'
    );
  });

  it('falls back to a plain title and the canonical URL when the inbox has no item', () => {
    expect(substitutePlaceholders('{{title}} at {{url}}', issue87)).toBe(
      'Issue #87 at https://github.com/sympower/msa-resource-bff/issues/87'
    );
  });

  it('renders {{type}} as "issue" for issues', () => {
    expect(substitutePlaceholders('this {{type}}', issue87)).toBe('this issue');
  });

  it('substitutes every occurrence and tolerates whitespace inside the braces', () => {
    expect(substitutePlaceholders('{{ number }}/{{number}}', pr51)).toBe('51/51');
  });

  it('passes a template with no placeholders through untouched — a bare slash command', () => {
    expect(substitutePlaceholders('/review', pr51, item51)).toBe('/review');
  });

  it('leaves a placeholder it does not know alone rather than blanking it', () => {
    expect(substitutePlaceholders('see {{branch}}', pr51)).toBe('see {{branch}}');
  });
});

describe('renderSeedHeader', () => {
  it('picks the template by item type and renders the GitHub header verbatim', () => {
    expect(renderSeedHeader(PROVIDER_META.github.seedHeaderTemplate, pr51, item51)).toBe(
      'This session is for pull request #51 ("Extract billing client") in sympower/controller-app. ' +
        "You are in a dedicated git worktree for it, so the user's own checkout stays untouched. " +
        'Start with `gh pr view 51` to read it.'
    );
    expect(renderSeedHeader(PROVIDER_META.github.seedHeaderTemplate, issue87)).toBe(
      'This session is for issue #87 ("Issue #87") in sympower/msa-resource-bff. ' +
        "You are in a dedicated git worktree for it, so the user's own checkout stays untouched. " +
        'Start with `gh issue view 87` to read it.'
    );
  });
});

describe('renderActionPrompt', () => {
  const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
  const item51: InboxItem = {
    workItem: pr51,
    title: 'Extract billing client',
    author: 'steve-sympower',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    ciStatus: 'failing',
    commentCount: 1,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
  };
  const header = 'HEADER';

  it('joins the header and the rendered body with a blank line', () => {
    const result = renderActionPrompt(header, 'Review {{type}} #{{number}}.', pr51, item51);
    expect(result).toEqual({ ok: true, seedPrompt: 'HEADER\n\nReview pull request #51.' });
  });

  it('renders every placeholder from the cached item', () => {
    const result = renderActionPrompt(
      header,
      '{{number}} | {{repo}} | {{title}} | {{url}} | {{type}}',
      pr51,
      item51
    );
    expect(result).toEqual({
      ok: true,
      seedPrompt:
        'HEADER\n\n51 | sympower/controller-app | Extract billing client | https://github.com/sympower/controller-app/pull/51 | pull request',
    });
  });

  it('falls back to the plain title and canonical url without a cached item', () => {
    const issue87: WorkItemRef = { ...pr51, type: 'issue', number: 87 };
    const result = renderActionPrompt(header, '{{title}} {{url}} {{type}}', issue87);
    expect(result).toEqual({
      ok: true,
      seedPrompt: 'HEADER\n\nIssue #87 https://github.com/sympower/controller-app/issues/87 issue',
    });
  });

  it('passes a bare slash command through untouched', () => {
    const result = renderActionPrompt(header, '/security-review', pr51, item51);
    expect(result).toEqual({ ok: true, seedPrompt: 'HEADER\n\n/security-review' });
  });

  it('refuses an empty or whitespace-only rendered body', () => {
    expect(renderActionPrompt(header, '', pr51, item51)).toEqual({
      ok: false,
      message: 'This action has no prompt to send.',
    });
    expect(renderActionPrompt(header, '  \n\t ', pr51, item51).ok).toBe(false);
  });

  it('trims the body but never the header', () => {
    const result = renderActionPrompt(header, '  Fix CI.  \n', pr51, item51);
    expect(result).toEqual({ ok: true, seedPrompt: 'HEADER\n\nFix CI.' });
  });
});
