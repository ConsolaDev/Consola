import { describe, expect, it } from 'vitest';
import { bucketize } from './bucketize';
import { entry, forest, ids, keyOf } from './entryFixtures';
import { holdFor, pinHold } from './openRowHold';

const placedOf = (...entries: ReturnType<typeof entry>[]) => bucketize(forest(entries));

describe('where the open row was opened from', () => {
  it('names the bucket and position of the tree holding the open entry', () => {
    const placed = placedOf(
      entry('a', 'working', { activityAt: 9 }),
      entry('b', 'working', { activityAt: 5 }),
      entry('c', 'ready'),
    );
    expect(holdFor(placed, keyOf('b'))).toEqual({
      rootKey: keyOf('b'),
      bucket: 'working',
      index: 1,
    });
    expect(holdFor(placed, keyOf('c'))).toMatchObject({ bucket: 'waiting', index: 0 });
  });

  it('names the root when the open session is a child', () => {
    const placed = placedOf(entry('p', 'ready'), entry('c', 'working', { parent: keyOf('p') }));
    expect(holdFor(placed, keyOf('c'))).toMatchObject({ rootKey: keyOf('p'), bucket: 'working' });
  });

  it('is null with nothing open, or once the tree is gone', () => {
    const placed = placedOf(entry('a', 'ready'));
    expect(holdFor(placed, null)).toBeNull();
    expect(holdFor(placed, keyOf('gone'))).toBeNull();
  });
});

/** The screenshot that removed the hold: a session that had answered, sitting
 *  under Working with nothing running, because it was the open row. */
describe('an open row sits where its attention says', () => {
  it('leaves Working when its turn finishes, open or not', () => {
    const afterTurn = placedOf(
      entry('a', 'ready', { activityAt: 6 }),
      entry('b', 'working', { activityAt: 4 }),
    );
    expect(ids(afterTurn.working)).toEqual(['b']);
    expect(ids(afterTurn.waiting)).toEqual(['a']);
  });
});

/** A row whose name is being edited would lose its field by changing bucket:
 *  React mounts it afresh under the other list. */
describe('a row being renamed stays where it was', () => {
  it('keeps a row that starts working among the stopped rows while its field is open', () => {
    // The first click of a double-click opened it, and its CLI started working on launch.
    const pin = holdFor(placedOf(entry('a', 'ready'), entry('b', 'ready')), keyOf('a'));
    expect(pin).toMatchObject({ bucket: 'waiting', index: 0 });

    const working = placedOf(entry('a', 'working', { activityAt: 9 }), entry('b', 'ready'));
    expect(ids(working.working)).toEqual(['a']);
    const pinned = pinHold(working, pin);

    expect(ids(pinned.waiting)).toEqual(['a', 'b']);
    expect(pinned.working).toEqual([]);
  });

  it('keeps a row that starts needing the person in its shelf', () => {
    const pin = holdFor(
      placedOf(entry('a', 'working', { activityAt: 9 }), entry('b', 'working', { activityAt: 5 })),
      keyOf('a'),
    );

    const pinned = pinHold(
      placedOf(
        entry('a', 'needs-attention', { activityAt: 10 }),
        entry('b', 'working', { activityAt: 5 }),
      ),
      pin,
    );

    expect(ids(pinned.working)).toEqual(['a', 'b']);
    expect(pinned.waiting).toEqual([]);
  });

  it('keeps its place among its neighbours, not only its bucket', () => {
    const pin = holdFor(
      placedOf(
        entry('a', 'ready', { activityAt: 9 }),
        entry('b', 'ready', { activityAt: 5 }),
        entry('c', 'ready', { activityAt: 1 }),
      ),
      keyOf('c'),
    );

    // Finishing a turn would lift it to the top of the list.
    const finished = placedOf(
      entry('a', 'ready', { activityAt: 9 }),
      entry('b', 'ready', { activityAt: 5 }),
      entry('c', 'done', { finishedAt: 12 }),
    );
    expect(ids(finished.waiting)).toEqual(['c', 'a', 'b']);

    expect(ids(pinHold(finished, pin).waiting)).toEqual(['a', 'b', 'c']);
  });

  it('pins the whole tree when the row is a child', () => {
    const pin = holdFor(
      placedOf(entry('p', 'ready'), entry('c', 'ready', { parent: keyOf('p') })),
      keyOf('c'),
    );

    const pinned = pinHold(
      placedOf(entry('p', 'ready'), entry('c', 'working', { parent: keyOf('p') })),
      pin,
    );

    expect(ids(pinned.waiting)).toEqual(['p']);
    expect(pinned.working).toEqual([]);
  });

  it('does nothing without a pin, once the tree is gone, or while it is already in place', () => {
    const placed = placedOf(entry('a', 'ready'), entry('b', 'ready'));
    expect(pinHold(placed, null)).toBe(placed);
    const pin = holdFor(placed, keyOf('a'));
    expect(pinHold(placed, pin)).toBe(placed);
    const without = placedOf(entry('z', 'ready'));
    expect(pinHold(without, pin)).toBe(without);
  });
});
