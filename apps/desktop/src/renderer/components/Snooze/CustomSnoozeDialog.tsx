import { useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { type CustomSnoozeInput, describeWake, resolveCustomSnooze } from '../../../shared/snooze';
import { useMinuteTick } from '../../hooks/useMinuteTick';
import { useSnoozeDialogStore } from '../../stores/snoozeDialogStore';
import { snoozeWithUndo } from '../../utils/snoozeActions';
import '../Dialogs/styles.css';
import './styles.css';

type Mode = 'at' | 'after';
type Unit = 'minutes' | 'hours' | 'days';

const pad = (value: number) => String(value).padStart(2, '0');
/** A local date and time as the native inputs read and write them. */
const dateField = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const timeField = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** The default: two hours from now, on the minute. */
function twoHoursFrom(now: number): Date {
  const at = new Date(now + 2 * 60 * 60 * 1000);
  at.setSeconds(0, 0);
  return at;
}

/**
 * Custom…: a date and a time, or an amount of minutes, hours or days. Says
 * when the session comes back before anything is written, and refuses a time
 * that has passed, a date that does not exist, or a time the clocks skip.
 * Mounted once (beside the link dialog) and opened through its store.
 */
export function CustomSnoozeDialog() {
  const target = useSnoozeDialogStore((state) => state.target);
  if (!target) return null;
  // Keyed on the target so each opening starts from fresh defaults.
  return <CustomSnoozeForm key={target.sessionIds.join(',')} />;
}

function CustomSnoozeForm() {
  const target = useSnoozeDialogStore((state) => state.target)!;
  const close = useSnoozeDialogStore((state) => state.close);
  const now = useMinuteTick();
  const [opened] = useState(() => twoHoursFrom(Date.now()));
  const [mode, setMode] = useState<Mode>('at');
  const [date, setDate] = useState(() => dateField(opened));
  const [time, setTime] = useState(() => timeField(opened));
  const [amount, setAmount] = useState('2');
  const [unit, setUnit] = useState<Unit>('hours');
  const [submitting, setSubmitting] = useState(false);
  const id = useId();

  const input: CustomSnoozeInput =
    mode === 'at' ? { kind: 'at', date, time } : { kind: 'after', amount: Number(amount), unit };
  const result = resolveCustomSnooze(input, now);
  const count = target.sessionIds.length;
  const subject =
    count === 1 ? target.names[target.sessionIds[0]] || 'this session' : `${count} sessions`;

  const submit = async () => {
    // Resolved again at the press: a duration counts from now, not from when the dialog opened.
    const final = resolveCustomSnooze(input, Date.now());
    if (!final.ok || submitting) return;
    setSubmitting(true);
    try {
      await snoozeWithUndo(
        target.workspaceId,
        target.sessionIds,
        { until: final.until },
        target.names,
      );
      close();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content snooze-dialog">
          <Dialog.Title className="dialog-title">Snooze until…</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Choose when {subject} comes back. It keeps running while snoozed, and comes back sooner
            if it needs you.
          </Dialog.Description>
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="snooze-dialog-modes" role="radiogroup" aria-label="Snooze by">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'at'}
                className="snooze-dialog-mode"
                onClick={() => setMode('at')}
              >
                A date and time
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'after'}
                className="snooze-dialog-mode"
                onClick={() => setMode('after')}
              >
                An amount of time
              </button>
            </div>
            {mode === 'at' ? (
              <div className="snooze-dialog-row">
                <div className="dialog-field">
                  <label className="dialog-label" htmlFor={`${id}-date`}>
                    Date
                  </label>
                  <input
                    id={`${id}-date`}
                    type="date"
                    className="dialog-input"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </div>
                <div className="dialog-field">
                  <label className="dialog-label" htmlFor={`${id}-time`}>
                    Time
                  </label>
                  <input
                    id={`${id}-time`}
                    type="time"
                    className="dialog-input"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="snooze-dialog-row">
                <div className="dialog-field">
                  <label className="dialog-label" htmlFor={`${id}-amount`}>
                    In
                  </label>
                  <input
                    id={`${id}-amount`}
                    type="number"
                    min={1}
                    step={1}
                    className="dialog-input"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </div>
                <div className="dialog-field">
                  <label className="dialog-label" htmlFor={`${id}-unit`}>
                    Unit
                  </label>
                  <select
                    id={`${id}-unit`}
                    className="dialog-input"
                    value={unit}
                    onChange={(event) => setUnit(event.target.value as Unit)}
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                </div>
              </div>
            )}
            <p
              className={`snooze-dialog-preview${result.ok ? '' : ' snooze-dialog-preview--error'}`}
              role={result.ok ? undefined : 'alert'}
            >
              {result.ok ? `Comes back ${describeWake(result.until, now)}.` : result.message}
            </p>
            <div className="dialog-actions">
              <button type="button" className="dialog-button-secondary" onClick={close}>
                Cancel
              </button>
              <button
                type="submit"
                className="dialog-button-primary"
                disabled={!result.ok || submitting}
              >
                Snooze
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
