import type { Bucket } from './bucketize';
import type { EntryKey } from './entry';
import type { TreeNode } from './forest';

/** The bucket each tree sits in, by its root's key: what the sidebar drew. */
export type Placement = ReadonlyMap<EntryKey, Bucket>;

/** A tree that left the top of the list, and the section it went to. */
export interface Departure {
  key: EntryKey;
  from: Bucket;
  to: Bucket;
}

/**
 * The moves that travel: a row leaving the top of the list because the person
 * set it going (Working) or put it away (Snoozed, Settled). Each is the person's own
 * move, or the AutoSettler's on their behalf, and the row goes somewhere the
 * eye has to follow: down the sidebar, into the dock.
 *
 * The way back up is not here. A turn finishing already arrives at the top of
 * the list, where the person is looking, with the list's own arrival.
 */
const TRAVELS: Partial<Record<Bucket, readonly Bucket[]>> = {
  waiting: ['working', 'snoozed', 'settled'],
  working: ['snoozed'],
};

export function placementOf(placed: Record<Bucket, TreeNode[]>): Placement {
  const placement = new Map<EntryKey, Bucket>();
  for (const bucket of Object.keys(placed) as Bucket[]) {
    for (const root of placed[bucket]) placement.set(root.entry.key, bucket);
  }
  return placement;
}

/**
 * The trees that moved between two renders in a direction that travels. A tree
 * that appeared or vanished (started, deleted, filtered, another workspace)
 * did not move, so it is not here.
 */
export function departures(before: Placement, after: Placement): Departure[] {
  const moved: Departure[] = [];
  for (const [key, to] of after) {
    const from = before.get(key);
    if (from !== undefined && from !== to && TRAVELS[from]?.includes(to)) {
      moved.push({ key, from, to });
    }
  }
  return moved;
}

/**
 * How long a row takes to cross `distance` pixels. Longer trips take a little
 * longer so the speed stays calm, but never past the point a person in the
 * middle of a task would be waiting on it.
 */
export function travelDuration(distance: number): number {
  return Math.round(220 + Math.min(Math.abs(distance), 600) * 0.2);
}
