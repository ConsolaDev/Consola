import type { RunListEntry } from '../../../shared/automations';

/** What an Inbox row says when a run on its item waits for the person at a gate, and which run its mark opens. */
export interface GateMark {
  runId: string;
  automation: string;
  step: string;
}

/**
 * By item URL, the newest run waiting at a gate on that item (slice 3: "that
 * item's row says a run is waiting for you"). A run queued behind it on the
 * same item does not hide it: the parked run is what waits for the person.
 */
export function gateMarksByItem(runs: readonly RunListEntry[]): Map<string, GateMark> {
  const newest = new Map<string, RunListEntry>();
  for (const run of runs) {
    const url = run.trigger.item?.url;
    if (!url || run.status !== 'waiting' || !run.step?.gate) continue;
    const held = newest.get(url);
    if (!held || Date.parse(run.createdAt) > Date.parse(held.createdAt)) newest.set(url, run);
  }
  const marks = new Map<string, GateMark>();
  for (const [url, run] of newest) {
    marks.set(url, { runId: run.id, automation: run.automationId, step: run.step!.id });
  }
  return marks;
}
