import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/attention';
import { bucketize } from './bucketize';
import type { Bucket } from './bucketize';
import { buildForest } from './forest';
import type { TreeNode } from './forest';
import { entry, ids, keyOf, node } from './entryFixtures';
import type { WorkingObservation } from './workingExits';

/** What the list saw in Working, by session id. */
function observation({
  lingering = [],
  returnedAt = [],
  workingSince = [],
}: {
  lingering?: string[];
  returnedAt?: Array<[string, number]>;
  workingSince?: Array<[string, number]>;
}): WorkingObservation {
  return {
    lingering: new Set(lingering.map(keyOf)),
    returnedAt: new Map(returnedAt.map(([id, at]) => [keyOf(id), at])),
    workingSince: new Map(workingSince.map(([id, at]) => [keyOf(id), at])),
    nextDeadline: null,
  };
}

// Everything in play that is not running waits at the top; Settled holds only
// what was put away. Stopping is not settling.
const EXPECTED: Record<Attention, Bucket> = {
  'needs-attention': 'waiting',
  done: 'waiting',
  ready: 'waiting',
  exited: 'waiting',
  working: 'working',
  snoozed: 'snoozed',
  settled: 'settled',
};

describe('bucketize', () => {
  it.each(Object.entries(EXPECTED) as Array<[Attention, Bucket]>)(
    'puts a %s row in %s',
    (attention, bucket) => {
      const result = bucketize([node(entry('a', attention))]);
      expect(ids(result[bucket])).toEqual(['a']);
      const others = (Object.keys(result) as Bucket[]).filter((name) => name !== bucket);
      expect(others.flatMap((name) => ids(result[name]))).toEqual([]);
    },
  );

  it('returns every bucket, empty when nothing belongs in it', () => {
    expect(bucketize([])).toEqual({ waiting: [], working: [], snoozed: [], settled: [] });
  });

  describe('the top of the list', () => {
    it('puts whatever came back most recently first, whatever it is asking', () => {
      const result = bucketize([
        node(entry('idle', 'ready', { activityAt: 400 })),
        node(entry('asking', 'needs-attention', { activityAt: 100 })),
        node(entry('unread', 'done', { activityAt: 200, finishedAt: 300 })),
        node(entry('exited', 'exited', { activityAt: 500 })),
      ]);
      expect(ids(result.waiting)).toEqual(['exited', 'idle', 'unread', 'asking']);
    });

    it('does not move a finished row when it is read', () => {
      const before = bucketize([
        node(entry('a', 'done', { activityAt: 300, finishedAt: 300 })),
        node(entry('b', 'ready', { activityAt: 200 })),
        node(entry('c', 'done', { activityAt: 100, finishedAt: 100 })),
      ]);
      const after = bucketize([
        node(entry('a', 'done', { activityAt: 300, finishedAt: 300 })),
        node(entry('b', 'ready', { activityAt: 200 })),
        node(entry('c', 'ready', { activityAt: 100, finishedAt: 100 })),
      ]);
      expect(ids(after.waiting)).toEqual(ids(before.waiting));
    });

    it('puts a session just made, or just woken from Settled, on top', () => {
      const result = bucketize([
        node(entry('busy', 'ready', { activityAt: 300 })),
        node(entry('woken', 'ready', { activityAt: 10, unsettledAt: 500 })),
        node(entry('new', 'ready', { createdAt: 400 })),
      ]);
      expect(ids(result.waiting)).toEqual(['woken', 'new', 'busy']);
    });

    it('brings a tree back at the moment the list saw it leave Working', () => {
      // A question has no time of its own in the ledger: the turn that asked
      // it started at 100, long before the other row last did anything.
      const observed = observation({ returnedAt: [['asked', 600]] });
      const result = bucketize(
        [
          node(entry('asked', 'needs-attention', { activityAt: 100 })),
          node(entry('other', 'ready', { activityAt: 500 })),
        ],
        { workingSection: true, observed },
      );
      expect(ids(result.waiting)).toEqual(['asked', 'other']);
    });

    it('sorts a tree by the latest arrival anywhere in it', () => {
      const result = bucketize([
        node(entry('solo', 'ready', { activityAt: 200 })),
        node(
          entry('conductor', 'ready', { activityAt: 100 }),
          entry('child', 'done', { activityAt: 150, finishedAt: 300 }),
        ),
      ]);
      expect(ids(result.waiting)).toEqual(['conductor', 'solo']);
    });

    it('keeps what someone put away out of the top of the list, whatever its clock says', () => {
      const result = bucketize([
        node(entry('shelved', 'settled', { activityAt: 900 })),
        node(entry('idle', 'exited', { activityAt: 100 })),
      ]);
      expect(ids(result.waiting)).toEqual(['idle']);
      expect(ids(result.settled)).toEqual(['shelved']);
    });
  });

  describe('Working', () => {
    it('sorts newest run first, as the list saw each start', () => {
      const observed = observation({
        workingSince: [
          ['a', 100],
          ['b', 300],
          ['c', 200],
        ],
      });
      const result = bucketize(
        [
          node(entry('a', 'working', { activityAt: 900 })),
          node(entry('b', 'working')),
          node(entry('c', 'working')),
        ],
        { workingSection: true, observed },
      );
      expect(ids(result.working)).toEqual(['b', 'c', 'a']);
    });

    it('falls back to the last activity for a run the list did not see start', () => {
      const result = bucketize([
        node(entry('quiet', 'working', { activityAt: 150 })),
        node(
          entry('conductor', 'working', { activityAt: 100 }),
          entry('busy-child', 'working', { activityAt: 400 }),
        ),
      ]);
      expect(ids(result.working)).toEqual(['conductor', 'quiet']);
    });

    it('keeps a tree that just stopped in Working, in its place, until its grace ends', () => {
      const observed = observation({
        lingering: ['stopped'],
        workingSince: [
          ['stopped', 200],
          ['running', 100],
        ],
      });
      const result = bucketize(
        [
          node(entry('running', 'working')),
          node(entry('stopped', 'done', { activityAt: 900, finishedAt: 900 })),
        ],
        { workingSection: true, observed },
      );
      expect(ids(result.working)).toEqual(['stopped', 'running']);
      expect(result.waiting).toEqual([]);
    });

    it('never holds a tree that asks the person, or one put away, in Working', () => {
      const observed = observation({ lingering: ['asking', 'shelved'] });
      const result = bucketize(
        [node(entry('asking', 'needs-attention')), node(entry('shelved', 'settled'))],
        { workingSection: true, observed },
      );
      expect(result.working).toEqual([]);
      expect(ids(result.waiting)).toEqual(['asking']);
      expect(ids(result.settled)).toEqual(['shelved']);
    });
  });

  describe('without a Working section', () => {
    const off = (roots: TreeNode[], observed?: WorkingObservation) =>
      bucketize(roots, { workingSection: false, observed });

    it('keeps running trees in the list', () => {
      const result = off([node(entry('a', 'working')), node(entry('b', 'ready'))]);
      expect(result.working).toEqual([]);
      expect(ids(result.waiting).sort()).toEqual(['a', 'b']);
    });

    it('moves nothing when a turn starts, finishes or asks', () => {
      const order = (attention: Attention, activityAt: number) =>
        ids(
          off([
            node(entry('old', attention, { createdAt: 100, activityAt })),
            node(entry('new', 'ready', { createdAt: 200, activityAt: 200 })),
          ]).waiting,
        );
      expect(order('working', 900)).toEqual(['new', 'old']);
      expect(order('done', 950)).toEqual(['new', 'old']);
      expect(order('needs-attention', 990)).toEqual(['new', 'old']);
    });

    it('puts a session just made, or just woken from Settled, on top', () => {
      const result = off([
        node(entry('a', 'ready', { createdAt: 300 })),
        node(entry('woken', 'ready', { createdAt: 100, unsettledAt: 500 })),
        node(entry('b', 'ready', { createdAt: 400 })),
      ]);
      expect(ids(result.waiting)).toEqual(['woken', 'b', 'a']);
    });

    it('places a tree by its conductor, not by a child it started', () => {
      const result = off([
        node(entry('solo', 'ready', { createdAt: 200 })),
        node(
          entry('conductor', 'working', { createdAt: 100 }),
          entry('child', 'working', { createdAt: 300 }),
        ),
      ]);
      expect(ids(result.waiting)).toEqual(['solo', 'conductor']);
    });

    it('ignores what the list saw in Working', () => {
      const observed = observation({ lingering: ['a'], returnedAt: [['b', 999]] });
      const result = off(
        [
          node(entry('a', 'done', { createdAt: 200 })),
          node(entry('b', 'needs-attention', { createdAt: 100 })),
        ],
        observed,
      );
      expect(result.working).toEqual([]);
      expect(ids(result.waiting)).toEqual(['a', 'b']);
    });
  });

  describe('ordering', () => {
    it('sorts settled by activityAt descending', () => {
      const result = bucketize([
        node(entry('a', 'settled', { activityAt: 100 })),
        node(entry('c', 'settled', { activityAt: 300 })),
        node(entry('b', 'settled', { activityAt: 200 })),
      ]);
      expect(ids(result.settled)).toEqual(['c', 'b', 'a']);
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
