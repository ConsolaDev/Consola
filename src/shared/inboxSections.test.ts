import { describe, expect, it } from 'vitest';
import type { InboxItem } from './workItems';
import {
  DEFAULT_COLLAPSED_SECTIONS,
  INBOX_SECTIONS,
  sectionFor,
  sectionItemType,
  type InboxSection,
} from './inboxSections';

function pr(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
    title: 'Extract billing client',
    author: 'anna',
    roles: ['author'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    commentCount: 0,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
    ...overrides,
  };
}

function issue(overrides: Partial<InboxItem> = {}): InboxItem {
  return pr({
    workItem: { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 },
    title: 'Rate limit returns 500',
    roles: ['assignee'],
    reviewDecision: 'none',
    url: 'https://github.com/sympower/msa-resource-bff/issues/87',
    ...overrides,
  });
}

describe('sectionFor', () => {
  it('needs-your-review: a PR whose review was requested of you directly', () => {
    expect(sectionFor(pr({ roles: ['review-requested-direct'] }))).toBe('needs-your-review');
  });

  it('needs-team-review: a PR whose review was requested of a team you are on', () => {
    expect(sectionFor(pr({ roles: ['review-requested-team'] }))).toBe('needs-team-review');
  });

  it('your-drafts: your own draft PR', () => {
    expect(sectionFor(pr({ isDraft: true }))).toBe('your-drafts');
  });

  it('needs-action: your PR with changes requested, or with failing CI', () => {
    expect(sectionFor(pr({ reviewDecision: 'changes-requested' }))).toBe('needs-action');
    expect(sectionFor(pr({ ciStatus: 'failing' }))).toBe('needs-action');
  });

  it('ready-to-merge: your approved PR whose checks pass or do not exist', () => {
    expect(sectionFor(pr({ reviewDecision: 'approved', ciStatus: 'passing' }))).toBe('ready-to-merge');
    expect(sectionFor(pr({ reviewDecision: 'approved' }))).toBe('ready-to-merge');
  });

  it('waiting: every other PR of yours — review pending, or approved with checks still running', () => {
    expect(sectionFor(pr())).toBe('waiting');
    expect(sectionFor(pr({ reviewDecision: 'approved', ciStatus: 'pending' }))).toBe('waiting');
  });

  it('issues: an issue assigned to you', () => {
    expect(sectionFor(issue())).toBe('issues');
  });

  it('first match wins: a review request outranks authorship, drafts and failing CI', () => {
    expect(
      sectionFor(pr({ roles: ['author', 'review-requested-direct'], isDraft: true, ciStatus: 'failing' }))
    ).toBe('needs-your-review');
    expect(sectionFor(pr({ roles: ['author', 'review-requested-team'], isDraft: true }))).toBe(
      'needs-team-review'
    );
  });

  it('has no section for items you are merely involved in, or issues you did not get assigned', () => {
    // Absent from the Inbox view; Phase D's "Involves me" view still lists them.
    expect(sectionFor(pr({ roles: ['involved'] }))).toBeNull();
    expect(sectionFor(issue({ roles: ['author'] }))).toBeNull();
    expect(sectionFor(issue({ roles: ['review-requested-direct'] }))).toBeNull();
  });
});

describe('sectionItemType', () => {
  it('holds issues only in the issues section', () => {
    const sections = INBOX_SECTIONS.map((section) => section.id);
    expect(sections.filter((id) => sectionItemType(id) === 'issue')).toEqual(['issues']);
    expect(sections.filter((id) => sectionItemType(id) === 'pr')).toHaveLength(6);
  });
});

describe('INBOX_SECTIONS', () => {
  it("lists every section once, in GitHub's display order with Issues last", () => {
    expect(INBOX_SECTIONS.map((section) => section.id)).toEqual<InboxSection[]>([
      'needs-your-review',
      'needs-team-review',
      'your-drafts',
      'waiting',
      'needs-action',
      'ready-to-merge',
      'issues',
    ]);
  });

  it('labels sections the way GitHub does', () => {
    expect(INBOX_SECTIONS.map((section) => section.label)).toEqual([
      'Needs your review',
      "Needs your teams' review",
      'Your drafts',
      'Waiting for review or checks',
      'Needs action',
      'Ready to merge',
      'Issues assigned to you',
    ]);
  });
});

describe('DEFAULT_COLLAPSED_SECTIONS', () => {
  it('starts the low-urgency sections collapsed and the rest open', () => {
    expect([...DEFAULT_COLLAPSED_SECTIONS].sort()).toEqual([
      'needs-team-review',
      'ready-to-merge',
      'your-drafts',
    ]);
    expect(DEFAULT_COLLAPSED_SECTIONS.has('needs-your-review')).toBe(false);
    expect(DEFAULT_COLLAPSED_SECTIONS.has('issues')).toBe(false);
  });
});
