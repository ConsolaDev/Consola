import { describe, expect, it } from 'vitest';
import { advanceSeen, type SeenRecord } from './seenRecord';

const at = '2026-11-05T09:00:00.000Z';
const later = '2026-11-05T09:03:00.000Z';
const passing = (...keys: string[]) => keys.map((key) => ({ key, passes: true }));

/** Advance through a sequence of polls, returning what each one fired. */
function polls(start: SeenRecord | undefined, ...sets: Array<Array<{ key: string; passes: boolean }>>) {
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
        const { record, fire } = advanceSeen(undefined, 'def', [{ key: 'a', passes: true }, { key: 'b', passes: false }], at);
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
        const { fired, record } = polls(undefined, [], [{ key: 'a', passes: false }], [{ key: 'a', passes: true }]);
        expect(fired).toEqual([[], [], ['a']]);
        expect(record.fired).toEqual(['a']);
    });

    it('an item that stops and starts passing while in the set does not fire again', () => {
        const { fired, record } = polls(
            undefined,
            [],
            passing('a'),
            [{ key: 'a', passes: false }],
            passing('a')
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
        expect(record).toEqual({ definition: 'def', items: ['a', 'b', 'c'], fired: ['a', 'b', 'c'], at: later });
    });
});
