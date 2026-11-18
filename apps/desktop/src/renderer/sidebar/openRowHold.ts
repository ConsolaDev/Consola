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

/**
 * Keeps the tree of a row whose name is being edited exactly where it was
 * when the field opened, whatever the tree is doing now.
 *
 * A row that changes bucket is a new row: React mounts it afresh under the
 * other list, and the rename field, what was typed in it and its focus go
 * with the old one. The first click of a double-click opens the session, and
 * a CLI that starts working as it launches would move the row into Working
 * from under the field. This is the one place a remembered position is
 * enforced: it gives way to nothing, not even a tree that needs the person,
 * and lasts only while the field is open; the tree then goes where its
 * attention says.
 */
export function pinHold(placed: Placed, pin: Hold | null): Placed {
  if (pin === null) return placed;
  const from = BUCKETS.find((bucket) =>
    placed[bucket].some((root) => root.entry.key === pin.rootKey),
  );
  if (from === undefined) return placed;
  const node = placed[from].find((root) => root.entry.key === pin.rootKey)!;
  if (from === pin.bucket && placed[from].indexOf(node) === pin.index) return placed;
  return moveTo(placed, from, node, pin);
}

/** `placed` with `node` taken out of `from` and put back at the hold's place. */
function moveTo(placed: Placed, from: Bucket, node: TreeNode, hold: Hold): Placed {
  const rest = placed[from].filter((root) => root !== node);
  const target = [...(from === hold.bucket ? rest : placed[hold.bucket])];
  target.splice(Math.min(hold.index, target.length), 0, node);
  return { ...placed, [from]: rest, [hold.bucket]: target };
}
