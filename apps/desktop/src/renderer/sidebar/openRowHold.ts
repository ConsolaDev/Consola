import type { Bucket } from './bucketize';
import type { EntryKey } from './entry';
import { aggregateAttention, membersOf, type TreeNode } from './forest';

type Placed = Record<Bucket, TreeNode[]>;

/** Where the open entry's tree sat when it was opened. */
export interface Hold {
  rootKey: EntryKey;
  bucket: Bucket;
  index: number;
}

const BUCKETS: Bucket[] = ['waiting', 'done', 'working', 'recent', 'settled'];

/** The bucket and index of the tree holding `activeKey`, or null when no tree holds it. */
export function holdFor(placed: Placed, activeKey: EntryKey | null): Hold | null {
  if (activeKey === null) return null;
  for (const bucket of BUCKETS) {
    const index = placed[bucket].findIndex((root) => membersOf(root).some((entry) => entry.key === activeKey));
    if (index >= 0) return { rootKey: placed[bucket][index].entry.key, bucket, index };
  }
  return null;
}

/**
 * Keeps the open entry's tree in the bucket it was opened from.
 *
 * Reading a finished session makes it seen, which would move it from Done to
 * Recent under the cursor. This is renderer-only and lasts exactly as long as
 * the hold does: the caller drops it when the person opens something else, and
 * the entry then lands where its attention says. A tree that no longer exists
 * (deleted, filtered out) is simply not there to hold.
 *
 * The hold never outranks a question: a tree whose aggregate needs the person
 * is released at once, so it appears under Needs you even while open. That is
 * bucketize's guarantee (a row that needs the person is never in a foldable
 * shelf) and a hold must not break it.
 */
export function applyHold(placed: Placed, hold: Hold | null): Placed {
  if (hold === null) return placed;
  const from = BUCKETS.find((bucket) => placed[bucket].some((root) => root.entry.key === hold.rootKey));
  if (from === undefined || from === hold.bucket) return placed;
  const node = placed[from].find((root) => root.entry.key === hold.rootKey)!;
  if (aggregateAttention(node) === 'needs-attention') return placed;
  const target = [...placed[hold.bucket]];
  target.splice(Math.min(hold.index, target.length), 0, node);
  return { ...placed, [from]: placed[from].filter((root) => root !== node), [hold.bucket]: target };
}
