import { describe, expect, it } from 'vitest';
import type { Bucket } from './bucketize';
import { departures, placementOf, travelDuration, type Placement } from './departures';
import { entry, keyOf, node } from './entryFixtures';

const at = (pairs: Record<string, Bucket>): Placement =>
  new Map(Object.entries(pairs).map(([id, bucket]) => [keyOf(id), bucket]));

describe('placementOf', () => {
  it('places each tree by its root, not its children', () => {
    const placement = placementOf({
      waiting: [node(entry('lead', 'done'), entry('child', 'done'))],
      working: [node(entry('busy', 'working'))],
      snoozed: [],
      settled: [],
    });
    expect([...placement]).toEqual([
      [keyOf('lead'), 'waiting'],
      [keyOf('busy'), 'working'],
    ]);
  });
});

describe('departures', () => {
  it('travels a row leaving the list for Working or Settled', () => {
    const moved = departures(
      at({ a: 'waiting', b: 'waiting', c: 'waiting' }),
      at({ a: 'working', b: 'settled', c: 'waiting' }),
    );
    expect(moved).toEqual([
      { key: keyOf('a'), from: 'waiting', to: 'working' },
      { key: keyOf('b'), from: 'waiting', to: 'settled' },
    ]);
  });

  it('does not travel a row coming back up to the list', () => {
    expect(
      departures(at({ a: 'working', b: 'settled' }), at({ a: 'waiting', b: 'waiting' })),
    ).toEqual([]);
  });

  it('does not travel a row moving between the two shelves', () => {
    expect(
      departures(at({ a: 'working', b: 'settled' }), at({ a: 'settled', b: 'working' })),
    ).toEqual([]);
  });

  it('does not travel a row that appeared or vanished', () => {
    expect(departures(at({ gone: 'waiting' }), at({ fresh: 'working' }))).toEqual([]);
  });
});

describe('travelDuration', () => {
  it('takes a little longer for a longer trip', () => {
    expect(travelDuration(40)).toBeLessThan(travelDuration(400));
  });

  it('stays inside what a person mid-task will wait for', () => {
    for (const distance of [0, 80, 300, 900, 4000]) {
      expect(travelDuration(distance)).toBeGreaterThanOrEqual(200);
      expect(travelDuration(distance)).toBeLessThanOrEqual(360);
    }
  });

  it('reads an upward trip the same as a downward one', () => {
    expect(travelDuration(-250)).toBe(travelDuration(250));
  });
});
