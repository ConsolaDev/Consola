import { ChevronDown, ChevronRight } from 'lucide-react';
import { worstStatus, type Attention } from '../../../../shared/attention';
import type { Bucket } from '../../../sidebar/bucketize';
import type { EntryKey } from '../../../sidebar/entry';
import type { TreeNode } from '../../../sidebar/forest';
import { entryRow } from '../../../sidebar/rowRegistry';
import { settleOffer } from '../../../sidebar/settleRules';
import { treeView } from '../../../sidebar/treeView';
import { useSettingsStore } from '../../../stores/settingsStore';

interface TreeRowProps {
  node: TreeNode;
  /** The bucket the tree sits in; it decides the view the person has not chosen. */
  bucket: Bucket;
  workspaceId: string;
  /** The entry the window is showing, whether or not an overlay covers it. */
  activeKey: EntryKey | null;
  /** The same entry only while nothing covers it: the one row Settle is not offered for. */
  viewedKey: EntryKey | null;
  /** Whether that entry is on screen now, for the active highlight. */
  highlightActive: boolean;
}

const BADGE_WORDS: Partial<Record<Attention, string>> = {
  'needs-attention': 'waiting',
  done: 'done',
  working: 'working',
};

/**
 * A conductor and its children.
 *
 * The view is derived at render and never written. With no choice of the
 * person's own, a tree in Waiting or Done shows its parent and only the
 * children that are pinned (those needing the person, finished, or open), with
 * a chip counting what is left out; in any other bucket it shows everyone. When
 * the child is answered the tree lands back on that default by itself, with
 * nothing stored to flap. Toggling the chevron stores an explicit choice per
 * conductor, which then always wins.
 */
export function TreeRow({ node, bucket, workspaceId, activeKey, viewedKey, highlightActive }: TreeRowProps) {
  const key = node.entry.key;
  const chosen = useSettingsStore((state) => state.sidebarShelfOpen[key]);
  const toggle = useSettingsStore((state) => state.toggleSidebarShelf);

  // The same fold the shelves use: pinned children stay even when collapsed.
  const { collapsed, shown, left } = treeView(node, chosen, activeKey);

  const worst = worstStatus(node.children.map((child) => child.entry.attention));
  const badgeWord = worst && BADGE_WORDS[worst];
  const worstCount = node.children.filter((child) => child.entry.attention === worst).length;
  const leftWord = left.every((child) => child.entry.attention === 'working') ? 'working' : 'more';

  const row = (child: TreeNode, isChild: boolean) =>
    entryRow(child.entry, {
      workspaceId,
      active: highlightActive && child.entry.key === activeKey,
      child: isChild,
      settle: settleOffer(child, isChild, viewedKey),
      trailing:
        isChild || !badgeWord ? undefined : (
          <span className={`tree-aggregate tree-aggregate--${worst}`} title={`${worstCount} ${badgeWord}`}>
            {worstCount} {badgeWord}
          </span>
        ),
    });

  return (
    <div className="tree-row" data-bucket={bucket}>
      <div className="tree-row-head">
        <button
          type="button"
          className="tree-row-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show all children' : 'Show only children that need you'}
          title={collapsed ? 'Show all children' : 'Show only children that need you'}
          onClick={() => toggle(key, collapsed)}
        >
          {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        </button>
        {row(node, false)}
      </div>
      {shown.length > 0 && <div className="tree-row-children">{shown.map((child) => row(child, true))}</div>}
      {left.length > 0 && (
        <button type="button" className="tree-row-more" onClick={() => toggle(key, true)}>
          +{left.length} {leftWord}
        </button>
      )}
    </div>
  );
}
