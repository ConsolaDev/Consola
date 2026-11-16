import type { Bucket } from './bucketize';
import type { EntryKey } from './entry';
import { visibleNodes } from './fold';
import type { TreeNode } from './forest';

export interface TreeView {
  /** Whether the tree is showing only its pinned children. */
  collapsed: boolean;
  shown: TreeNode[];
  /** The children left out, which the `+N working` chip counts. */
  left: TreeNode[];
}

/**
 * What a conductor tree shows, derived and never written.
 *
 * `chosen` is the person's own toggle for this conductor (`undefined` when they
 * never made one) and always wins. With none, a tree in Waiting or Done shows
 * only its pinned children, because it is there for the child that needs the
 * person; anywhere else it shows everyone. So when the child is answered and
 * the tree moves, it lands on the person's preference by itself: nothing was
 * stored on the way in, so nothing flaps on the way out.
 */
export function treeView(node: TreeNode, bucket: Bucket, chosen: boolean | undefined, activeKey: EntryKey | null): TreeView {
  const collapsed = chosen === undefined ? bucket === 'waiting' || bucket === 'done' : !chosen;
  const shown = visibleNodes(node.children, collapsed, activeKey);
  return { collapsed, shown, left: node.children.filter((child) => !shown.includes(child)) };
}
