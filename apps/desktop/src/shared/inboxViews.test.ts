import { describe, expect, it } from 'vitest';
import { INBOX_SECTIONS } from './inboxSections';
import { INBOX_VIEWS, groupBySection, itemsForView } from './inboxViews';
import type { InboxItem, InboxRole } from './workItems';

/**
 * The item number doubles as its day of the month, so sorting by updatedAt
 * descending is the same as sorting by number descending -- which keeps
 * every ordering assertion below readable.
 */
function makeItem(number: number, roles: InboxRole[], overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    workItem: { provider: 'github', repo: 'sympower/flex-portal', type: 'pr', number },
    title: `Item ${number}`,
    author: 'someone',
    roles,
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    commentCount: 0,
    updatedAt: `2026-08-${String(number).padStart(2, '0')}T00:00:00Z`,
    url: `https://github.com/sympower/flex-portal/pull/${number}`,
    ...overrides,
  };
}

const numbers = (items: InboxItem[]) => items.map((item) => item.workItem.number);

const direct = makeItem(1, ['review-requested-direct']);
const team = makeItem(2, ['review-requested-team']);
const authored = makeItem(3, ['author']);
const assignedIssue = makeItem(4, ['assignee'], {
  workItem: { provider: 'github', repo: 'sympower/flex-portal', type: 'issue', number: 4 },
});
const involvedOnly = makeItem(5, ['involved']);
// Deliberately unsorted: every view must sort for itself.
const all = [authored, involvedOnly, direct, assignedIssue, team];

describe('INBOX_VIEWS', () => {
  it("lists the five views in tab order with GitHub's labels", () => {
    expect(INBOX_VIEWS).toEqual([
      { id: 'inbox', label: 'Inbox' },
      { id: 'authored', label: 'Authored by me' },
      { id: 'assigned', label: 'Assigned to me' },
      { id: 'involved', label: 'Involves me' },
      { id: 'review-requests', label: 'Review requests' },
    ]);
  });
});

describe('itemsForView', () => {
  it('inbox: only items that land in a section', () => {
    expect(numbers(itemsForView(all, 'inbox'))).toEqual([4, 3, 2, 1]);
  });

  it('authored: the author role', () => {
    expect(numbers(itemsForView(all, 'authored'))).toEqual([3]);
  });

  it('assigned: the assignee role', () => {
    expect(numbers(itemsForView(all, 'assigned'))).toEqual([4]);
  });

  it('involved: every cached item, including one no section wants', () => {
    expect(numbers(itemsForView(all, 'involved'))).toEqual([5, 4, 3, 2, 1]);
    expect(numbers(itemsForView(all, 'inbox'))).not.toContain(5);
  });

  it('review-requests: direct and team requests alike', () => {
    expect(numbers(itemsForView(all, 'review-requests'))).toEqual([2, 1]);
  });

  it('sorts every view newest-updated first', () => {
    for (const { id } of INBOX_VIEWS) {
      const stamps = itemsForView(all, id).map((item) => item.updatedAt);
      expect(stamps).toEqual([...stamps].sort().reverse());
    }
  });

  it('never mutates the cache it reads', () => {
    const before = numbers(all);
    itemsForView(all, 'involved');
    expect(numbers(all)).toEqual(before);
  });
});

describe('groupBySection', () => {
  it('emits all seven sections in display order, empty ones included', () => {
    const groups = groupBySection(all);
    expect(groups.map((group) => group.section)).toEqual(INBOX_SECTIONS.map((section) => section.id));
    const itemsIn = (section: string) =>
      numbers(groups.find((group) => group.section === section)?.items ?? []);
    expect(itemsIn('needs-your-review')).toEqual([1]);
    expect(itemsIn('needs-team-review')).toEqual([2]);
    expect(itemsIn('waiting')).toEqual([3]);
    expect(itemsIn('issues')).toEqual([4]);
    expect(itemsIn('your-drafts')).toEqual([]);
    expect(itemsIn('needs-action')).toEqual([]);
    expect(itemsIn('ready-to-merge')).toEqual([]);
  });

  it('drops an item no section wants', () => {
    const everyGrouped = groupBySection(all).flatMap((group) => numbers(group.items));
    expect(everyGrouped).not.toContain(5);
  });

  it('sorts within a section newest first', () => {
    const later = makeItem(6, ['author']);
    const waiting = groupBySection([authored, later]).find((group) => group.section === 'waiting');
    expect(numbers(waiting?.items ?? [])).toEqual([6, 3]);
  });
});
