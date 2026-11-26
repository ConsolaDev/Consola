import type { Attention, AttentionRecord } from '../../shared/attention';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { HookInputs } from './hookSignals';

export interface AttentionInputs {
  terminal: TerminalStatus;
  record: AttentionRecord | undefined;
  /** Whether a focused window shows it. Not consulted here: seeing it writes `seenAt`, which is. */
  isViewedInFocusedWindow: boolean;
  /**
   * An open automation run is still using this session. Held work is never
   * settled: the run's own result is what the person has yet to see.
   */
  heldByOpenRun: boolean;
  /**
   * What the agent CLI's hooks last said, when its driver has any. Another
   * input beside the screen, never a status of its own: the screen's answer
   * stands until a hook arrives, and a hook that says the agent is waiting on
   * the person wins over a screen that shows nothing recognisable.
   */
  hook?: HookInputs;
  /** The time it is. A snooze holds only until its own time. */
  now: number;
}

/**
 * What the session's process is doing, screen and hooks combined: the status
 * every other rule starts from. Exported because the edge into (and out of) a
 * question is what wakes a snooze, and that edge must be this one.
 */
export function effectiveStatus(
  screen: TerminalStatus,
  hook: HookInputs | undefined,
): TerminalStatus {
  // An exited process is asking nothing, whatever its last hook said. One
  // awaiting its own subagents is still working: its spinner stops while it
  // waits, and only their panel repaints.
  return hook?.needsInput && screen !== 'exited'
    ? 'needs-attention'
    : hook?.awaitingAgents && screen === 'ready'
      ? 'working'
      : screen;
}

/**
 * The one place a session's attention is decided. Pure and main-only: the
 * renderer reads the result and never derives it, so two processes cannot
 * disagree about what a session is.
 */
export function deriveAttention({
  terminal: screen,
  record,
  hook,
  heldByOpenRun,
  now,
}: AttentionInputs): Attention {
  const terminal = effectiveStatus(screen, hook);
  // Parked until its time, whatever it is doing: finishing work does not bring
  // it back. A new question cannot hide here, because entering one ends the
  // snooze before anything derives. An open run suspends the snooze, as it
  // prevents settling: the run's result is the person's to see.
  if (!heldByOpenRun && record?.snoozedUntil !== undefined && record.snoozedUntil > now) {
    return 'snoozed';
  }
  const settled =
    !heldByOpenRun && record?.settledAt !== undefined && record.settledAt >= record.lastActiveAt;
  // A finish nobody has looked at. It always belongs to the current lifetime:
  // the ledger clears `finishedAt` whenever a session launches.
  const finished = record?.finishedAt;
  const unseen =
    finished !== undefined && (record?.seenAt === undefined || record.seenAt < finished);
  if (settled && (terminal === 'ready' || terminal === 'exited')) return 'settled';

  switch (terminal) {
    case 'exited':
      // A process that ended after finishing something is still a result to look at.
      return unseen ? 'done' : 'exited';
    case 'needs-attention':
      return 'needs-attention';
    case 'working':
      return 'working';
    case 'ready':
      return unseen ? 'done' : 'ready';
    default: {
      const unhandled: never = terminal;
      throw new Error(`Unhandled terminal status: ${String(unhandled)}`);
    }
  }
}
