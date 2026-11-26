import { describe, expect, it } from 'vitest';
import { bucketize } from './bucketize';
import { applyFilter } from './filter';
import { buildForest } from './forest';
import { RUN_FACET_DOMAIN } from './entry';
import type { Entry } from './entry';
import { entry, ids, keyOf } from './entryFixtures';

const keys = (list: Array<{ key: string }>) => list.map((e) => e.key.replace('session:', ''));

describe('applyFilter', () => {
  const entries = [
    entry('a', 'working', { labels: ['bug'], facets: { harness: 'h1', scope: 's1' } }),
    entry('b', 'ready', { labels: ['bug', 'ui'], facets: { harness: 'h2', scope: 's1' } }),
    entry('c', 'ready', { labels: [], facets: { harness: 'h1' } }),
  ];

  it('keeps everything for an empty selection', () => {
    const result = applyFilter(entries, {});
    expect(keys(result.entries)).toEqual(['a', 'b', 'c']);
    expect(result.hiddenNeedingYou).toBe(0);
  });

  it('treats empty value lists as no filter', () => {
    expect(keys(applyFilter(entries, { labels: [], facets: { harness: [] } }).entries)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('ORs label ids', () => {
    expect(keys(applyFilter(entries, { labels: ['ui', 'missing'] }).entries)).toEqual(['b']);
    expect(keys(applyFilter(entries, { labels: ['ui', 'bug'] }).entries)).toEqual(['a', 'b']);
  });

  it('ORs values within a facet', () => {
    expect(keys(applyFilter(entries, { facets: { harness: ['h1', 'h2'] } }).entries)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('ANDs across facets and labels', () => {
    expect(
      keys(applyFilter(entries, { labels: ['bug'], facets: { harness: ['h1'] } }).entries),
    ).toEqual(['a']);
    expect(
      keys(applyFilter(entries, { facets: { harness: ['h1'], scope: ['s1'] } }).entries),
    ).toEqual(['a']);
  });

  it('hides an entry that lacks a facet its own kind answers for', () => {
    // 'c' is a session with no scope recorded: a session has one, so the
    // filter is entitled to hide it. Contrast a run, below.
    expect(keys(applyFilter(entries, { facets: { scope: ['s1'] } }).entries)).toEqual(['a', 'b']);
  });

  describe('a facet an entry\u2019s kind cannot have', () => {
    const run = (id: string, rest: Partial<Entry> = {}): Entry => ({
      key: `run:${id}`,
      kind: 'run',
      attention: 'needs-attention',
      createdAt: 0,
      activityAt: 0,
      labels: [],
      facets: { automation: 'nightly' },
      facetDomain: RUN_FACET_DOMAIN,
      ...rest,
    });

    it('lets a run past a scope filter: a run has no scope and can never have one', () => {
      const result = applyFilter([...entries, run('1')], { facets: { scope: ['s1'] } });
      expect(result.entries.map((e) => e.key)).toEqual(['session:a', 'session:b', 'run:1']);
      expect(result.hiddenNeedingYou).toBe(0);
    });

    it('still narrows runs by a facet they do have', () => {
      const all = [run('1'), run('2', { facets: { automation: 'weekly' } })];
      const result = applyFilter(all, { facets: { scope: ['s1'], automation: ['nightly'] } });
      expect(result.entries.map((e) => e.key)).toEqual(['run:1']);
      expect(result.hiddenNeedingYou).toBe(1);
    });

    it('does not let a session past a facet it answers for but has no value in', () => {
      // The whole point of declaring a domain rather than reading the keys
      // present: a session with no automation is still hidden by one.
      expect(keys(applyFilter(entries, { facets: { automation: ['nightly'] } }).entries)).toEqual(
        [],
      );
    });

    it('leaves a run that a scope filter would have hidden in its bucket', () => {
      const result = applyFilter([entry('a', 'working', { facets: { scope: 's1' } }), run('1')], {
        facets: { scope: ['s1'] },
      });
      expect(bucketize(buildForest(result.entries)).waiting.map((n) => n.entry.key)).toEqual([
        'run:1',
      ]);
    });
  });

  it('does not mutate its input', () => {
    const copy = [...entries];
    applyFilter(entries, { labels: ['ui'] });
    expect(entries).toEqual(copy);
  });

  describe('hidden-but-needs-you count', () => {
    const mixed = [
      entry('n', 'needs-attention', { labels: ['x'] }),
      entry('d', 'done', { labels: ['x'] }),
      entry('w', 'working', { labels: ['x'] }),
      entry('shown', 'needs-attention', { labels: ['y'] }),
    ];

    it('counts hidden needs-attention and done entries only', () => {
      const result = applyFilter(mixed, { labels: ['y'] });
      expect(keys(result.entries)).toEqual(['shown']);
      expect(result.hiddenNeedingYou).toBe(2);
    });

    it('does not count entries that the filter keeps', () => {
      // Only 'shown' is hidden here; n and d match and are kept.
      expect(applyFilter(mixed, { labels: ['x'] }).hiddenNeedingYou).toBe(1);
    });

    it('counts runs and gates the same way', () => {
      const run = {
        ...entry('r', 'needs-attention'),
        key: 'run:1' as const,
        kind: 'run',
        facetDomain: RUN_FACET_DOMAIN,
      };
      expect(applyFilter([run], { labels: ['x'] }).hiddenNeedingYou).toBe(1);
    });
  });

  describe('against bucketing', () => {
    const bucketsOf = (
      list: Array<ReturnType<typeof entry>>,
      selection: Parameters<typeof applyFilter>[1],
    ) => {
      const result = applyFilter(list, selection);
      return { result, buckets: bucketize(buildForest(result.entries)) };
    };

    it('leaves a row that is not part of a tree in its bucket', () => {
      const all = [
        entry('w', 'working', { labels: ['x'] }),
        entry('asks', 'needs-attention', { labels: ['y'] }),
      ];
      const { buckets } = bucketsOf(all, { labels: ['x'] });
      expect(ids(buckets.working)).toEqual(['w']);
    });

    it('makes a child a root in its own bucket when its conductor is hidden', () => {
      const all = [
        entry('p', 'working', { labels: ['y'] }),
        entry('c', 'needs-attention', { parent: keyOf('p'), labels: ['x'] }),
      ];
      const { result, buckets } = bucketsOf(all, { labels: ['x'] });
      expect(ids(buckets.waiting)).toEqual(['c']);
      expect(buckets.waiting[0].children).toEqual([]);
      expect(buckets.working).toEqual([]);
      expect(result.hiddenNeedingYou).toBe(0);
    });

    it.each(['needs-attention', 'done'] as const)(
      'rebuckets a working conductor out of its tree bucket when its %s child is hidden, and reports it',
      (attention) => {
        const all = [
          entry('p', 'working', { labels: ['x'] }),
          entry('c', attention, { parent: keyOf('p'), labels: ['y'] }),
        ];
        expect(ids(bucketize(buildForest(all)).waiting)).toEqual(['p']);
        const { result, buckets } = bucketsOf(all, { labels: ['x'] });
        expect(ids(buckets.working)).toEqual(['p']);
        expect(buckets.waiting).toEqual([]);
        expect(buckets.settled).toEqual([]);
        expect(result.hiddenNeedingYou).toBe(1);
      },
    );
  });
});
