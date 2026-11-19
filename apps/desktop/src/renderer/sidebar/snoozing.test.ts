import { describe, expect, it } from 'vitest';
import { bucketize } from './bucketize';
import { departures, placementOf } from './departures';
import { entry, ids, keyOf, node } from './entryFixtures';
import { holdFor } from './openRowHold';
import { settleOffer } from './settleRules';
import { snoozeOffer } from './snoozeRules';

const placedOf = (...entries: ReturnType<typeof entry>[]) =>
  bucketize(entries.map((one) => node(one)));

describe('the Snoozed shelf', () => {
  it('holds snoozed trees, soonest back first', () => {
    const placed = bucketize([
      node(entry('late', 'snoozed', { snoozedUntil: 300 })),
      node(entry('soon', 'snoozed', { snoozedUntil: 100 })),
      node(entry('mid', 'snoozed', { snoozedUntil: 200 })),
    ]);
    expect(ids(placed.snoozed)).toEqual(['soon', 'mid', 'late']);
  });

  it('keeps a snoozed conductor on the shelf while a child it started runs', () => {
    const placed = bucketize([
      node(entry('lead', 'snoozed', { snoozedUntil: 100 }), entry('new', 'working')),
    ]);
    expect(ids(placed.snoozed)).toEqual(['lead']);
    expect(placed.working).toEqual([]);
  });

  it('a question pulls the tree off the shelf', () => {
    const placed = bucketize([
      node(entry('lead', 'snoozed', { snoozedUntil: 100 }), entry('child', 'needs-attention')),
    ]);
    expect(ids(placed.waiting)).toEqual(['lead']);
  });
});

describe('a tree back from a snooze', () => {
  it('comes back to the top of the list, as one woken from Settled does', () => {
    const placed = bucketize([
      node(entry('idle', 'ready', { activityAt: 400 })),
      node(entry('woke', 'ready', { activityAt: 10, wokeAt: 500 })),
      node(entry('done', 'done', { activityAt: 300, finishedAt: 450 })),
    ]);
    expect(ids(placed.waiting)).toEqual(['woke', 'done', 'idle']);
  });

  it('keeps its place once seen: the mark goes, the time it came back stays', () => {
    const marked = bucketize([
      node(entry('woke', 'ready', { wokeAt: 500, wakeMark: 'time' })),
      node(entry('other', 'ready', { activityAt: 400 })),
    ]);
    const seen = bucketize([
      node(entry('woke', 'ready', { wokeAt: 500 })),
      node(entry('other', 'ready', { activityAt: 400 })),
    ]);
    expect(ids(seen.waiting)).toEqual(ids(marked.waiting));
  });

  it('lands where it came back even with no Working section', () => {
    const placed = bucketize(
      [
        node(entry('old', 'ready', { createdAt: 100 })),
        node(entry('woke', 'ready', { createdAt: 10, wokeAt: 500 })),
      ],
      { workingSection: false },
    );
    expect(ids(placed.waiting)).toEqual(['woke', 'old']);
  });
});

describe('the open row', () => {
  it('is found on the Snoozed shelf, so a folded shelf keeps it in sight', () => {
    const hold = holdFor(
      placedOf(entry('a', 'snoozed', { snoozedUntil: 5 }), entry('b', 'ready')),
      keyOf('a'),
    );
    expect(hold?.bucket).toBe('snoozed');
  });
});

describe('the trip to the shelf', () => {
  it('travels from the list and from Working, and not back', () => {
    const before = placementOf(placedOf(entry('a', 'ready'), entry('b', 'working')));
    const after = placementOf(
      placedOf(
        entry('a', 'snoozed', { snoozedUntil: 5 }),
        entry('b', 'snoozed', { snoozedUntil: 5 }),
      ),
    );
    expect(departures(before, after).map((move) => [move.key, move.from, move.to])).toEqual([
      [keyOf('a'), 'waiting', 'snoozed'],
      [keyOf('b'), 'working', 'snoozed'],
    ]);
    expect(departures(after, before)).toEqual([]);
  });
});

describe('snoozeOffer', () => {
  it('offers Snooze on any root, a waiting question included', () => {
    expect(snoozeOffer(node(entry('a', 'ready')), false)).toEqual({ kind: 'snooze' });
    expect(snoozeOffer(node(entry('a', 'needs-attention')), false)).toEqual({ kind: 'snooze' });
    expect(snoozeOffer(node(entry('a', 'working')), false)).toEqual({ kind: 'snooze' });
  });

  it('offers Wake on a tree with a snoozed member, and nothing of its own on a child', () => {
    expect(snoozeOffer(node(entry('lead', 'snoozed'), entry('new', 'working')), false)).toEqual({
      kind: 'wake',
    });
    expect(snoozeOffer(node(entry('child', 'ready')), true)).toEqual({
      kind: 'blocked',
      reason: 'Snoozes with its conductor',
    });
  });

  it('lets a snoozed row be settled: one shelf at a time', () => {
    expect(settleOffer(node(entry('a', 'snoozed')), false)).toEqual({ kind: 'settle' });
  });
});
