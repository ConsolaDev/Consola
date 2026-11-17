import { Check } from 'lucide-react';
import type { Attention } from '../../../../shared/attention';
import { useSecondsTick } from '../../../hooks/useSecondsTick';
import { elapsedLabel } from '../../../utils/elapsedLabel';

/**
 * The three states that are *happening*, and the word each one says.
 *
 * A dot in a gutter could only ever mean "something", and at eleven rows it
 * was eleven somethings. The word is the point; the mark beside it is what
 * keeps the three apart at a glance and without relying on hue.
 *
 * `ready`, `exited` and `settled` are deliberately absent: they are not
 * happening, they are what a row has come to rest as, and the row's age says
 * that better than a label repeating the shelf it is sitting in.
 */
const LIVE: Partial<Record<Attention, string>> = {
  working: 'Working',
  // The same word a conductor's aggregate badge uses for the same state
  // (`BADGE_WORDS` in TreeRow). One word per state, everywhere it appears —
  // and "Waiting" rather than "Needs you" so a row does not spend its width
  // repeating the section header two lines above it.
  'needs-attention': 'Waiting',
  done: 'Done',
};

/** Whether a status has a word at the row's trailing edge. */
export const isLive = (status: Attention): boolean => status in LIVE;

interface RowStatusProps {
  status: Attention;
  /**
   * When the current turn started (`Entry.activityAt`, written by
   * `TurnActivity` on the edge into `working`). Only `working` counts from
   * it: the other two are a state, not a stopwatch, and their age already
   * rides beside them.
   */
  since: number;
}

/**
 * What a row is doing right now, at the trailing edge of its meta line —
 * where the age sits on every other row, so the column never breaks.
 *
 * Keyed on the status by its caller, so moving between states replays the
 * entry animation rather than swapping the text underneath the person.
 */
export function RowStatus({ status, since }: RowStatusProps) {
  const word = LIVE[status];
  const counting = status === 'working';
  // The shared tick only runs while something is counting, and a row that is
  // not working subscribes to nothing.
  const now = useSecondsTick(counting);
  if (!word) return null;

  return (
    <span className={`session-row-status session-row-status--${status}`}>
      {status === 'done' ? (
        <Check className="session-row-status-check" size={11} strokeWidth={2.75} aria-hidden="true" />
      ) : (
        <span className="session-row-status-mark" aria-hidden="true" />
      )}
      <span className="session-row-status-word">{word}</span>
      {counting && <span className="session-row-status-elapsed">{elapsedLabel(since, now)}</span>}
    </span>
  );
}
