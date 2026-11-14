/**
 * What an event automation's set held at the last successful poll, and which
 * of its members already fired.
 *
 * The set is every item in any of the automation's events' lists; the filter
 * says which of them may fire. Keeping the two apart is what makes one
 * review per PR hold: a draft toggle changes whether an item passes, never
 * whether it is in the set, so it is not a new request. An item fires again
 * only after it leaves the set and comes back.
 *
 * `definition` is a hash of the trigger, filter and bound account: when it
 * changes, the old set no longer describes the same list, and the next poll
 * baselines.
 */
export interface SeenRecord {
    definition: string;
    items: string[];
    /**
     * Members that already fired, or were waiting when the record baselined.
     * Absent on records the first build wrote, whose `items` were all
     * reviewed or baselined: every one of them counts as fired.
     */
    fired?: string[];
    /** ISO time of that poll: anything started by hand since answers what arrived since. */
    at: string;
}

/**
 * One successful poll applied to an automation's record: the record to write
 * (before anything fires, so a crash never fires twice) and the keys to fire.
 *
 * A new record, or one whose definition changed, baselines: what passes now
 * was already waiting and counts as handled, so turning an automation on
 * never works through the backlog. A draft at baseline was not waiting yet,
 * so it fires once it becomes ready.
 */
export function advanceSeen(
    previous: SeenRecord | undefined,
    definition: string,
    current: ReadonlyArray<{ key: string; passes: boolean }>,
    at: string
): { record: SeenRecord; fire: string[] } {
    const items = current.map((entry) => entry.key);
    if (!previous || previous.definition !== definition) {
        const fired = current.filter((entry) => entry.passes).map((entry) => entry.key);
        return { record: { definition, items, fired, at }, fire: [] };
    }
    const before = new Set(previous.items);
    const firedBefore = previous.fired ? new Set(previous.fired) : before;
    const fired: string[] = [];
    const fire: string[] = [];
    for (const { key, passes } of current) {
        if (before.has(key) && firedBefore.has(key)) fired.push(key);
        else if (passes) {
            fire.push(key);
            fired.push(key);
        }
    }
    return { record: { definition, items, fired, at }, fire };
}
