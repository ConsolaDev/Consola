import type { WakeCause } from '../../shared/attention';
import type { BatchResult, SnoozeBatchResult } from '../../shared/preferences';
import { describeWake, pickSnoozePreset } from '../../shared/snooze';
import type { ResolvedSnoozePreset, SnoozeWhen } from '../../shared/snooze';
import { attentionBridge } from '../services/attentionBridge';
import { showToast } from '../stores/toastStore';

/** Why a session came back, as the Woke mark's tooltip says it. */
export const WAKE_CAUSE_WORDS: Record<WakeCause, string> = {
  time: 'Its snooze ended.',
  'limit-reset': 'Its usage limit has reset.',
  question: 'It asked something.',
  failure: 'It stopped on an error.',
  limit: 'It hit a usage limit.',
  agent: 'An agent woke it.',
};

const nameOf = (names: Record<string, string>, id: string) => names[id] || 'session';
const sessions = (count: number) => `${count} session${count === 1 ? '' : 's'}`;

/** What a snooze toast says. Pure, so the copy is tested rather than read off a screen. */
export function snoozeMessage(
  result: SnoozeBatchResult,
  asked: string[],
  names: Record<string, string>,
  now: number,
): string {
  const { applied, refused } = result;
  const when = result.until === null ? 'their limits reset' : describeWake(result.until, now);
  if (applied.length === 0) {
    if (asked.length === 1) {
      const why = refused[0]?.message ?? 'It could not be snoozed.';
      return `Could not snooze ${nameOf(names, asked[0])}. ${why}`;
    }
    return `Could not snooze ${sessions(asked.length)}.`;
  }
  if (asked.length === 1) return `Snoozed ${nameOf(names, asked[0])} until ${when}.`;
  if (applied.length === asked.length) return `Snoozed ${sessions(applied.length)} until ${when}.`;
  const left = asked.length - applied.length;
  return `Snoozed ${applied.length} of ${sessions(asked.length)} until ${when}. ${left} could not be snoozed.`;
}

/** What a wake toast says. */
export function wakeMessage(
  result: BatchResult,
  asked: string[],
  names: Record<string, string>,
): string {
  const { applied } = result;
  if (applied.length === 0) {
    return asked.length === 1
      ? `${nameOf(names, asked[0])} is not snoozed.`
      : `None of those ${asked.length} sessions is snoozed.`;
  }
  if (asked.length === 1) return `Woke ${nameOf(names, asked[0])}. It is back in the list.`;
  return `Woke ${sessions(applied.length)}. They are back in the list.`;
}

/** Snooze sessions and say so, with one Undo for the whole batch. */
export async function snoozeWithUndo(
  workspaceId: string,
  sessionIds: string[],
  when: SnoozeWhen,
  names: Record<string, string>,
): Promise<void> {
  const result = await attentionBridge.snooze(workspaceId, sessionIds, when);
  const message = snoozeMessage(result, sessionIds, names, Date.now());
  if (result.applied.length === 0 || Object.keys(result.memento).length === 0) {
    showToast(message);
    return;
  }
  showToast(message, { label: 'Undo', run: () => void attentionBridge.restore(result.memento) });
}

/**
 * Snooze at a menu choice. A duration counts from the pick; a set time keeps
 * the time the menu showed, so one that has passed while the menu was open is
 * refused rather than moved to tomorrow.
 */
export async function snoozeAtPreset(
  workspaceId: string,
  sessionIds: string[],
  row: ResolvedSnoozePreset,
  names: Record<string, string>,
): Promise<void> {
  const picked = pickSnoozePreset(row, Date.now());
  if (!picked) {
    showToast('That time has passed. Pick another.');
    return;
  }
  await snoozeWithUndo(workspaceId, sessionIds, { until: picked.wakeAt }, names);
}

/** Bring snoozed sessions back now, with Undo. */
export async function wakeWithUndo(
  workspaceId: string,
  sessionIds: string[],
  names: Record<string, string>,
): Promise<void> {
  const result = await attentionBridge.wake(workspaceId, sessionIds);
  const message = wakeMessage(result, sessionIds, names);
  if (result.applied.length === 0) {
    showToast(message);
    return;
  }
  showToast(message, { label: 'Undo', run: () => void attentionBridge.restore(result.memento) });
}
