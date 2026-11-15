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
    /** The revision each fired member last fired at; absent without `changed:`. */
    revs?: Record<string, string>;
    /** ISO time of that poll: anything started by hand since answers what arrived since. */
    at: string;
}

/** Whether a run on an item is open: `waiting` for a person, or `working`. */
export type OpenState = 'waiting' | 'working';

/**
 * One successful poll applied to an automation's record: the record to write
 * (before anything fires, so a crash never fires twice) and the keys to fire.
 *
 * A new record, or one whose definition changed, baselines: what passes now
 * was already waiting and counts as handled, so turning an automation on
 * never works through the backlog. A draft at baseline was not waiting yet,
 * so it fires once it becomes ready.
 *
 * An item is a candidate when it passes and either has not fired since it
 * entered the set, or carries a `rev` different from the one it fired at
 * (absent reads as ''). A candidate whose run is `working` is held, left as
 * it was; one whose run is `waiting` is absorbed, marked fired at the new
 * revision without firing; any other fires. Items that left the set are
 * forgotten, revision included.
 */
export function advanceSeen(
    previous: SeenRecord | undefined,
    definition: string,
    current: ReadonlyArray<{ key: string; passes: boolean; rev?: string; open?: OpenState }>,
    at: string
): { record: SeenRecord; fire: string[] } {
    const items = current.map((entry) => entry.key);
    const anyRev = current.some((entry) => entry.rev !== undefined);
    const revs: Record<string, string> = {};
    const record = (fired: string[]): SeenRecord => ({
        definition,
        items,
        fired,
        ...(anyRev ? { revs } : {}),
        at,
    });
    if (!previous || previous.definition !== definition) {
        const fired: string[] = [];
        for (const entry of current) {
            if (!entry.passes) continue;
            fired.push(entry.key);
            if (entry.rev !== undefined) revs[entry.key] = entry.rev;
        }
        return { record: record(fired), fire: [] };
    }
    const before = new Set(previous.items);
    const firedBefore = previous.fired ? new Set(previous.fired) : before;
    const fired: string[] = [];
    const fire: string[] = [];
    for (const { key, passes, rev, open } of current) {
        const hasFired = before.has(key) && firedBefore.has(key);
        const oldRev = previous.revs?.[key];
        const candidate = passes && (!hasFired || (rev !== undefined && rev !== (oldRev ?? '')));
        let now = hasFired;
        let nowRev = oldRev;
        if (candidate && open !== 'working') {
            now = true;
            if (rev !== undefined) nowRev = rev;
            if (open !== 'waiting') fire.push(key);
        }
        if (!now) continue;
        fired.push(key);
        if (nowRev !== undefined) revs[key] = nowRev;
    }
    return { record: record(fired), fire };
}

/**
 * A run started on this item counts as its fire: marked at `rev`, when the
 * item is in the set. Without a `rev` (none known yet) `revs[key]` is kept.
 */
export function markFired(record: SeenRecord, key: string, rev?: string): SeenRecord {
    if (!record.items.includes(key)) return { ...record };
    const fired = record.fired ?? record.items;
    const next: SeenRecord = { ...record, fired: fired.includes(key) ? [...fired] : [...fired, key] };
    if (rev !== undefined) next.revs = { ...record.revs, [key]: rev };
    return next;
}

/** Consola itself rejected the run this key fired: the item fires again under the new version. */
export function forgetFired(record: SeenRecord, key: string): SeenRecord {
    const next: SeenRecord = { ...record, fired: (record.fired ?? record.items).filter((entry) => entry !== key) };
    if (record.revs) {
        const { [key]: _forgotten, ...rest } = record.revs;
        next.revs = rest;
    }
    return next;
}
