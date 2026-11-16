import { describe, expect, it } from 'vitest';
import { bucketize } from './bucketize';
import { entry, forest, ids, keyOf } from './entryFixtures';
import { applyHold, holdFor } from './openRowHold';

const placedOf = (...entries: ReturnType<typeof entry>[]) => bucketize(forest(entries));

describe('the open row holds its bucket', () => {
  it('keeps a finished session in Done after reading it makes it ready', () => {
    const opened = placedOf(entry('a', 'done', { finishedAt: 5 }), entry('b', 'done', { finishedAt: 4 }));
    const hold = holdFor(opened, keyOf('a'));

    const afterRead = placedOf(entry('a', 'ready'), entry('b', 'done', { finishedAt: 4 }));

    expect(ids(afterRead.recent)).toEqual(['a']);
    const held = applyHold(afterRead, hold);
    expect(ids(held.done)).toEqual(['a', 'b']);
    expect(ids(held.recent)).toEqual([]);
  });

  it('puts it back at the position it had, not at the end', () => {
    const opened = placedOf(entry('a', 'done', { finishedAt: 9 }), entry('b', 'done', { finishedAt: 5 }), entry('c', 'done', { finishedAt: 1 }));
    const hold = holdFor(opened, keyOf('b'));

    const held = applyHold(placedOf(entry('a', 'done', { finishedAt: 9 }), entry('b', 'ready'), entry('c', 'done', { finishedAt: 1 })), hold);

    expect(ids(held.done)).toEqual(['a', 'b', 'c']);
  });

  it('holds the whole tree when the open session is a child', () => {
    const opened = placedOf(entry('p', 'ready'), entry('c', 'done', { parent: keyOf('p'), finishedAt: 3 }));
    const hold = holdFor(opened, keyOf('c'));
    expect(hold).toMatchObject({ rootKey: keyOf('p'), bucket: 'done' });

    const held = applyHold(placedOf(entry('p', 'ready'), entry('c', 'ready', { parent: keyOf('p') })), hold);

    expect(ids(held.done)).toEqual(['p']);
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

  it('leaves a tree alone while it is still in the bucket it was held in', () => {
    const placed = placedOf(entry('a', 'done'));
    expect(applyHold(placed, holdFor(placed, keyOf('a')))).toBe(placed);
  });

  it('releases the hold when the open row starts needing the person', () => {
    const hold = holdFor(placedOf(entry('a', 'ready')), keyOf('a'));

    const asked = placedOf(entry('a', 'needs-attention', { since: 7 }));
    const held = applyHold(asked, hold);

    expect(ids(held.waiting)).toEqual(['a']);
    expect(ids(held.recent)).toEqual([]);
  });

  it('releases a tree when a child of the open conductor asks', () => {
    const hold = holdFor(placedOf(entry('p', 'ready'), entry('c', 'ready', { parent: keyOf('p') })), keyOf('p'));

    const held = applyHold(placedOf(entry('p', 'ready'), entry('c', 'needs-attention', { parent: keyOf('p') })), hold);

    expect(ids(held.waiting)).toEqual(['p']);
  });

  describe('settling is a deliberate move, never one under the cursor', () => {
    it('lets the open row leave its bucket when the person settles it', () => {
      const hold = holdFor(placedOf(entry('a', 'ready'), entry('b', 'ready')), keyOf('a'));
      const afterSettle = applyHold(placedOf(entry('a', 'settled'), entry('b', 'ready')), hold);
      expect(ids(afterSettle.settled)).toEqual(['a']);
      expect(ids(afterSettle.recent)).toEqual(['b']);
    });

    it('lets the open row leave the shelf when the person moves it back', () => {
      const hold = holdFor(placedOf(entry('a', 'settled'), entry('b', 'ready')), keyOf('a'));
      const afterRestore = applyHold(placedOf(entry('a', 'ready'), entry('b', 'ready')), hold);
      expect(ids(afterRestore.settled)).toEqual([]);
      expect(ids(afterRestore.recent).sort()).toEqual(['a', 'b']);
    });
  });
});
