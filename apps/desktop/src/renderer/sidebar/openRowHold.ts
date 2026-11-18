import type { Bucket } from './bucketize';
import type { EntryKey } from './entry';
import { membersOf, type TreeNode } from './forest';

type Placed = Record<Bucket, TreeNode[]>;

/**
 * Where the open entry's tree sat when it was opened.
 *
 * Remembered, never enforced: every row sits in the bucket its attention says,
 * open or not. An open row used to be kept where it was opened once it
 * stopped, so that a turn finishing under the cursor did not move the row
 * being read. That left a stopped session listed under Working, beside
 * nothing that says it is working, for as long as it stayed open — the
 * section then states something false, which costs more than a row that
 * moves when its turn ends. Leaving Working is softened where every row's
 * is: the short grace in `workingExits`, and the shift guard for a press
 * aimed at a row that moved. What is still read from here is only where the
 * row was opened from (a folded Settled shelf keeps showing a row opened
 * from it).
 */
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
