import { describe, expect, it } from 'vitest';
import { advanceSeen, forgetFired, heldRevision, markFired } from './seenRecord';
import type { OpenState, SeenRecord } from './seenRecord';

const at = '2026-11-05T09:00:00.000Z';
const later = '2026-11-05T09:03:00.000Z';
const passing = (...keys: string[]) => keys.map((key) => ({ key, passes: true }));

/** Advance through a sequence of polls, returning what each one fired. */
function polls(
  start: SeenRecord | undefined,
  ...sets: Array<Array<{ key: string; passes: boolean }>>
) {
  let record = start;
  const fired: string[][] = [];
  for (const current of sets) {
    const next = advanceSeen(record, 'def', current, at);
    fired.push(next.fire);
    record = next.record;
  }
  return { fired, record: record! };
}

describe('advanceSeen', () => {
  it('baselines a new record: nothing fires, passing items count as handled', () => {
    const { record, fire } = advanceSeen(
      undefined,
      'def',
      [
        { key: 'a', passes: true },
        { key: 'b', passes: false },
      ],
      at,
    );
    expect(fire).toEqual([]);
    expect(record).toEqual({ definition: 'def', items: ['a', 'b'], fired: ['a'], at });
  });

  it('baselines again when the definition changes', () => {
    const previous: SeenRecord = { definition: 'old', items: ['a'], fired: ['a'], at };
    const { record, fire } = advanceSeen(previous, 'def', passing('a', 'b'), later);
    expect(fire).toEqual([]);
    expect(record).toEqual({ definition: 'def', items: ['a', 'b'], fired: ['a', 'b'], at: later });
  });

  it('fires an item that enters the set and passes', () => {
    const { fired, record } = polls(undefined, passing('a'), passing('a', 'b'));
    expect(fired).toEqual([[], ['b']]);
    expect(record.fired).toEqual(['a', 'b']);
  });

  it('a draft in the set fires once, when it starts passing', () => {
    const { fired, record } = polls(
      undefined,
      [],
      [{ key: 'a', passes: false }],
      [{ key: 'a', passes: true }],
    );
    expect(fired).toEqual([[], [], ['a']]);
    expect(record.fired).toEqual(['a']);
  });

  it('an item that stops and starts passing while in the set does not fire again', () => {
    const { fired, record } = polls(
      undefined,
      [],
      passing('a'),
      [{ key: 'a', passes: false }],
      passing('a'),
    );
    expect(fired).toEqual([[], ['a'], [], []]);
    expect(record.fired).toEqual(['a']);
  });

  it('an item that leaves the set and comes back fires again', () => {
    const { fired, record } = polls(undefined, [], passing('a'), [], passing('a'));
    expect(fired).toEqual([[], ['a'], [], ['a']]);
    expect(record.fired).toEqual(['a']);
  });

  it('a record without fired treats every listed item as handled', () => {
    // Written by the first build: `items` only, every one of them already reviewed or baselined.
    const previous: SeenRecord = { definition: 'def', items: ['a', 'b'], at };
    const { record, fire } = advanceSeen(previous, 'def', passing('a', 'b', 'c'), later);
    expect(fire).toEqual(['c']);
    expect(record).toEqual({
      definition: 'def',
      items: ['a', 'b', 'c'],
      fired: ['a', 'b', 'c'],
      at: later,
    });
  });
});

type Current = Array<{ key: string; passes: boolean; rev?: string; open?: OpenState }>;
const rec = (
  items: string[],
  fired: string[] | undefined,
  revs?: Record<string, string>,
): SeenRecord => ({
  definition: 'def',
  items,
  ...(fired ? { fired } : {}),
  ...(revs ? { revs } : {}),
  at,
});

describe('advanceSeen with revisions and open runs', () => {
  const rows: Array<[string, SeenRecord | undefined, Current, SeenRecord, string[]]> = [
    [
      'baseline marks what passes, revisions included, and fires nothing',
      undefined,
      [
        { key: 'a', passes: true, rev: 'r1' },
        { key: 'b', passes: false, rev: 'r2' },
      ],
      { ...rec(['a', 'b'], ['a'], { a: 'r1' }), at: later },
      [],
    ],
    [
      'a new item fires',
      rec(['a'], ['a'], { a: 'r1' }),
      [
        { key: 'a', passes: true, rev: 'r1' },
        { key: 'b', passes: true, rev: 'r2' },
      ],
      { ...rec(['a', 'b'], ['a', 'b'], { a: 'r1', b: 'r2' }), at: later },
      ['b'],
    ],
    [
      'a changed revision fires',
      rec(['a'], ['a'], { a: 'r1' }),
      [{ key: 'a', passes: true, rev: 'r2' }],
      { ...rec(['a'], ['a'], { a: 'r2' }), at: later },
      ['a'],
    ],
    [
      'an unchanged one does not',
      rec(['a'], ['a'], { a: 'r1' }),
      [{ key: 'a', passes: true, rev: 'r1' }],
      { ...rec(['a'], ['a'], { a: 'r1' }), at: later },
      [],
    ],
    [
      "an absent revision reads as '' (so null after 'abc' fires)",
      rec(['a'], ['a'], { a: 'abc' }),
      [{ key: 'a', passes: true, rev: '' }],
      { ...rec(['a'], ['a'], { a: '' }), at: later },
      ['a'],
    ],
    [
      'an item that left and came back fires',
      rec([], [], {}),
      [{ key: 'a', passes: true, rev: 'r1' }],
      { ...rec(['a'], ['a'], { a: 'r1' }), at: later },
      ['a'],
    ],
    [
      'not-started absorbs: marked at the new revision, nothing fired',
      rec(['a'], ['a'], { a: 'r1' }),
      [{ key: 'a', passes: true, rev: 'r2', open: 'not-started' }],
      { ...rec(['a'], ['a'], { a: 'r2' }), at: later },
      [],
    ],
    [
      'working holds a changed revision at the old one',
      rec(['a'], ['a'], { a: 'r1' }),
      [{ key: 'a', passes: true, rev: 'r2', open: 'working' }],
      { ...rec(['a'], ['a'], { a: 'r1' }), at: later },
      [],
    ],
    [
      'working holds a new item unfired',
      rec(['a'], ['a'], { a: 'r1' }),
      [
        { key: 'a', passes: true, rev: 'r1' },
        { key: 'b', passes: true, rev: 'r2', open: 'working' },
      ],
      { ...rec(['a', 'b'], ['a'], { a: 'r1' }), at: later },
      [],
    ],
    [
      'a held item fires on the next call once it is clear',
      rec(['a', 'b'], ['a'], { a: 'r1' }),
      [
        { key: 'a', passes: true, rev: 'r1' },
        { key: 'b', passes: true, rev: 'r2' },
      ],
      { ...rec(['a', 'b'], ['a', 'b'], { a: 'r1', b: 'r2' }), at: later },
      ['b'],
    ],
    [
      'a definition change re-baselines',
      { ...rec(['a'], ['a'], { a: 'r1' }), definition: 'old' },
      [{ key: 'a', passes: true, rev: 'r2' }],
      { ...rec(['a'], ['a'], { a: 'r2' }), at: later },
      [],
    ],
    [
      'a record without revs reads as before',
      rec(['a', 'b'], undefined),
      passing('a', 'b', 'c'),
      { ...rec(['a', 'b', 'c'], ['a', 'b', 'c']), at: later },
      ['c'],
    ],
    [
      'a draft at baseline fires once it is ready',
      rec(['a'], []),
      passing('a'),
      { ...rec(['a'], ['a']), at: later },
      ['a'],
    ],
  ];
  it.each(rows)('%s', (_name, previous, current, record, fire) => {
    expect(advanceSeen(previous, 'def', current, later)).toEqual({ record, fire });
  });
});

describe('markFired', () => {
  it('marks an item in the set as fired at the revision', () => {
    const before = rec(['a', 'b'], ['a'], { a: 'r1' });
    const next = markFired(before, 'b', 'r2');
    expect(next).toEqual(rec(['a', 'b'], ['a', 'b'], { a: 'r1', b: 'r2' }));
    expect(before).toEqual(rec(['a', 'b'], ['a'], { a: 'r1' }));
  });

  it('with no revision known, marks it fired and keeps revs[key]', () => {
    const next = markFired(rec(['a'], [], { a: 'r1' }), 'a');
    expect(next).toEqual(rec(['a'], ['a'], { a: 'r1' }));
    expect(markFired(rec(['a'], []), 'a').revs).toBeUndefined();
  });

  it('leaves a record unchanged when the item is not in the set', () => {
    const before = rec(['a'], ['a'], { a: 'r1' });
    const next = markFired(before, 'z', 'r9');
    expect(next).toEqual(before);
    expect(next).not.toBe(before);
  });
});

describe('forgetFired', () => {
  it('removes the key from fired and revs, so the next poll fires it', () => {
    const before = rec(['a', 'b'], ['a', 'b'], { a: 'r1', b: 'r2' });
    const next = forgetFired(before, 'b');
    expect(next).toEqual(rec(['a', 'b'], ['a'], { a: 'r1' }));
    expect(before.fired).toEqual(['a', 'b']);
    expect(
      advanceSeen(
        next,
        'def',
        [
          { key: 'a', passes: true, rev: 'r1' },
          { key: 'b', passes: true, rev: 'r2' },
        ],
        later,
      ).fire,
    ).toEqual(['b']);
  });

  it('on a record without fired, every other item still counts as fired', () => {
    const next = forgetFired(rec(['a', 'b'], undefined), 'b');
    expect(advanceSeen(next, 'def', passing('a', 'b'), later).fire).toEqual(['b']);
  });
});

describe('heldRevision', () => {
  const record = (revs?: Record<string, string>): SeenRecord => ({
    items: ['k'],
    fired: ['k'],
    ...(revs ? { revs } : {}),
    at,
    definition: 'd',
  });

  it('says when a newer revision is held', () => {
    expect(heldRevision(record({ k: 'a' }), { key: 'k', rev: 'b' })).toBe(true);
    expect(heldRevision(record({ k: 'a' }), { key: 'k', rev: 'a' })).toBe(false);
    expect(heldRevision(undefined, { key: 'k' })).toBe(false);
  });

  it('holds nothing for an item with no revision, or none to compare', () => {
    // An Inbox item carries no revision (Call 12).
    expect(heldRevision(record({ k: 'a' }), { key: 'k' })).toBe(false);
    expect(heldRevision(record({ k: 'a' }), undefined)).toBe(false);
    expect(heldRevision(undefined, { key: 'k', rev: 'b' })).toBe(false);
    // An absent revision reads as '', as `advanceSeen` reads it.
    expect(heldRevision(record(), { key: 'k', rev: '' })).toBe(false);
    expect(heldRevision(record(), { key: 'k', rev: 'b' })).toBe(true);
  });

  it('holds what a working run held back, as advanceSeen leaves the record', () => {
    const { record: next } = advanceSeen(
      record({ k: 'a' }),
      'd',
      [{ key: 'k', passes: true, rev: 'b', open: 'working' }],
      later,
    );
    expect(heldRevision(next, { key: 'k', rev: 'b' })).toBe(true);
    // Once fired at it, nothing is held.
    const fired = advanceSeen(next, 'd', [{ key: 'k', passes: true, rev: 'b' }], later).record;
    expect(heldRevision(fired, { key: 'k', rev: 'b' })).toBe(false);
  });
});
