import { beforeEach, describe, expect, it } from 'vitest';
import { createShiftGuard, MOVED_ROW_PRESS_MS, OWN_INPUT_MS } from './shiftGuard';
import type { RowBox } from './shiftGuard';

let clock = 0;
let guard: ReturnType<typeof createShiftGuard>;

/** Rows laid out top to bottom, 30px each, in this order. */
const rows = (...keys: string[]): Map<string, RowBox> =>
  new Map(keys.map((key, index) => [key, { top: index * 30, height: 30 }]));

/** A whole click on a row: press, release, click. True when any of it was dropped. */
function click(row: string | null, pointerId = 1): boolean {
  const verdicts = [
    guard.press(pointerId, row),
    guard.release(pointerId, row),
    guard.followUp(pointerId, row),
  ];
  return verdicts.includes('drop');
}

beforeEach(() => {
  clock = 10_000;
  guard = createShiftGuard(() => clock);
  guard.layout(rows('a', 'b', 'c'));
});

describe('createShiftGuard', () => {
  it('drops a click on a row the list just slid under the pointer', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    clock += 100;
    expect(click('a')).toBe(true);
  });

  it('lets the click through once the row has been still long enough', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    clock += MOVED_ROW_PRESS_MS;
    expect(click('a')).toBe(false);
  });

  it('drops a click on a row that just arrived', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    expect(click('new')).toBe(true);
  });

  it('leaves rows that did not move alone', () => {
    clock += 1_000;
    guard.layout(rows('a', 'b', 'c', 'new'));
    expect(click('a')).toBe(false);
    expect(click(null)).toBe(false);
  });

  it('ignores a nudge of less than half a row', () => {
    clock += 1_000;
    guard.layout(new Map([['a', { top: 14, height: 30 }]]));
    expect(click('a')).toBe(false);
  });

  it('lets a move the person caused through: the next row sliding up after Settle', () => {
    clock += 1_000;
    expect(click('a')).toBe(false);
    clock += OWN_INPUT_MS - 1;
    guard.layout(rows('b', 'c'));
    expect(click('b')).toBe(false);
  });

  it('counts a key as the person moving rows, but not typing into a field', () => {
    clock += 1_000;
    guard.key(false);
    guard.layout(rows('new', 'a', 'b', 'c'));
    expect(click('a')).toBe(false);

    clock += 1_000;
    guard.key(true);
    guard.layout(rows('a', 'b', 'c'));
    expect(click('a')).toBe(true);
  });

  it('lets a later move the person made clear an earlier mark', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    guard.key(false);
    guard.layout(rows('a', 'b', 'c'));
    expect(click('a')).toBe(false);
  });

  it('takes a list filling from empty as no move at all', () => {
    const fresh = createShiftGuard(() => clock);
    fresh.layout(new Map());
    clock += 1_000;
    fresh.layout(rows('a'));
    expect(fresh.press(1, 'a')).toBe('pass');
  });

  it('keeps a dropped press dropped until its own pointer lifts, whatever happens meanwhile', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    expect(guard.press(1, 'a')).toBe('drop');
    guard.key(false);
    expect(guard.press(2, null)).toBe('pass');
    clock += MOVED_ROW_PRESS_MS;
    expect(guard.release(1, 'a')).toBe('drop');
    expect(guard.followUp(1, 'a')).toBe('drop');
  });

  it('does not drop a release that lifts off the rows', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    expect(guard.press(1, 'a')).toBe('drop');
    expect(guard.release(1, null)).toBe('pass');
  });

  it('drops a follow-up with no pointer only when the last press was dropped', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    expect(guard.followUp(undefined, 'a')).toBe('pass');
    guard.press(1, 'a');
    expect(guard.followUp(undefined, 'a')).toBe('drop');
  });

  it('forgets a mark when its row goes away', () => {
    clock += 1_000;
    guard.layout(rows('new', 'a', 'b', 'c'));
    guard.layout(rows('b', 'c'));
    // Back at its old place, but a row arriving is a move of its own.
    guard.layout(rows('a', 'b', 'c'));
    clock += MOVED_ROW_PRESS_MS;
    expect(click('a')).toBe(false);
  });
});
