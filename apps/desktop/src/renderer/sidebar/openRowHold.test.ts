import { describe, expect, it } from 'vitest';
import { bucketize } from './bucketize';
import { entry, forest, ids, keyOf } from './entryFixtures';
import { applyHold, holdFor } from './openRowHold';

const placedOf = (...entries: ReturnType<typeof entry>[]) => bucketize(forest(entries));

describe('the open row holds its bucket', () => {
  it('keeps the open session in Working when its turn finishes under the cursor', () => {
    const opened = placedOf(entry('a', 'working', { activityAt: 5 }), entry('b', 'working', { activityAt: 4 }));
    const hold = holdFor(opened, keyOf('a'));

    const afterTurn = placedOf(entry('a', 'done', { finishedAt: 6 }), entry('b', 'working', { activityAt: 4 }));

    expect(ids(afterTurn.settled)).toEqual(['a']);
    const held = applyHold(afterTurn, hold);
    expect(ids(held.working)).toEqual(['a', 'b']);
    expect(ids(held.settled)).toEqual([]);
  });

  it('puts it back at the position it had, not at the end', () => {
    const opened = placedOf(
      entry('a', 'working', { activityAt: 9 }), entry('b', 'working', { activityAt: 5 }), entry('c', 'working', { activityAt: 1 })
    );
    const hold = holdFor(opened, keyOf('b'));

    const held = applyHold(placedOf(
      entry('a', 'working', { activityAt: 9 }), entry('b', 'done', { finishedAt: 6 }), entry('c', 'working', { activityAt: 1 })
    ), hold);

    expect(ids(held.working)).toEqual(['a', 'b', 'c']);
  });

  it('holds the whole tree when the open session is a child', () => {
    const opened = placedOf(entry('p', 'ready'), entry('c', 'working', { parent: keyOf('p') }));
    const hold = holdFor(opened, keyOf('c'));
    expect(hold).toMatchObject({ rootKey: keyOf('p'), bucket: 'working' });

    const held = applyHold(placedOf(entry('p', 'ready'), entry('c', 'done', { parent: keyOf('p'), finishedAt: 3 })), hold);

    expect(ids(held.working)).toEqual(['p']);
  });

  it('does nothing without a hold, with nothing open, or once the tree is gone', () => {
    const placed = placedOf(entry('a', 'ready'));
    expect(applyHold(placed, null)).toBe(placed);
    expect(holdFor(placed, null)).toBeNull();
    expect(holdFor(placed, keyOf('gone'))).toBeNull();
    const hold = holdFor(placed, keyOf('a'));
    const without = placedOf(entry('z', 'ready'));
    expect(applyHold(without, hold)).toBe(without);
  });

  /** Reading a finished session makes it seen, which no longer moves it: an unread
   *  result and a read one are both a session that has stopped. */
  it('has nothing to do when a finished row is read, because Settled is where it already was', () => {
    const placed = placedOf(entry('a', 'done', { finishedAt: 5 }));
    const hold = holdFor(placed, keyOf('a'));
    expect(hold).toMatchObject({ bucket: 'settled' });
    expect(applyHold(placedOf(entry('a', 'ready')), hold)).toMatchObject({ settled: [expect.anything()] });
  });

  it('leaves a tree alone while it is still in the bucket it was held in', () => {
    const placed = placedOf(entry('a', 'done'));
    expect(applyHold(placed, holdFor(placed, keyOf('a')))).toBe(placed);
  });

  it('releases the hold when the open row starts needing the person', () => {
    const hold = holdFor(placedOf(entry('a', 'ready')), keyOf('a'));

    const asked = placedOf(entry('a', 'needs-attention', { since: 7 }));
    const held = applyHold(asked, hold);

    expect(ids(held.waiting)).toEqual(['a']);
    expect(ids(held.settled)).toEqual([]);
  });

  it('releases a tree when a child of the open conductor asks', () => {
    const hold = holdFor(placedOf(entry('p', 'ready'), entry('c', 'ready', { parent: keyOf('p') })), keyOf('p'));

    const held = applyHold(placedOf(entry('p', 'ready'), entry('c', 'needs-attention', { parent: keyOf('p') })), hold);

    expect(ids(held.waiting)).toEqual(['p']);
  });

  describe('a row the person sets working is never held out of Working', () => {
    it('releases a settled row the moment it starts working', () => {
      // Prompting the open row is the person's own move, and the row beside
      // the list is already counting the turn's seconds: holding it on the
      // shelf would have the list and the row saying different things.
      const hold = holdFor(placedOf(entry('a', 'exited'), entry('b', 'ready')), keyOf('a'));
      expect(hold).toMatchObject({ bucket: 'settled' });

      const held = applyHold(placedOf(entry('a', 'working', { activityAt: 9 }), entry('b', 'ready')), hold);

      expect(ids(held.working)).toEqual(['a']);
      expect(ids(held.settled)).toEqual(['b']);
    });

    it('releases a tree when a child of the open conductor starts working', () => {
      const hold = holdFor(placedOf(entry('p', 'ready'), entry('c', 'ready', { parent: keyOf('p') })), keyOf('p'));

      const held = applyHold(placedOf(entry('p', 'ready'), entry('c', 'working', { parent: keyOf('p') })), hold);

      expect(ids(held.working)).toEqual(['p']);
      expect(ids(held.settled)).toEqual([]);
    });

    it('releases an answered row out of Needs you', () => {
      const hold = holdFor(placedOf(entry('a', 'needs-attention', { since: 2 })), keyOf('a'));
      expect(hold).toMatchObject({ bucket: 'waiting' });

      const held = applyHold(placedOf(entry('a', 'working', { activityAt: 9 })), hold);

      expect(ids(held.working)).toEqual(['a']);
      expect(ids(held.waiting)).toEqual([]);
    });
  });

  /** Settling no longer crosses a section line — a stopped session and a shelved
   *  one are the same bucket — so the hold has nothing to pin either way. */
  it('does not move a row the person settles or restores while it is open', () => {
    const hold = holdFor(placedOf(entry('a', 'ready'), entry('b', 'ready')), keyOf('a'));
    expect(ids(applyHold(placedOf(entry('a', 'settled'), entry('b', 'ready')), hold).settled).sort()).toEqual(['a', 'b']);

    const shelved = holdFor(placedOf(entry('a', 'settled'), entry('b', 'ready')), keyOf('a'));
    expect(ids(applyHold(placedOf(entry('a', 'ready'), entry('b', 'ready')), shelved).settled).sort()).toEqual(['a', 'b']);
  });
});
