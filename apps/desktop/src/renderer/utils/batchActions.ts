import type { BatchResult, SettleBatchResult } from '../../shared/preferences';
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
function announce(message: string, result: BatchResult): void {
  if (result.applied.length === 0 || Object.keys(result.memento).length === 0) {
    showToast(message);
    return;
  }
  showToast(message, { label: 'Undo', run: () => void attentionBridge.restore(result.memento) });
}

/**
 * What a batch settle toast says, counting apart the sessions main deleted
 * rather than shelved because they never had a message:
 * "Settled 3 sessions. 1 never had a message, so it was removed."
 */
export function settleBatchMessage(result: SettleBatchResult, asked: number): string {
  const removed = new Set(result.removed ?? []);
  if (removed.size === 0) return batchMessage(SETTLE, result, asked);
  // Everything asked for was deleted: nothing went to the shelf to speak of.
  if (result.applied.length === asked && result.applied.every((id) => removed.has(id)))
    return `Removed ${sessions(removed.size)}: ${removed.size === 1 ? 'it' : 'they'} never had a message.`;
  const removal =
    removed.size === 1
      ? '1 never had a message, so it was removed.'
      : `${removed.size} never had a message, so they were removed.`;
  return `${batchMessage(SETTLE, result, asked)} ${removal}`;
}

/** Settle every selected session in one write, with one Undo for what stayed on the shelf. */
export async function settleManyWithUndo(workspaceId: string, sessionIds: string[]): Promise<void> {
  const result = await attentionBridge.settleMany(workspaceId, sessionIds);
  announce(settleBatchMessage(result, sessionIds.length), result);
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
