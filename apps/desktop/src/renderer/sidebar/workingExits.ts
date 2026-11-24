import type { Attention } from '../../shared/attention';
import type { EntryKey } from './entry';
import { aggregateAttention, membersOf } from './forest';
import type { TreeNode } from './forest';

/**
 * How long a tree that stopped on its own stays in Working. A turn often ends
 * moments before the next one starts (a queued prompt, a conductor waking),
 * and a row that leaves Working and comes straight back has moved twice for
 * nothing.
 */
export const EXIT_GRACE_MS = 2000;

/** What the list has seen trees do in Working, by root key. */
export interface WorkingObservation {
  /** Stopped, but still shown in Working for the rest of their grace. */
  lingering: ReadonlySet<EntryKey>;
  /** When each tree was last seen leaving Working. */
  returnedAt: ReadonlyMap<EntryKey, number>;
  /** When each tree in Working started the run it is in. */
  workingSince: ReadonlyMap<EntryKey, number>;
  /** When the next grace ends, so the caller can look again then; null while none is running. */
  nextDeadline: number | null;
}

/**
 * Stopping on its own: a result, or the prompt again. Anything else that ends
 * a run leaves at once — a question is the person's to answer now, an exit is
 * not about to continue, and a settle is the person's own move.
 */
const QUIET: ReadonlySet<Attention> = new Set(['done', 'ready']);

interface InWorking {
  since: number;
  /** When its grace ends, once it has stopped; null while it runs. */
  deadline: number | null;
}

export type WorkingExits = ReturnType<typeof createWorkingExits>;

/**
 * Follows trees in and out of Working across renders. Placement only: what a
 * row says it is doing stays main's answer, so a lingering row already reads
 * "Done" while it waits out its grace.
 *
 * Only what the list sees is known here. A window that opens on a session
 * already working takes the start from the ledger (the edge into working is
 * the last activity), and one that opens after a question arrived does not
 * know when it did; the ledger's times place it then.
 *
 * Observing the same trees twice changes nothing, so a render can call it
 * whenever it runs.
 */
export function createWorkingExits() {
  const inWorking = new Map<EntryKey, InWorking>();
  const returns = new Map<EntryKey, number>();
  /** The trees the last look saw; null before the first. */
  let known: ReadonlySet<EntryKey> | null = null;

  return {
    observe(roots: readonly TreeNode[], now: number): WorkingObservation {
      const present = new Set<EntryKey>();
      for (const root of roots) {
        const key = root.entry.key;
        present.add(key);
        const attention = aggregateAttention(root);
        const state = inWorking.get(key);
        if (attention === 'working') {
          // Back before its grace ran out: it never left.
          if (state) state.deadline = null;
          else
            inWorking.set(key, {
              // Seen starting now, or already running when first seen.
              since: known?.has(key)
                ? now
                : Math.max(...membersOf(root).map((entry) => entry.activityAt)),
              deadline: null,
            });
          continue;
        }
        if (!state) continue;
        const quiet = QUIET.has(attention);
        if (quiet) {
          state.deadline ??= now + EXIT_GRACE_MS;
          if (state.deadline > now) continue;
        }
        inWorking.delete(key);
        // A grace that ran out ended when it was due, however late this look is.
        returns.set(key, quiet ? state.deadline! : now);
      }
      for (const key of [...inWorking.keys()]) if (!present.has(key)) inWorking.delete(key);
      for (const key of [...returns.keys()]) if (!present.has(key)) returns.delete(key);
      known = present;

      const lingering = new Set<EntryKey>();
      const workingSince = new Map<EntryKey, number>();
      let nextDeadline: number | null = null;
      for (const [key, { since, deadline }] of inWorking) {
        workingSince.set(key, since);
        if (deadline === null) continue;
        lingering.add(key);
        nextDeadline = nextDeadline === null ? deadline : Math.min(nextDeadline, deadline);
      }
      return { lingering, returnedAt: new Map(returns), workingSince, nextDeadline };
    },
  };
}
