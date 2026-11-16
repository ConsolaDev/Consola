import { attentionBridge } from '../services/attentionBridge';
import { showToast } from '../stores/toastStore';

/**
 * Settle a session (and anything beneath it) and say so, with Undo. Undo puts
 * the ledger back as it was; the row returns to its exact slot because order
 * comes from activity, which settling never touches.
 */
export async function settleWithUndo(workspaceId: string, sessionId: string, name: string): Promise<void> {
  const { settled, memento } = await attentionBridge.settle(workspaceId, sessionId);
  if (!settled) {
    // Main checked and the row did not move (something still holds it), so claim no
    // destination and offer no Undo for a move that did not happen.
    showToast(`Could not settle ${name || 'session'}: it is still in use.`);
    return;
  }
  showToast(`Settled ${name || 'session'}. It is on the Settled shelf.`, {
    label: 'Undo',
    run: () => void attentionBridge.restore(memento),
  });
}

/** Bring a settled session back to the list. Auto-settle leaves it alone until it has new activity. */
export async function unsettleWithUndo(workspaceId: string, sessionId: string, name: string): Promise<void> {
  const memento = await attentionBridge.unsettle(workspaceId, sessionId);
  showToast(`Moved ${name || 'session'} back to the list.`, {
    label: 'Undo',
    run: () => void attentionBridge.restore(memento),
  });
}
