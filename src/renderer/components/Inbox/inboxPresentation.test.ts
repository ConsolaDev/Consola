import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import {
  actionFor,
  dotClassFor,
  formatAge,
  metaLineFor,
  primaryRole,
  roleLabelFor,
} from './inboxPresentation';

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
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
    additions: 210,
    deletions: 88,
    ...overrides,
  };
}

const issue87 = { provider: 'github', repo: 'o/r', type: 'issue', number: 87 } as const;

describe('formatAge', () => {
  const now = Date.parse('2026-08-20T09:00:00Z');
  it('labels fresh, minutes, hours, and never', () => {
    expect(formatAge(now - 20_000, now)).toBe('just now');
    expect(formatAge(now - 2 * 60_000, now)).toBe('2m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(0, now)).toBe('never');
  });

  it('rolls over to days once 24 hours have passed', () => {
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('primaryRole', () => {
  it('leads with the reason you were asked over the reason you are attached', () => {
    expect(primaryRole(makeItem({ roles: ['author', 'assignee', 'review-requested-team'] }))).toBe(
      'review-requested-team'
    );
    expect(primaryRole(makeItem({ roles: ['author', 'assignee'] }))).toBe('assignee');
    expect(primaryRole(makeItem({ roles: ['author'] }))).toBe('author');
    expect(primaryRole(makeItem({ roles: [] }))).toBeUndefined();
  });
});

describe('actionFor', () => {
  it('is Open session whenever a session exists, regardless of anything else', () => {
    expect(actionFor(makeItem(), true, false)).toEqual({ label: 'Open session', kind: 'open' });
  });

  it('offers the clone path when the repo has no local clone', () => {
    expect(actionFor(makeItem(), false, false)).toEqual({
      label: 'Clone into scope...',
      kind: 'clone',
    });
  });

  it('labels launches by role: Review, Address review, Start work', () => {
    expect(actionFor(makeItem(), false, true).label).toBe('Review');
    expect(actionFor(makeItem({ roles: ['author'] }), false, true).label).toBe('Address review');
    // Asked to review your own PR: the request wins, as it did when the
    // parser picked one role.
    expect(actionFor(makeItem({ roles: ['author', 'review-requested-direct'] }), false, true).label).toBe('Review');
    expect(actionFor(makeItem({ roles: ['assignee'], workItem: issue87 }), false, true).label).toBe('Start work');
  });
});

describe('metaLineFor and roleLabelFor', () => {
  it('joins repo, role, CI, review state, and diff stats', () => {
    expect(metaLineFor(makeItem())).toBe(
      'controller-app · review requested · CI failing · +210 −88'
    );
  });

  it('labels authored items as yours', () => {
    expect(roleLabelFor(makeItem({ roles: ['author'] }))).toBe('your PR');
    expect(roleLabelFor(makeItem({ roles: ['author'], workItem: issue87 }))).toBe('your issue');
  });

  it('labels assigned items, and team requests like direct ones', () => {
    expect(roleLabelFor(makeItem({ roles: ['assignee'] }))).toBe('assigned to you');
    expect(roleLabelFor(makeItem({ roles: ['review-requested-team'] }))).toBe('review requested');
    expect(roleLabelFor(makeItem({ roles: ['involved'] }))).toBe('involves you');
  });

  it('mentions changes requested when the provider says so', () => {
    expect(metaLineFor(makeItem({ reviewDecision: 'changes-requested' }))).toContain(
      'changes requested'
    );
  });

  it('mentions approved when the provider says so', () => {
    expect(metaLineFor(makeItem({ reviewDecision: 'approved' }))).toContain('approved');
  });

  it('omits CI status and diff stats entirely when the item carries neither, as issues do', () => {
    expect(
      metaLineFor(
        makeItem({
          workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'issue', number: 12 },
          ciStatus: undefined,
          reviewDecision: 'none',
          additions: undefined,
          deletions: undefined,
        })
      )
    ).toBe('controller-app · review requested');
  });
});

describe('dotClassFor', () => {
  it('flags failing CI red, requested reviews attention, the rest idle', () => {
    expect(dotClassFor(makeItem())).toBe('inbox-dot--err');
    expect(dotClassFor(makeItem({ ciStatus: 'passing' }))).toBe('inbox-dot--att');
    expect(dotClassFor(makeItem({ ciStatus: 'passing', roles: ['review-requested-team'] }))).toBe('inbox-dot--att');
    expect(dotClassFor(makeItem({ ciStatus: 'passing', roles: ['assignee'] }))).toBe('inbox-dot--idle');
  });
});
