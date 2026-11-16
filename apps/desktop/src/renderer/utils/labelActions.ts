import type { DragEvent } from 'react';
import type { Label } from '../../shared/workspace';
import { droppedSessionId } from '../components/Sidebar/sessionDrag';
import { workspaceBridge } from '../services/workspaceBridge';
import { useSessionFilterStore } from '../stores/sessionFilterStore';
import { showToast } from '../stores/toastStore';

/**
 * The label gestures the filter bar offers, apart from the component that
 * draws them — so they can be exercised against the real workspace service
 * rather than described by a mock.
 *
 * Deleting is the one of them that destroys something a person authored: it
 * takes the label off every session carrying it, in one commit, from a menu
 * whose every other × means "stop filtering by this". So it is the one that
 * comes back, the same way settling does — a toast with Undo rather than a
 * dialog in the way, since the groups labels replaced were archived and never
 * deleted.
 */
export async function deleteLabelWithUndo(workspaceId: string, label: Label): Promise<void> {
  const removed = await workspaceBridge.deleteLabel(workspaceId, label.id);
  // Another window got there first: the label is gone, which is what was
  // asked for, and there is nothing left to put back.
  if (!removed) return;
  showToast(`Deleted label ${label.name}.`, {
    label: 'Undo',
    // The chip comes back with it: a selection naming a missing label is
    // dropped on read, not erased, so restoring the label restores the filter.
    run: () => void workspaceBridge.restoreLabel(workspaceId, removed),
  });
}

/** Make a label from the bar's field and narrow the list to it at once. Null for an empty name. */
export async function createAndSelectLabel(workspaceId: string, name: string): Promise<Label | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const label = await workspaceBridge.createLabel(workspaceId, { name: trimmed });
  useSessionFilterStore.getState().toggle(workspaceId, 'label', label.id);
  return label;
}

/**
 * A session row dropped on a label chip: give it that label. Buckets are
 * derived from attention, so a label is the one thing a drop can assign.
 */
export async function dropSessionOnLabel(workspaceId: string, event: DragEvent, labelId: string): Promise<void> {
  // Without it the browser refuses the drop outright.
  event.preventDefault();
  const sessionId = droppedSessionId(event);
  if (!sessionId) return;
  await workspaceBridge.assignLabel(workspaceId, sessionId, labelId);
}
