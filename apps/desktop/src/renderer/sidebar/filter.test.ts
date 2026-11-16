import { describe, expect, it } from 'vitest';
import { bucketize } from './bucketize';
import { applyFilter } from './filter';
import { buildForest } from './forest';
import { entry, ids, keyOf } from './entryFixtures';

const keys = (list: { key: string }[]) => list.map((e) => e.key.replace('session:', ''));

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
    expect(keys(applyFilter(entries, { labels: [], facets: { harness: [] } }).entries)).toEqual(['a', 'b', 'c']);
  });

  it('ORs label ids', () => {
    expect(keys(applyFilter(entries, { labels: ['ui', 'missing'] }).entries)).toEqual(['b']);
    expect(keys(applyFilter(entries, { labels: ['ui', 'bug'] }).entries)).toEqual(['a', 'b']);
  });

  it('ORs values within a facet', () => {
    expect(keys(applyFilter(entries, { facets: { harness: ['h1', 'h2'] } }).entries)).toEqual(['a', 'b', 'c']);
  });

  it('ANDs across facets and labels', () => {
    expect(keys(applyFilter(entries, { labels: ['bug'], facets: { harness: ['h1'] } }).entries)).toEqual(['a']);
    expect(keys(applyFilter(entries, { facets: { harness: ['h1'], scope: ['s1'] } }).entries)).toEqual(['a']);
  });

  it('hides an entry that lacks the facet altogether', () => {
    expect(keys(applyFilter(entries, { facets: { scope: ['s1'] } }).entries)).toEqual(['a', 'b']);
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
      const run = { ...entry('r', 'needs-attention'), key: 'run:1' as const, kind: 'run' };
      expect(applyFilter([run], { labels: ['x'] }).hiddenNeedingYou).toBe(1);
    });
  });

  describe('against bucketing', () => {
    it('does not move a surviving row to a different bucket', () => {
      const all = [
        entry('p', 'working', { labels: ['x'] }),
        entry('c', 'needs-attention', { parent: keyOf('p'), labels: ['x'] }),
        entry('q', 'working', { labels: ['x'] }),
      ];
      const unfiltered = bucketize(buildForest(all));
      const filtered = bucketize(buildForest(applyFilter(all, { labels: ['x'] }).entries));
      expect(ids(filtered.waiting)).toEqual(ids(unfiltered.waiting));
      expect(ids(filtered.working)).toEqual(ids(unfiltered.working));
    });

    it('lets a hidden waiting row go, but reports it', () => {
      const all = [entry('asks', 'needs-attention', { labels: ['x'] }), entry('busy', 'working', { labels: ['y'] })];
      const result = applyFilter(all, { labels: ['y'] });
      const buckets = bucketize(buildForest(result.entries));
      expect(buckets.waiting).toEqual([]);
      expect(ids(buckets.working)).toEqual(['busy']);
      expect(result.hiddenNeedingYou).toBe(1);
    });
  });
});
