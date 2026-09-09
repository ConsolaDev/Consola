import type { DragEvent } from 'react';

/**
 * Dragging a session row onto a group header.
 *
 * A private MIME type rather than `text/plain`. The window-level drop guard
 * watches for files being dragged into the app, and a row that also announced
 * itself as plain text would be one more thing every other drop target had to
 * tell apart. `dataTransfer.types` is readable during `dragover` — where the
 * payload itself deliberately is not — so a target can decide whether it
 * wants a drag before anything has been dropped.
 *
 * Shared rather than inlined at both ends: these strings are the whole
 * contract between the row that starts the drag and the header or scope that
 * accepts it, and a typo in either would simply mean nothing is ever
 * droppable.
 */
export const SESSION_DRAG_TYPE = 'application/x-consola-session';

/** What a drag needs to know about the row it started from. */
interface DraggedSession {
  id: string;
  scopeId: string;
  groupId?: string;
}

/**
 * The type naming the scope a grouped session would return to.
 *
 * The scope id rides in the type *name* rather than the payload because the
 * name is the half a `dragover` can read: a scope row has to decide whether to
 * light up while the drag is still in the air, and "is this the session that
 * belongs to me" is not a question `getData` will answer by then.
 *
 * Lower-cased at both ends. Chromium stores custom type names that way, and a
 * mismatch here has no failure mode louder than a row that never lights up.
 */
export function homeScopeType(scopeId: string): string {
  return `${SESSION_DRAG_TYPE}-home-${scopeId}`.toLowerCase();
}

export function startSessionDrag(event: DragEvent, session: DraggedSession): void {
  event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
  // Only a grouped session names a home scope: an ungrouped row already sits
  // under that heading, and a scope that lit up for it would offer a move
  // that has already happened.
  if (session.groupId !== undefined) {
    event.dataTransfer.setData(homeScopeType(session.scopeId), '');
  }
  event.dataTransfer.effectAllowed = 'move';
}

/** Whether a drag in progress is one of our session rows. */
export function isSessionDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(SESSION_DRAG_TYPE);
}

/**
 * Whether the drag is a grouped session on its way back to *this* scope.
 *
 * The one drop a scope row accepts. A session's scope is fixed for its
 * lifetime, so every other scope stays inert rather than promising a move the
 * record refuses to make; leaving a group is not a scope change, which is why
 * the row it already belongs to is free to take it.
 */
export function isSessionFromScope(event: DragEvent, scopeId: string): boolean {
  return event.dataTransfer.types.includes(homeScopeType(scopeId));
}

/** The dragged session's id, or null when the drop carried nothing usable. */
export function droppedSessionId(event: DragEvent): string | null {
  return event.dataTransfer.getData(SESSION_DRAG_TYPE) || null;
}

/**
 * Whether a dragleave is the pointer actually leaving the target, rather than
 * crossing onto one of its own children.
 *
 * A group header holds a toggle button and an actions trigger, and moving over
 * either fires dragleave on the header itself — so without this the drop
 * highlight flickers off while the pointer is still squarely inside it.
 */
export function leftDropTarget(event: DragEvent): boolean {
  const next = event.relatedTarget;
  return !(next instanceof Node) || !event.currentTarget.contains(next);
}
