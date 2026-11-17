import { AUTO_SETTLE_CHOICES } from '../../../shared/preferences';
import { preferencesBridge } from '../../services/preferencesBridge';
import { usePreferencesStore } from '../../stores/preferencesStore';

const label = (days: number) => (days === 0 ? 'Off' : days === 1 ? 'After 1 day' : `After ${days} days`);

/**
 * The one control for how long a session sits idle before it settles. Shared
 * by Settings and the first-run explanation, so what the person is told they
 * can change is the same thing they find later.
 */
export function AutoSettleControl({ id }: { id?: string }) {
  const days = usePreferencesStore((state) => state.autoSettleDays);
  // A threshold set by hand in the file still shows as itself.
  const choices = AUTO_SETTLE_CHOICES.some((choice) => choice === days)
    ? [...AUTO_SETTLE_CHOICES]
    : [...AUTO_SETTLE_CHOICES, days].sort((a, b) => a - b);
  return (
    <select
      id={id}
      className="dialog-input auto-settle-select"
      value={days}
      onChange={(event) => void preferencesBridge.setAutoSettleDays(Number(event.target.value))}
    >
      {choices.map((choice) => (
        <option key={choice} value={choice}>{label(choice)}</option>
      ))}
    </select>
  );
}
