import type { BatchResult } from '../../shared/preferences';
import type { Session } from '../../shared/workspace';
import { attentionBridge } from '../services/attentionBridge';
import { showToast } from '../stores/toastStore';
import { deleteSessionCompletely } from './sessionActions';

const sessions = (count: number) => `${count} session${count === 1 ? '' : 's'}`;

/** A verb as a toast uses it: "settle" and "settled". */
interface Verb {
  present: string;
  past: string;
}

const SETTLE: Verb = { present: 'settle', past: 'settled' };

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** What a batch toast says: "Settled 3 sessions." or "Settled 2 of 3 sessions. 1 could not be settled." */
export function batchMessage(verb: Verb, result: BatchResult, asked: number): string {
  const done = result.applied.length;
  if (done === 0) return `Could not ${verb.present} ${sessions(asked)}.`;
  if (done === asked) return `${capital(verb.past)} ${sessions(done)}.`;
  const left = asked - done;
  return `${capital(verb.past)} ${done} of ${sessions(asked)}. ${left} could not be ${verb.past}.`;
}

/** Toast a batch with one Undo for all of it, when anything changed. */
function announce(verb: Verb, result: BatchResult, asked: number): void {
  const message = batchMessage(verb, result, asked);
  if (result.applied.length === 0 || Object.keys(result.memento).length === 0) {
    showToast(message);
    return;
  }
  showToast(message, { label: 'Undo', run: () => void attentionBridge.restore(result.memento) });
}

/** Settle every selected session in one write, with one Undo. */
export async function settleManyWithUndo(workspaceId: string, sessionIds: string[]): Promise<void> {
  announce(SETTLE, await attentionBridge.settleMany(workspaceId, sessionIds), sessionIds.length);
}

/** Bring every selected settled session back, with one Undo. */
export async function unsettleManyWithUndo(
  workspaceId: string,
  sessionIds: string[],
): Promise<void> {
  const result = await attentionBridge.unsettleMany(workspaceId, sessionIds);
  const done = result.applied.length;
  const message =
    done === 0
      ? `None of those ${sessionIds.length} sessions is settled.`
      : `Moved ${sessions(done)} back to the list.`;
  if (done === 0) showToast(message);
  else
    showToast(message, { label: 'Undo', run: () => void attentionBridge.restore(result.memento) });
}

/**
 * Delete several sessions, after one confirmation. There is no Undo: a
 * session's record and history go, as with one. Each goes through the same
 * path a single delete does, which also forgets what this window held for it.
 */
export async function deleteManyConfirmed(workspaceId: string, picked: Session[]): Promise<void> {
  if (picked.length === 0) return;
  if (
    !window.confirm(
      `Delete ${sessions(picked.length)}? This removes them and their chat history, and cannot be undone.`,
    )
  )
    return;
  for (const session of picked) await deleteSessionCompletely(workspaceId, session);
  showToast(`Deleted ${sessions(picked.length)}.`);
}
