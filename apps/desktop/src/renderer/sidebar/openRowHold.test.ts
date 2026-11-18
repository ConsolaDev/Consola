import { describe, expect, it } from 'vitest';
import { bucketize } from './bucketize';
import { entry, forest, ids, keyOf } from './entryFixtures';
import { holdFor } from './openRowHold';

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
