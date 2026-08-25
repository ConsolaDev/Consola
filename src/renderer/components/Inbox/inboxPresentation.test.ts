// src/renderer/components/Inbox/inboxPresentation.test.ts
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import { createSessionRecord, type Session } from '../../../shared/workspace';
import type { TerminalState } from '../../stores/terminalStore';
import {
  checksLabel,
  formatAge,
  groupSessionsByWorkItem,
  hasAccentBar,
  isRepoCloned,
  metaLineFor,
  relativeTime,
  reviewStateLabel,
  roleLabelFor,
  worstStatusForItem,
} from './inboxPresentation';

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 },
    title: 'Extract billing client',
    author: 'steve-sympower',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    ciStatus: 'failing',
    checks: { passed: 2, failed: 1, pending: 0, total: 3 },
    commentCount: 1,
    additions: 210,
    deletions: 88,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sympower/controller-app/pull/51',
    ...overrides,
  };
}

function makeSession(instanceId: string, workItem?: Session['workItem']): Session {
  return createSessionRecord({
    name: instanceId,
    workspaceId: 'ws-1',
    instanceId,
    harnessId: 'default',
    scopeId: 'scope-1',
    workItem,
  });
}

const IDLE: TerminalState = {
  isBusy: false,
  isAwaitingConfirmation: false,
  hasExited: false,
  completedWhileAway: false,
  status: 'ready',
};

const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;
const issue12 = { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 12 } as const;

describe('formatAge', () => {
  const now = Date.parse('2026-08-20T09:00:00Z');

  it('labels fresh, minutes, hours, days, and never', () => {
    expect(formatAge(now - 20_000, now)).toBe('just now');
    expect(formatAge(now - 2 * 60_000, now)).toBe('2m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(formatAge(0, now)).toBe('never');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-08-20T09:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('is compact at every boundary', () => {
    expect(relativeTime(ago(30_000), now)).toBe('now');
    expect(relativeTime(ago(MINUTE), now)).toBe('1m');
    expect(relativeTime(ago(59 * MINUTE), now)).toBe('59m');
    expect(relativeTime(ago(HOUR), now)).toBe('1h');
    expect(relativeTime(ago(23 * HOUR), now)).toBe('23h');
    expect(relativeTime(ago(DAY), now)).toBe('1d');
    expect(relativeTime(ago(6 * DAY), now)).toBe('6d');
    expect(relativeTime(ago(7 * DAY), now)).toBe('1w');
    expect(relativeTime(ago(29 * DAY), now)).toBe('4w');
    expect(relativeTime(ago(30 * DAY), now)).toBe('1mo');
    expect(relativeTime(ago(364 * DAY), now)).toBe('12mo');
    expect(relativeTime(ago(365 * DAY), now)).toBe('1y');
  });

  it('treats a stamp from the future as now, and an unparseable one as blank', () => {
    expect(relativeTime(ago(-HOUR), now)).toBe('now');
    expect(relativeTime('', now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('reviewStateLabel', () => {
  it('names the three decisions and stays quiet for none', () => {
    expect(reviewStateLabel(makeItem({ reviewDecision: 'approved' }))).toBe('Approved');
    expect(reviewStateLabel(makeItem({ reviewDecision: 'changes-requested' }))).toBe(
      'Changes requested'
    );
    expect(reviewStateLabel(makeItem({ reviewDecision: 'review-required' }))).toBe(
      'Awaiting approval'
    );
    expect(reviewStateLabel(makeItem({ reviewDecision: 'none' }))).toBeNull();
  });
});

describe('checksLabel', () => {
  it('is null with no checks, or none to count', () => {
    expect(checksLabel(undefined)).toBeNull();
    expect(checksLabel({ passed: 0, failed: 0, pending: 0, total: 0 })).toBeNull();
  });

  it('reads passed over total, toned by the worst thing in the set', () => {
    expect(checksLabel({ passed: 4, failed: 0, pending: 0, total: 4 })).toEqual({
      text: '4/4',
      tone: 'ok',
    });
    expect(checksLabel({ passed: 3, failed: 0, pending: 2, total: 5 })).toEqual({
      text: '3/5',
      tone: 'warn',
    });
    expect(checksLabel({ passed: 2, failed: 1, pending: 0, total: 3 })).toEqual({
      text: '2/3',
      tone: 'bad',
    });
    expect(checksLabel({ passed: 1, failed: 1, pending: 1, total: 3 })).toEqual({
      text: '1/3',
      tone: 'bad',
    });
  });
});

describe('hasAccentBar', () => {
  it('marks direct review requests only, as GitHub does', () => {
    expect(hasAccentBar(makeItem())).toBe(true);
    expect(hasAccentBar(makeItem({ roles: ['review-requested-team'] }))).toBe(false);
    expect(hasAccentBar(makeItem({ roles: ['author', 'review-requested-direct'] }))).toBe(true);
  });
});

describe('isRepoCloned', () => {
  it('assumes cloned until main has answered, and for repos main was not asked about', () => {
    expect(isRepoCloned(undefined, 'sympower/controller-app')).toBe(true);
    expect(isRepoCloned({}, 'sympower/controller-app')).toBe(true);
  });

  it('reads a null answer as not cloned and a path as cloned', () => {
    expect(isRepoCloned({ 'sympower/controller-app': null }, 'sympower/controller-app')).toBe(false);
    expect(
      isRepoCloned({ 'sympower/controller-app': '/repos/controller-app' }, 'sympower/controller-app')
    ).toBe(true);
  });
});

describe('roleLabelFor and metaLineFor', () => {
  it('names the strongest role', () => {
    expect(roleLabelFor(makeItem())).toBe('review requested');
    expect(roleLabelFor(makeItem({ roles: ['review-requested-team'] }))).toBe('team review requested');
    expect(roleLabelFor(makeItem({ roles: ['author'] }))).toBe('your PR');
    expect(
      roleLabelFor(makeItem({ roles: ['author'], workItem: { ...issue12 } }))
    ).toBe('your issue');
    expect(roleLabelFor(makeItem({ roles: ['assignee'] }))).toBe('assigned to you');
    expect(roleLabelFor(makeItem({ roles: ['involved'] }))).toBe('involves you');
  });

  it('joins repo, role, CI, review state, and diff stats', () => {
    expect(metaLineFor(makeItem())).toBe(
      'controller-app · review requested · CI failing · awaiting approval · +210 −88'
    );
  });

  it('omits what an issue does not have', () => {
    expect(
      metaLineFor(
        makeItem({
          workItem: { ...issue12 },
          roles: ['assignee'],
          reviewDecision: 'none',
          ciStatus: undefined,
          checks: undefined,
          additions: undefined,
          deletions: undefined,
        })
      )
    ).toBe('msa-resource-bff · assigned to you');
  });
});

describe('groupSessionsByWorkItem', () => {
  it('buckets linked sessions by item and skips unlinked ones', () => {
    const a = makeSession('a', { ...pr51 });
    const b = makeSession('b', { ...pr51, repo: 'Sympower/Controller-App' });
    const c = makeSession('c', { ...issue12 });
    const plain = makeSession('plain');

    const grouped = groupSessionsByWorkItem([a, plain, b, c]);

    expect([...grouped.keys()]).toEqual([
      'github:sympower/controller-app:pr:51',
      'github:sympower/msa-resource-bff:issue:12',
    ]);
    expect(grouped.get('github:sympower/controller-app:pr:51')).toEqual([a, b]);
    expect(grouped.get('github:sympower/msa-resource-bff:issue:12')).toEqual([c]);
  });
});

describe('worstStatusForItem', () => {
  it('rolls the linked sessions up with the shared ranking', () => {
    const a = makeSession('a', { ...pr51 });
    const b = makeSession('b', { ...pr51 });
    const terminals = {
      a: { ...IDLE, isBusy: true },
      b: { ...IDLE, isAwaitingConfirmation: true },
    };
    expect(worstStatusForItem([a, b], terminals)).toBe('needs-attention');
    expect(worstStatusForItem([a], terminals)).toBe('working');
    expect(worstStatusForItem([], terminals)).toBe('ready');
  });
});
