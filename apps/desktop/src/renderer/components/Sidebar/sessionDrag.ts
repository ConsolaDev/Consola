import type { DragEvent } from 'react';

/**
 * Dragging a session row onto a label chip.
 *
 * A private MIME type rather than `text/plain`. The window-level drop guard
 * watches for files being dragged into the app, and a row that also announced
 * itself as plain text would be one more thing every other drop target had to
 * tell apart. `dataTransfer.types` is readable during `dragover` — where the
 * payload itself deliberately is not — so a target can decide whether it
 * wants a drag before anything has been dropped.
 *
 * Shared rather than inlined at both ends: this string is the whole contract
 * between the row that starts the drag and the chip that accepts it, and a
 * typo in either would simply mean nothing is ever droppable.
 *
 * Buckets are derived from attention, so there is nothing to drag a row
 * between them, with one exception: a row dragged off the Snoozed shelf onto
 * the list wakes it (`SNOOZED_SESSION_DRAG_TYPE`).
 */
export const SESSION_DRAG_TYPE = 'application/x-consola-session';

/**
 * A row dragged off the Snoozed shelf. Dropped on the list it wakes, the one
 * move between sections a drag makes. Its own type, so the list claims only
 * this drag and a label chip keeps every other.
 */
export const SNOOZED_SESSION_DRAG_TYPE = 'application/x-consola-session-snoozed';

/**
 * Start a row's drag. `labelable` rows can be dropped on a label chip;
 * `snoozed` ones on the list, to wake. A snoozed conductor is only the latter.
 */
export function startSessionDrag(
  event: DragEvent,
  session: { id: string },
  { labelable = true, snoozed = false }: { labelable?: boolean; snoozed?: boolean } = {},
): void {
  if (labelable) event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
  if (snoozed) event.dataTransfer.setData(SNOOZED_SESSION_DRAG_TYPE, session.id);
  event.dataTransfer.effectAllowed = 'move';
}

/** Whether a drag in progress is a row off the Snoozed shelf. */
export function isSnoozedSessionDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(SNOOZED_SESSION_DRAG_TYPE);
}

/** The snoozed session dropped, or null when the drop carried none. */
export function droppedSnoozedSessionId(event: DragEvent): string | null {
  return event.dataTransfer.getData(SNOOZED_SESSION_DRAG_TYPE) || null;
}

/** Whether a drag in progress is one of our session rows. */
export function isSessionDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(SESSION_DRAG_TYPE);
}

/** The dragged session's id, or null when the drop carried nothing usable. */
export function droppedSessionId(event: DragEvent): string | null {
  return event.dataTransfer.getData(SESSION_DRAG_TYPE) || null;
}

/**
 * Whether a dragleave is the pointer actually leaving the target, rather than
 * crossing onto one of its own children.
 *
 * A label chip holds a remove icon, and moving over
 * either fires dragleave on the header itself — so without this the drop
 * highlight flickers off while the pointer is still squarely inside it.
 */
export function leftDropTarget(event: DragEvent): boolean {
  const next = event.relatedTarget;
  return !(next instanceof Node) || !event.currentTarget.contains(next);
}
