import type { EntryKey } from './entry';
import { visibleNodes } from './fold';
import { aggregateAttention, type TreeNode } from './forest';

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
 * never made one) and always wins. With none, a tree that needs the person or
 * has an unread result shows only its pinned children, because it is there for
 * that child; anything else shows everyone. So when the child is answered the
 * tree lands on the person's preference by itself: nothing was stored on the
 * way in, so nothing flaps on the way out.
 *
 * Read from the tree's own aggregate rather than from the bucket it was filed
 * in. The top of the list holds idle and exited trees beside the ones asking
 * or finished, so its bucket would fold a conductor whose children have
 * simply finished and been seen.
 */
export function treeView(
  node: TreeNode,
  chosen: boolean | undefined,
  activeKey: EntryKey | null,
): TreeView {
  const attention = aggregateAttention(node);
  const collapsed =
    chosen === undefined ? attention === 'needs-attention' || attention === 'done' : !chosen;
  const shown = visibleNodes(node.children, collapsed, activeKey);
  return { collapsed, shown, left: node.children.filter((child) => !shown.includes(child)) };
}
