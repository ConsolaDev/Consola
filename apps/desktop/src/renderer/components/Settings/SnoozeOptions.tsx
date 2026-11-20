import { useEffect, useId, useState } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';
import {
  DEFAULT_SNOOZE_PRESETS,
  MAX_SNOOZE_PRESETS,
  type SnoozePresetDay,
  type SnoozePresetSetting,
  snoozePresetsEqual,
} from '../../../shared/snooze';
import { useMinuteTick } from '../../hooks/useMinuteTick';
import { preferencesBridge } from '../../services/preferencesBridge';
import { usePreferencesStore } from '../../stores/preferencesStore';
import {
  type DraftRow,
  type DurationUnit,
  durationParts,
  isDefault,
  menuOrder,
  nextCandidate,
  optionProblem,
  PRESET_DAYS,
  previewOf,
  reconcile,
  storable,
  toDraft,
  toMinutes,
} from './snoozeOptions.logic';
import './styles.css';

/**
 * Settings → Sessions → Snooze options: the choices in every window's Snooze
 * menu, and whether a usage limit snoozes a session by itself.
 *
 * Edited as a local draft and written as each row becomes whole, so typing in
 * one row never loses another and an echo of the write changes nothing on
 * screen. Rows take the menu's order (soonest first) only once focus leaves
 * the list, never under the cursor.
 */
export function SnoozeOptions() {
  const stored = usePreferencesStore((state) => state.snoozePresets);
  const atLimit = usePreferencesStore((state) => state.snoozeAtUsageLimit);
  const [draft, setDraft] = useState<DraftRow[]>(() => toDraft(stored));
  const id = useId();
  const now = useMinuteTick();

  useEffect(() => setDraft((current) => reconcile(current, stored)), [stored]);

  const write = (next: DraftRow[]) => {
    setDraft(next);
    const out = storable(next);
    if (!snoozePresetsEqual(out, stored)) void preferencesBridge.setSnoozePresets(out);
  };
  const change = (key: string, setting: SnoozePresetSetting) =>
    write(draft.map((row) => (row.key === key ? { ...row, setting } : row)));
  const remove = (key: string) => write(draft.filter((row) => row.key !== key));
  const add = () =>
    write([...draft, { key: `new-${Date.now()}`, setting: nextCandidate(storable(draft)) }]);
  const reset = () => write(toDraft(DEFAULT_SNOOZE_PRESETS));

  return (
    <>
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">Snooze options</span>
          <span className="settings-modal-option-description">
            The choices in the Snooze menu, in every window. Each is an amount of time, or a time on
            a day. Up to {MAX_SNOOZE_PRESETS}; Custom… is always there too.
          </span>
        </div>
        <ul
          className="snooze-options"
          aria-label="Snooze options"
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && event.currentTarget.contains(next)) return;
            const sorted = menuOrder(draft, Date.now());
            if (sorted.some((row, index) => row !== draft[index])) write(sorted);
          }}
        >
          {draft.map((row) => (
            <OptionRow
              key={row.key}
              row={row}
              now={now}
              onChange={(setting) => change(row.key, setting)}
              onRemove={() => remove(row.key)}
            />
          ))}
          {draft.length === 0 && (
            <li className="snooze-options-empty">The Snooze menu offers only Custom….</li>
          )}
        </ul>
        <div className="snooze-options-actions">
          <button
            type="button"
            className="dialog-button-secondary"
            onClick={add}
            disabled={draft.length >= MAX_SNOOZE_PRESETS}
            title={
              draft.length >= MAX_SNOOZE_PRESETS
                ? `The menu holds at most ${MAX_SNOOZE_PRESETS}.`
                : undefined
            }
          >
            <Plus size={14} aria-hidden="true" /> Add
          </button>
          {!isDefault(storable(draft)) && (
            <button type="button" className="dialog-button-secondary" onClick={reset}>
              <RotateCcw size={14} aria-hidden="true" /> Reset to defaults
            </button>
          )}
        </div>
      </div>
      <div className="settings-modal-option">
        <div className="settings-modal-option-info">
          <span className="settings-modal-option-label">When a session hits a usage limit</span>
          <span className="settings-modal-option-description">
            Consola asks the harness's own CLI when the limit resets, and never types anything for
            the session when it does.
          </span>
        </div>
        <label className="snooze-rule" htmlFor={`${id}-at-limit`}>
          <input
            id={`${id}-at-limit`}
            type="checkbox"
            checked={atLimit}
            onChange={(event) => void preferencesBridge.setSnoozeAtUsageLimit(event.target.checked)}
          />
          <span className="snooze-rule-text">
            <span className="snooze-rule-label">Snooze it until the limit resets</span>
            <span className="snooze-rule-hint">
              It moves to Snoozed and comes back at the reset. A snooze you chose is never replaced.
            </span>
          </span>
        </label>
      </div>
    </>
  );
}

function OptionRow({
  row,
  now,
  onChange,
  onRemove,
}: {
  row: DraftRow;
  now: number;
  onChange: (setting: SnoozePresetSetting) => void;
  onRemove: () => void;
}) {
  const { setting } = row;
  // The amount as typed, so a field emptied to retype is not snapped back.
  const initial = setting.kind === 'after' ? durationParts(setting.minutes) : undefined;
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '1');
  const [unit, setUnit] = useState<DurationUnit>(initial?.unit ?? 'hours');
  const problem = optionProblem(setting);
  const preview = previewOf(setting, now);

  const changeDuration = (nextAmount: string, nextUnit: DurationUnit) => {
    setAmount(nextAmount);
    setUnit(nextUnit);
    onChange({ kind: 'after', minutes: toMinutes(Number(nextAmount), nextUnit) });
  };

  return (
    <li className="snooze-option">
      <select
        className="dialog-input snooze-option-kind"
        aria-label="Kind of choice"
        value={setting.kind}
        onChange={(event) =>
          onChange(
            event.target.value === 'after'
              ? { kind: 'after', minutes: toMinutes(Number(amount) || 1, unit) }
              : { kind: 'at', day: 'tomorrow', time: '09:00' },
          )
        }
      >
        <option value="after">In</option>
        <option value="at">At</option>
      </select>
      {setting.kind === 'after' ? (
        <>
          <input
            type="number"
            min={1}
            step={1}
            className="dialog-input snooze-option-amount"
            aria-label="Amount"
            value={amount}
            onChange={(event) => changeDuration(event.target.value, unit)}
          />
          <select
            className="dialog-input"
            aria-label="Unit"
            value={unit}
            onChange={(event) => changeDuration(amount, event.target.value as DurationUnit)}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </>
      ) : (
        <>
          <select
            className="dialog-input"
            aria-label="Day"
            value={setting.day}
            onChange={(event) =>
              onChange({ ...setting, day: event.target.value as SnoozePresetDay })
            }
          >
            {PRESET_DAYS.map((day) => (
              <option key={day.value} value={day.value}>
                {day.label}
              </option>
            ))}
          </select>
          <input
            type="time"
            className="dialog-input"
            aria-label="Time"
            value={setting.time}
            onChange={(event) => onChange({ ...setting, time: event.target.value })}
          />
        </>
      )}
      <button
        type="button"
        className="snooze-option-remove"
        aria-label="Remove this choice"
        title="Remove"
        onClick={onRemove}
      >
        <X size={14} aria-hidden="true" />
      </button>
      <span
        className={`snooze-option-preview${problem ? ' snooze-option-preview--error' : ''}`}
        role={problem ? 'alert' : undefined}
      >
        {problem ??
          ('hidden' in preview ? preview.hidden : `Menu: ${preview.label} · ${preview.time}`)}
      </span>
    </li>
  );
}
