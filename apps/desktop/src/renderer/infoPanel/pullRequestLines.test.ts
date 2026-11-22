import { describe, expect, it } from 'vitest';
import type {
  WorkItemDetails,
  WorkItemPerson,
  WorkItemReviewer,
  WorkItemThread,
  WorkItemThreadComment,
  WorkItemTimelineItem,
} from '../../shared/workItemDetails';
import type { WorkItemRef } from '../../shared/workItems';
import {
  checksLine,
  commentsLine,
  mergeLine,
  noAccountLine,
  reviewersSaid,
  reviewLine,
  threadsLine,
  titleLabel,
} from './pullRequestLines';

const checks = (...states: string[]): WorkItemDetails['checks'] =>
  states.map((state, index) => ({ name: `check-${index}`, state, url: '' }));

const person = (login: string): WorkItemPerson => ({
  login,
  avatarUrl: `https://avatars.example/${login}`,
  isBot: false,
});

describe('checksLine', () => {
  it('checks: failing beats running beats passed, and no checks draw nothing', () => {
    expect(checksLine(checks('FAILURE', 'SUCCESS'))).toEqual({
      text: '1 check failing',
      value: '1 ✓',
      tone: 'error',
      reveal: 'merge',
    });
    expect(checksLine(checks('FAILURE', 'ERROR', 'IN_PROGRESS'))).toMatchObject({
      text: '2 checks failing',
      value: '0 ✓',
      tone: 'error',
    });
    expect(checksLine(checks('IN_PROGRESS', 'SUCCESS', 'SUCCESS'))).toEqual({
      text: 'Checks running',
      value: '2 ✓',
      reveal: 'merge',
    });
    expect(checksLine(checks('SUCCESS'))).toEqual({ text: '1 check passed', reveal: 'merge' });
    expect(checksLine([])).toBeNull();
  });

  it('a skipped check is no failure, nothing still running, and never counted as passed', () => {
    // As the pane says it: 2 passed · 1 skipped.
    expect(checksLine(checks('SUCCESS', 'SUCCESS', 'SKIPPED'))).toEqual({
      text: '2 checks passed',
      value: '1 skipped',
      reveal: 'merge',
    });
    // Neutral and stale are skipped too.
    expect(checksLine(checks('SUCCESS', 'NEUTRAL', 'STALE'))).toEqual({
      text: '1 check passed',
      value: '2 skipped',
      reveal: 'merge',
    });
    expect(checksLine(checks('FAILURE', 'SKIPPED', 'SUCCESS'))).toMatchObject({
      text: '1 check failing',
      value: '1 ✓',
    });
    expect(checksLine(checks('IN_PROGRESS', 'SKIPPED'))).toMatchObject({
      text: 'Checks running',
      value: '0 ✓',
    });
  });

  it('checks that were all skipped say so, and nothing passed', () => {
    expect(checksLine(checks('SKIPPED', 'SKIPPED', 'NEUTRAL'))).toEqual({
      text: '3 checks skipped',
      reveal: 'merge',
    });
    expect(checksLine(checks('SKIPPED'))).toEqual({ text: '1 check skipped', reveal: 'merge' });
  });
});

describe('reviewLine', () => {
  // The stub's #51: changes requested by ellen, a review asked of mateo and the team.
  const reviewers: WorkItemReviewer[] = [
    { who: person('ellen-sprocket'), isTeam: false, state: 'changes-requested' },
    { who: person('mateo-sprocket'), isTeam: false, state: 'requested' },
    { who: { login: 'catalog-maintainers', isBot: false }, isTeam: true, state: 'requested' },
  ];

  it('review: the decision, with each reviewer ringed by their state', () => {
    const line = reviewLine({ reviewDecision: 'CHANGES_REQUESTED', reviewers });
    expect(line.text).toBe('Changes requested');
    expect(line.tone).toBe('error');
    expect(line.reveal).toBeUndefined();
    expect(line.reviewers).toEqual([
      { who: reviewers[0].who, isTeam: false, ring: 'changes-requested' },
      { who: reviewers[1].who, isTeam: false, ring: 'waiting' },
      { who: reviewers[2].who, isTeam: true, ring: 'waiting' },
    ]);
    // The avatars are pictures: the tooltip says who they are.
    expect(reviewersSaid(line.reviewers)).toBe(
      'ellen-sprocket: changes requested, mateo-sprocket: waiting, catalog-maintainers: waiting',
    );
  });

  it('every other decision reads in the Inbox’s words, untoned, and only a verdict rings', () => {
    const verdicts: WorkItemReviewer[] = [
      { who: person('ellen-sprocket'), isTeam: false, state: 'approved' },
      { who: person('mateo-sprocket'), isTeam: false, state: 'commented' },
      { who: person('JaviDev'), isTeam: false, state: 'dismissed' },
    ];
    const approved = reviewLine({ reviewDecision: 'APPROVED', reviewers: verdicts });
    expect(approved.text).toBe('Approved');
    expect(approved.tone).toBeUndefined();
    expect(approved.reviewers.map((reviewer) => reviewer.ring)).toEqual([
      'approved',
      'waiting',
      'waiting',
    ]);
    expect(reviewLine({ reviewDecision: 'REVIEW_REQUIRED', reviewers: [] }).text).toBe(
      'Awaiting approval',
    );
    expect(reviewLine({ reviewDecision: undefined, reviewers: [] })).toEqual({
      text: 'No review yet',
      reviewers: [],
    });
  });
});

describe('threadsLine', () => {
  const comment = (pending: boolean): WorkItemThreadComment => ({
    id: `c-${pending}`,
    author: person('ellen-sprocket'),
    body: 'Could this retry?',
    url: '',
    createdAt: '2026-11-18T09:00:00Z',
    reactions: [],
    viewerCanEdit: false,
    pending,
    viewerCanDelete: false,
  });
  const thread = (id: string, isResolved: boolean, ...pending: boolean[]): WorkItemThread => ({
    id,
    path: 'src/billing.ts',
    line: 7,
    side: 'RIGHT',
    diffHunk: '',
    isResolved,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    comments: pending.map(comment),
  });

  it('threads count only what is unresolved and visible to others', () => {
    expect(
      threadsLine([
        thread('resolved', true, false),
        thread('open', false, false),
        // The viewer's own draft review: nobody else can see it yet.
        thread('draft', false, true, true),
      ]),
    ).toEqual({ text: '1 unresolved thread', reveal: 'files' });
    // A reply still in the draft review does not hide a thread others can see.
    expect(threadsLine([thread('a', false, false, true), thread('b', false, false)])).toMatchObject(
      { text: '2 unresolved threads' },
    );
    expect(threadsLine([thread('resolved', true, false)])).toBeNull();
    expect(threadsLine([])).toBeNull();
  });
});

describe('mergeLine', () => {
  it('merge: only an open pull request says what is in the way', () => {
    expect(mergeLine({ state: 'open', mergeState: 'BLOCKED', baseBranch: 'main' })).toEqual({
      text: 'Blocked until requirements pass',
      tone: 'muted',
      reveal: 'merge',
    });
    expect(mergeLine({ state: 'open', mergeState: 'BEHIND', baseBranch: 'main' })?.text).toBe(
      'Behind main',
    );
    expect(mergeLine({ state: 'merged', mergeState: 'BLOCKED', baseBranch: 'main' })).toBeNull();
    expect(mergeLine({ state: 'closed', mergeState: 'DIRTY', baseBranch: 'main' })).toBeNull();
    // GitHub said nothing about it: nothing to say.
    expect(mergeLine({ state: 'open', mergeState: undefined, baseBranch: 'main' })).toBeNull();
  });
});

describe('commentsLine', () => {
  const at = { createdAt: '2026-11-18T09:00:00Z' };
  const post = {
    author: person('ellen-sprocket'),
    body: 'Thanks',
    url: '',
    reactions: [],
    viewerCanEdit: false,
  };

  it('comments counts comments only', () => {
    const timeline: WorkItemTimelineItem[] = [
      { ...at, ...post, kind: 'comment', id: 'c1' },
      { ...at, ...post, kind: 'review', id: 'r1', state: 'COMMENTED' },
      { ...at, kind: 'assigned', id: 'e1', actor: person('JaviDev'), assignee: 'JaviDev' },
      { ...at, ...post, kind: 'comment', id: 'c2' },
    ];
    expect(commentsLine(timeline)).toEqual({ text: '2 comments' });
    expect(commentsLine(timeline.slice(0, 1))).toEqual({ text: '1 comment' });
    expect(commentsLine([])).toEqual({ text: '0 comments' });
  });
});

describe('titleLabel', () => {
  const pr: WorkItemRef = {
    provider: 'github',
    repo: 'sprocket/catalog-portal',
    type: 'pr',
    number: 77,
  };

  it('names the item by its title, else by its repository, never by its kind alone', () => {
    expect(titleLabel(pr, 'Extract billing client')).toBe('Extract billing client #77');
    // Neither the details nor the Inbox have said its title yet.
    expect(titleLabel(pr, undefined)).toBe('sprocket/catalog-portal #77');
    expect(titleLabel({ ...pr, type: 'issue', number: 12 }, undefined)).toBe(
      'sprocket/catalog-portal #12',
    );
  });
});

describe('noAccountLine', () => {
  it('says what the workspace has no account to read', () => {
    expect(
      noAccountLine({
        provider: 'github',
        repo: 'sprocket/catalog-portal',
        type: 'issue',
        number: 12,
      }),
    ).toBe('This workspace has no account to read issues with.');
    expect(
      noAccountLine({
        provider: 'github',
        repo: 'sprocket/catalog-portal',
        type: 'pr',
        number: 77,
      }),
    ).toBe('This workspace has no account to read pull requests with.');
    // A branch with no link: what it could have is a pull request.
    expect(noAccountLine(undefined)).toBe(
      'This workspace has no account to read pull requests with.',
    );
  });
});
