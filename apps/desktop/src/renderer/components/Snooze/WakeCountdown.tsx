import { describeWake, snoozeWakeLabel } from '../../../shared/snooze';
import { useMinuteTick } from '../../hooks/useMinuteTick';

/**
 * How long until a snoozed row comes back (45m, 3h, 2d), in the slot its age
 * sits in elsewhere. Only the label follows the clock: the wake itself is
 * main's, and the row moves when main says so.
 */
export function WakeCountdown({ until }: { until: number }) {
  const now = useMinuteTick();
  return (
    <span
      className="session-row-age snooze-countdown"
      title={`Comes back ${describeWake(until, now)}`}
    >
      {snoozeWakeLabel(until, now)}
    </span>
  );
}
