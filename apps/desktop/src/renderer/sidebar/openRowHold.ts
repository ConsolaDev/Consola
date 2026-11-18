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

const BUCKETS: Bucket[] = ['waiting', 'working', 'settled'];

/** The bucket and index of the tree holding `activeKey`, or null when no tree holds it. */
export function holdFor(placed: Placed, activeKey: EntryKey | null): Hold | null {
  if (activeKey === null) return null;
  for (const bucket of BUCKETS) {
    const index = placed[bucket].findIndex((root) =>
      membersOf(root).some((entry) => entry.key === activeKey),
    );
    if (index >= 0) return { rootKey: placed[bucket][index].entry.key, bucket, index };
  }
  return null;
}

/**
 * Keeps the open entry's tree in the bucket it was opened from, but only while
 * that tree has come to rest.
 *
 * A turn finishing in the row the person is reading would move it out of
 * Working and up to the top of the list, so the row they are looking at would
 * jump away from under their cursor. The hold is
 * renderer-only and lasts exactly as long as the open row does: the caller
 * drops it when the person opens something else, and the entry then lands
 * where its attention says. A tree that no longer exists (deleted, filtered
 * out) is simply not there to hold.
 *
 * A hold never outranks what a tree is *doing*. One that needs the person is
 * released at once, so it rises to the top of the list even while open — that
 * is bucketize's guarantee (a row that needs the person is never in a foldable
 * shelf) and a hold must not break it. One that is working is released for the
 * same reason read the other way round: a row starts working because the
 * person just prompted it, and pinning their own move out of Working would
 * leave the list saying a session has stopped while the row beside it counts
 * the seconds of the turn they are watching.
 *
 * Settling is the person's own move too (or the AutoSettler's, which skips
 * what a window is showing), so a hold never pins a row into or out of
 * Settled: otherwise settling the open row would leave it in place under a
 * toast saying it is on the shelf, and moving it back would leave it there.
 *
 * A tree still in Working on its grace (`lingering`) counts as working: its
 * own way out is a moment away, and putting it back first would move it twice.
 *
 * What is left is a tree that has stopped, which is the case the hold exists
 * for.
 */
export function applyHold(
  placed: Placed,
  hold: Hold | null,
  lingering?: ReadonlySet<EntryKey>,
): Placed {
  if (hold === null) return placed;
  const from = BUCKETS.find((bucket) =>
    placed[bucket].some((root) => root.entry.key === hold.rootKey),
  );
  if (from === undefined || from === hold.bucket) return placed;
  if (from === 'settled' || hold.bucket === 'settled') return placed;
  const node = placed[from].find((root) => root.entry.key === hold.rootKey)!;
  const now = aggregateAttention(node);
  if (now === 'needs-attention' || now === 'working' || lingering?.has(hold.rootKey)) return placed;
  const target = [...placed[hold.bucket]];
  target.splice(Math.min(hold.index, target.length), 0, node);
  return { ...placed, [from]: placed[from].filter((root) => root !== node), [hold.bucket]: target };
}
