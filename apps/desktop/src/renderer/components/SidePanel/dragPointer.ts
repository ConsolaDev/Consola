import { pointerWithin } from '@dnd-kit/core';
import type { CollisionDetection } from '@dnd-kit/core';

interface Point {
  x: number;
  y: number;
}

let noted: Point | null = null;

/**
 * The side panel's collision detection: dnd-kit's `pointerWithin`, noting
 * the pointer it is handed, for `dragPointer`.
 */
export const pointerWithinNoted: CollisionDetection = (args) => {
  noted = args.pointerCoordinates;
  return pointerWithin(args);
};

/**
 * Where the pointer is during a tab's drag: the point dnd-kit last found the
 * zone under, so the caret, the drop target and the drop all go by the point
 * that chose the zone.
 *
 * Not where the press was moved by dnd-kit's `delta`. That is corrected for
 * the scroll of the boxes around the drag, which it takes from the dragged
 * tab at first and from the zone under the pointer once there is one: a tab
 * dragged out of a bar scrolled sideways would land as far off the pointer
 * as that bar was scrolled.
 */
export function dragPointer(): Point | null {
  return noted;
}
