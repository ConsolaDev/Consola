/**
 * Where a tab dragged across the side panel would land, from the pointer and
 * the boxes on screen. Dropped on a tab bar it goes between two tabs; dropped
 * near an edge of a group's content it splits the group there. What is shown
 * while dragging and what the drop does are both worked out here, so the two
 * cannot disagree.
 *
 * Pure, with no DOM and no stores: the components measure, and this decides.
 */
import { canSplit, type Edge, type GroupId, type SidePanelLayout, type TabId } from './layout';

/** How deep an edge's band reaches into the area: a quarter of its width or height. */
export const EDGE_BAND = 0.25;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** What a dragged tab carries: the tab, and the group it is leaving. */
export interface DraggedTab {
  groupId: GroupId;
  tab: TabId;
}

/**
 * What a place to drop a tab says about itself. A bar measures its own tabs:
 * where a tab dropped at `x` goes among them, as `moveTab`'s index, and where
 * its caret is drawn, from the bar's left edge.
 */
export type DropZone =
  | {
      part: 'bar';
      groupId: GroupId;
      placeAt(tab: TabId, x: number): { index: number; caretLeft: number } | null;
    }
  | { part: 'content'; groupId: GroupId };

/**
 * The nearest edge whose band holds the point, or `null` in the middle and
 * outside the area. In a corner, where two bands meet, the nearer edge wins.
 */
export function edgeAt(rect: Box, point: Point): Edge | null {
  const distances: Array<[Edge, number, number]> = [
    ['top', point.y - rect.top, rect.height],
    ['bottom', rect.top + rect.height - point.y, rect.height],
    ['left', point.x - rect.left, rect.width],
    ['right', rect.left + rect.width - point.x, rect.width],
  ];
  if (distances.some(([, distance]) => distance < 0)) return null;
  let nearest: Edge | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [edge, distance, size] of distances) {
    if (distance <= size * EDGE_BAND && distance < nearestDistance) {
      nearest = edge;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Where a tab dropped at `x` goes among `tabs`, given left to right: before
 * the first tab whose middle lies right of `x`, else at the end. Give it the
 * bar's tabs without the one being dragged, and the answer is already the
 * index `moveTab` takes, which is counted after the tab has left its place.
 */
export function insertionIndex(tabs: Array<{ left: number; width: number }>, x: number): number {
  const index = tabs.findIndex((tab) => tab.left + tab.width / 2 > x);
  return index === -1 ? tabs.length : index;
}

/**
 * The edge of a group's content where a tab dropped at `point` splits that
 * group, or `null`. Only a tab of the group itself splits it, and only while
 * `canSplit` allows.
 */
export function splitEdge(
  layout: SidePanelLayout,
  groupId: GroupId,
  tab: TabId,
  rect: Box,
  point: Point,
): Edge | null {
  return canSplit(layout, groupId, tab) ? edgeAt(rect, point) : null;
}

/** Where the pointer is during a drag: where it was pressed, moved by the drag's delta. */
export function pointerAt(pressed: Event, delta: Point): Point | null {
  if (!('clientX' in pressed) || !('clientY' in pressed)) return null;
  const { clientX, clientY } = pressed as { clientX: number; clientY: number };
  return { x: clientX + delta.x, y: clientY + delta.y };
}
