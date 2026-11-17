import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/attention';
import { bucketize, type Bucket } from './bucketize';
import { buildForest } from './forest';
import { entry, ids, keyOf, node } from './entryFixtures';

// Everything in play that is not running waits at the top; Settled holds only
// what was put away. Stopping is not settling.
const EXPECTED: Record<Attention, Bucket> = {
  'needs-attention': 'waiting',
  done: 'waiting',
  ready: 'waiting',
  exited: 'waiting',
  working: 'working',
  settled: 'settled',
};

describe('bucketize', () => {
  it.each(Object.entries(EXPECTED) as [Attention, Bucket][])(
    'puts a %s row in %s',
    (attention, bucket) => {
      const result = bucketize([node(entry('a', attention))]);
      expect(ids(result[bucket])).toEqual(['a']);
      const others = (Object.keys(result) as Bucket[]).filter((name) => name !== bucket);
      expect(others.flatMap((name) => ids(result[name]))).toEqual([]);
    },
  );

  it('returns every bucket, empty when nothing belongs in it', () => {
    expect(bucketize([])).toEqual({ waiting: [], working: [], settled: [] });
  });

  describe('ordering', () => {
    it('sorts waiting by since ascending, longest-waiting first', () => {
      const result = bucketize([
        node(entry('new', 'needs-attention', { since: 300 })),
        node(entry('old', 'needs-attention', { since: 100 })),
        node(entry('mid', 'needs-attention', { since: 200 })),
      ]);
      expect(ids(result.waiting)).toEqual(['old', 'mid', 'new']);
    });

    it('sorts unread results by finishedAt descending', () => {
      const result = bucketize([
        node(entry('a', 'done', { finishedAt: 100 })),
        node(entry('c', 'done', { finishedAt: 300 })),
        node(entry('b', 'done', { finishedAt: 200 })),
      ]);
      expect(ids(result.waiting)).toEqual(['c', 'b', 'a']);
    });

    it('puts questions first, then unread results, then what is merely idle', () => {
      // The idle rows are the more recent by every clock there is; the
      // question and the unread finish still come first, because an arrival
      // nobody has dealt with must not land in the tail.
      const result = bucketize([
        node(entry('read', 'ready', { activityAt: 900 })),
        node(entry('unread', 'done', { finishedAt: 100, activityAt: 100 })),
        node(entry('older', 'exited', { activityAt: 500 })),
        node(entry('asking', 'needs-attention', { since: 50, activityAt: 50 })),
      ]);
      expect(ids(result.waiting)).toEqual(['asking', 'unread', 'read', 'older']);
    });

    it('keeps what someone put away out of the top of the list, whatever its clock says', () => {
      const result = bucketize([
        node(entry('shelved', 'settled', { activityAt: 900 })),
        node(entry('idle', 'exited', { activityAt: 100 })),
      ]);
      expect(ids(result.waiting)).toEqual(['idle']);
      expect(ids(result.settled)).toEqual(['shelved']);
    });

    it('sorts a done row with no finishedAt last rather than failing', () => {
      const result = bucketize([
        node(entry('none', 'done')),
        node(entry('some', 'done', { finishedAt: 5 })),
      ]);
      expect(ids(result.waiting)).toEqual(['some', 'none']);
    });

    it.each([
      ['working', 'working'],
      ['waiting', 'ready'],
      ['settled', 'settled'],
    ] as const)('sorts %s by activityAt descending', (bucket, attention) => {
      const result = bucketize([
        node(entry('a', attention, { activityAt: 100 })),
        node(entry('c', attention, { activityAt: 300 })),
        node(entry('b', attention, { activityAt: 200 })),
      ]);
      expect(ids(result[bucket])).toEqual(['c', 'b', 'a']);
    });

    it.each([
      ['waiting', 'needs-attention'],
      ['waiting', 'done'],
      ['working', 'working'],
      ['settled', 'settled'],
    ] as const)('breaks ties in %s on key, whatever the input order', (bucket, attention) => {
      const forward = bucketize([
        node(entry('a', attention)),
        node(entry('b', attention)),
        node(entry('c', attention)),
      ]);
      const backward = bucketize([
        node(entry('c', attention)),
        node(entry('b', attention)),
        node(entry('a', attention)),
      ]);
      expect(ids(forward[bucket])).toEqual(['a', 'b', 'c']);
      expect(ids(backward[bucket])).toEqual(['a', 'b', 'c']);
    });

    it('does not mutate its input', () => {
      const roots = [
        node(entry('b', 'working', { activityAt: 1 })),
        node(entry('a', 'working', { activityAt: 2 })),
      ];
      bucketize(roots);
      expect(ids(roots)).toEqual(['b', 'a']);
    });

    it('sorts a tree by the latest activity anywhere in it', () => {
      const result = bucketize([
        node(entry('quiet', 'working', { activityAt: 150 })),
        node(
          entry('conductor', 'working', { activityAt: 100 }),
          entry('busy-child', 'working', { activityAt: 400 }),
        ),
      ]);
      expect(ids(result.working)).toEqual(['conductor', 'quiet']);
    });

    it('sorts a waiting tree by its longest-waiting member', () => {
      const result = bucketize([
        node(entry('solo', 'needs-attention', { since: 200 })),
        node(
          entry('conductor', 'working', { since: 1 }),
          entry('child', 'needs-attention', { since: 300 }),
        ),
        node(entry('early', 'needs-attention', { since: 100 })),
      ]);
      // The conductor's own `since` is irrelevant: it is not the one waiting.
      expect(ids(result.waiting)).toEqual(['early', 'solo', 'conductor']);
    });
  });

  describe('trees', () => {
    it('puts the whole tree in waiting when a child needs attention under a working parent', () => {
      const result = bucketize([node(entry('p', 'working'), entry('c', 'needs-attention'))]);
      expect(ids(result.waiting)).toEqual(['p']);
      expect(result.waiting[0].children).toHaveLength(1);
      expect(result.working).toEqual([]);
    });

    it('puts a tree at the top when a child is done and none need attention', () => {
      expect(ids(bucketize([node(entry('p', 'working'), entry('c', 'done'))]).waiting)).toEqual([
        'p',
      ]);
    });

    it('keeps a tree off the shelf while any member is still in play', () => {
      const result = bucketize([node(entry('p', 'settled'), entry('c', 'needs-attention'))]);
      expect(ids(result.waiting)).toEqual(['p']);
      expect(result.settled).toEqual([]);
    });

    it('keeps a working child from dragging a ready parent out of working', () => {
      expect(ids(bucketize([node(entry('p', 'ready'), entry('c', 'working'))]).working)).toEqual([
        'p',
      ]);
    });

    it('shelves a tree only when every member was put away', () => {
      expect(ids(bucketize([node(entry('p', 'settled'), entry('c', 'settled'))]).settled)).toEqual([
        'p',
      ]);
      expect(ids(bucketize([node(entry('p', 'settled'), entry('c', 'exited'))]).waiting)).toEqual([
        'p',
      ]);
    });

    it('places a built forest exactly once across all buckets', () => {
      const roots = buildForest([
        entry('p', 'working'),
        entry('c', 'needs-attention', { parent: keyOf('p') }),
        entry('g', 'ready', { parent: keyOf('c') }),
        entry('d', 'done'),
        entry('s', 'settled'),
        entry('o', 'ready', { parent: keyOf('missing') }),
      ]);
      const result = bucketize(roots);
      const placed = (Object.keys(result) as Bucket[]).flatMap((bucket) => ids(result[bucket]));
      expect(placed.sort()).toEqual(['d', 'o', 'p', 's']);
    });

    it('treats runs and gates, which are always needs-attention, as waiting with no special case', () => {
      const run = { ...entry('x', 'needs-attention'), key: 'run:1' as const, kind: 'run' };
      const gate = { ...entry('y', 'needs-attention'), key: 'gate:1' as const, kind: 'gate' };
      const result = bucketize([node(run), node(gate)]);
      expect(result.waiting.map((n) => n.entry.key)).toEqual(['gate:1', 'run:1']);
    });
  });
});
