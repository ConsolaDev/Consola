import { AlarmClock } from 'lucide-react';
import { describeWake } from '../../../shared/snooze';
import type { Session } from '../../../shared/workspace';
import { useMinuteTick } from '../../hooks/useMinuteTick';
import { useSessionAttention, useSessionSnooze } from '../../stores/attentionStore';
import { wakeWithUndo } from '../../utils/snoozeActions';
import './styles.css';

/**
 * Says, on the open pane, that its session is snoozed and when it comes
 * back, with Wake beside it. Opening a snoozed session does not wake it: the
 * person may only be checking on it, as with a settled one.
 */
export function SnoozeChip({ workspaceId, session }: { workspaceId: string; session: Session }) {
  const attention = useSessionAttention(session.id);
  const snooze = useSessionSnooze(session.id);
  const snoozed = attention === 'snoozed' && snooze?.until !== undefined;
  const now = useMinuteTick(snoozed);
  if (!snoozed || snooze?.until === undefined) return null;
  const when = describeWake(snooze.until, now);
  return (
    <span className="snooze-chip" role="status">
      <AlarmClock size={12} aria-hidden="true" />
      <span>
        {snooze.reason === 'usage-limit' ? 'Snoozed until its limit resets' : 'Snoozed until'}{' '}
        {when}
      </span>
      <button
        type="button"
        className="snooze-chip-wake"
        onClick={() => void wakeWithUndo(workspaceId, [session.id], { [session.id]: session.name })}
      >
        Wake
      </button>
    </span>
  );
}
