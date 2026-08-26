// src/renderer/components/Inbox/inboxFilters.test.ts
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../shared/workItems';
import {
  DEFAULT_INBOX_FILTER,
  INBOX_UPDATED_FILTERS,
  UPDATED_FILTER_LABELS,
  filterByRepos,
  filterByUpdated,
  isInboxUpdatedFilter,
  reposInSnapshot,
} from './inboxFilters';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-08-25T12:00:00Z');

function makeItem(number: number, repo: string, ageDays: number): InboxItem {
  return {
    workItem: { provider: 'github', repo, type: 'pr', number },
    title: `Item ${number}`,
    author: 'someone',
    roles: ['author'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'none',
    commentCount: 0,
    updatedAt: new Date(now - ageDays * DAY).toISOString(),
    url: `https://github.com/${repo}/pull/${number}`,
  };
}

const numbers = (items: InboxItem[]) => items.map((item) => item.workItem.number);

const fresh = makeItem(1, 'sympower/flex-portal', 1);
const sixDays = makeItem(2, 'sympower/controller-app', 6);
const eightDays = makeItem(3, 'sympower/flex-portal', 8);
const twentyNineDays = makeItem(4, 'sympower/msa-resource-bff', 29);
const thirtyOneDays = makeItem(5, 'sympower/flex-portal', 31);
const eightyNineDays = makeItem(6, 'sympower/controller-app', 89);
const ninetyOneDays = makeItem(7, 'sympower/old-repo', 91);
const all = [fresh, sixDays, eightDays, twentyNineDays, thirtyOneDays, eightyNineDays, ninetyOneDays];

describe('the Updated vocabulary', () => {
  it("lists the four ranges in menu order with GitHub's labels, month the default", () => {
    expect(INBOX_UPDATED_FILTERS).toEqual(['week', 'month', 'quarter', 'any']);
    expect(UPDATED_FILTER_LABELS).toEqual({
      week: 'Last week',
      month: 'Last month',
      quarter: 'Last 3 months',
      any: 'Any time',
    });
    expect(DEFAULT_INBOX_FILTER).toEqual({ repos: [], updated: 'month' });
    expect(Object.isFrozen(DEFAULT_INBOX_FILTER)).toBe(true);
  });

  it('recognises its own members and nothing else', () => {
    expect(isInboxUpdatedFilter('week')).toBe(true);
    expect(isInboxUpdatedFilter('any')).toBe(true);
    expect(isInboxUpdatedFilter('decade')).toBe(false);
    expect(isInboxUpdatedFilter(undefined)).toBe(false);
    expect(isInboxUpdatedFilter(7)).toBe(false);
  });
});

describe('filterByUpdated', () => {
  it('keeps the last 7, 30 or 90 days, inclusive of the boundary day', () => {
    expect(numbers(filterByUpdated(all, 'week', now))).toEqual([1, 2]);
    expect(numbers(filterByUpdated(all, 'month', now))).toEqual([1, 2, 3, 4]);
    expect(numbers(filterByUpdated(all, 'quarter', now))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps everything for any, including an item with no usable stamp', () => {
    const undated = makeItem(8, 'sympower/flex-portal', 0);
    undated.updatedAt = '';
    expect(numbers(filterByUpdated([...all, undated], 'any', now))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('drops an item whose stamp cannot be parsed from a bounded range', () => {
    const undated = makeItem(8, 'sympower/flex-portal', 0);
    undated.updatedAt = 'not a date';
    expect(numbers(filterByUpdated([undated], 'month', now))).toEqual([]);
  });
});

describe('filterByRepos', () => {
  it('passes everything through when nothing is selected -- never "show nothing"', () => {
    expect(filterByRepos(all, [])).toEqual(all);
  });

  it('keeps only the selected repos, case-insensitively', () => {
    expect(numbers(filterByRepos(all, ['Sympower/Controller-App']))).toEqual([2, 6]);
    expect(numbers(filterByRepos(all, ['sympower/controller-app', 'sympower/old-repo']))).toEqual([
      2, 6, 7,
    ]);
  });

  it('yields nothing for a repo the snapshot does not have', () => {
    expect(filterByRepos(all, ['sympower/nowhere'])).toEqual([]);
  });
});

describe('reposInSnapshot', () => {
  it('dedupes and sorts the repos present', () => {
    expect(reposInSnapshot(all)).toEqual([
      'sympower/controller-app',
      'sympower/flex-portal',
      'sympower/msa-resource-bff',
      'sympower/old-repo',
    ]);
    expect(reposInSnapshot([])).toEqual([]);
  });
});
