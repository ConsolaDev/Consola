import { useId } from 'react';
import {
  RUN_FINISHED_MINUTES_CHOICES,
  SETTLED_DAYS_CHOICES,
  type WorktreeCleanupRules,
} from '../../../shared/worktreeCleanup';

const daysLabel = (days: number) => (days === 0 ? 'Off' : days === 1 ? '1 day' : `${days} days`);

function minutesLabel(minutes: number | 'off'): string {
  if (minutes === 'off') return 'Off';
  if (minutes === 0) return 'Right away';
  if (minutes % 1440 === 0)
    return minutes === 1440 ? 'After 1 day' : `After ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'After 1 hour' : `After ${minutes / 60} hours`;
  return `After ${minutes} minutes`;
}

/** A value set by hand in the file still shows as itself. */
function withCurrent(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
}

/**
 * The four cleanup rules, each switched on separately. Shared by Settings
 * and the workspace's own rules, so both say the same thing the same way.
 */
export function RulesEditor({
  rules,
  onChange,
  disabled = false,
}: {
  rules: WorktreeCleanupRules;
  onChange: (next: WorktreeCleanupRules) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const run = rules.runFinished;
  return (
    <div className="worktree-rules" role="group" aria-label="Worktree cleanup rules">
      <label className="worktree-rule" htmlFor={`${id}-pr`}>
        <input
          id={`${id}-pr`}
          type="checkbox"
          checked={rules.prFinished}
          disabled={disabled}
          onChange={(event) => onChange({ ...rules, prFinished: event.target.checked })}
        />
        <span className="worktree-rule-text">
          <span className="worktree-rule-label">Its pull request is merged or closed</span>
          <span className="worktree-rule-hint">The session stays.</span>
        </span>
      </label>

      <label className="worktree-rule" htmlFor={`${id}-deleted`}>
        <input
          id={`${id}-deleted`}
          type="checkbox"
          checked={rules.sessionDeleted}
          disabled={disabled}
          onChange={(event) => onChange({ ...rules, sessionDeleted: event.target.checked })}
        />
        <span className="worktree-rule-text">
          <span className="worktree-rule-label">You delete the session</span>
          <span className="worktree-rule-hint">
            Its branch goes too, if Consola created it or its pull request is finished.
          </span>
        </span>
      </label>

      <div className="worktree-rule worktree-rule--select">
        <span className="worktree-rule-text">
          <label className="worktree-rule-label" htmlFor={`${id}-settled`}>
            It has been on the Settled shelf for
          </label>
          <span className="worktree-rule-hint">The session stays.</span>
        </span>
        <select
          id={`${id}-settled`}
          className="dialog-input worktree-rule-select"
          value={rules.settledDays}
          disabled={disabled}
          onChange={(event) => onChange({ ...rules, settledDays: Number(event.target.value) })}
        >
          {withCurrent(SETTLED_DAYS_CHOICES, rules.settledDays).map((days) => (
            <option key={days} value={days}>
              {daysLabel(days)}
            </option>
          ))}
        </select>
      </div>

      <div className="worktree-rule worktree-rule--select">
        <span className="worktree-rule-text">
          <label className="worktree-rule-label" htmlFor={`${id}-run`}>
            Its automation run ended
          </label>
          <span className="worktree-rule-hint">The session stays.</span>
        </span>
        <select
          id={`${id}-run`}
          className="dialog-input worktree-rule-select"
          value={run.enabled ? String(run.afterMinutes) : 'off'}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              ...rules,
              runFinished:
                value === 'off'
                  ? { ...run, enabled: false }
                  : { enabled: true, afterMinutes: Number(value) },
            });
          }}
        >
          <option value="off">{minutesLabel('off')}</option>
          {withCurrent(RUN_FINISHED_MINUTES_CHOICES, run.afterMinutes).map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutesLabel(minutes)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Whether `next` could remove something `previous` would not, right now: a
 * sweep rule turned on, or a threshold made shorter. Deleting a session
 * removes nothing until a session is deleted, so it never asks.
 */
export function removesMore(
  previous: WorktreeCleanupRules | null,
  next: WorktreeCleanupRules | null,
): boolean {
  if (!next) return false;
  const before = previous ?? {
    prFinished: false,
    sessionDeleted: false,
    settledDays: 0,
    runFinished: { enabled: false, afterMinutes: 0 },
  };
  if (next.prFinished && !before.prFinished) return true;
  if (next.settledDays > 0 && (before.settledDays === 0 || next.settledDays < before.settledDays)) {
    return true;
  }
  return (
    next.runFinished.enabled &&
    (!before.runFinished.enabled || next.runFinished.afterMinutes < before.runFinished.afterMinutes)
  );
}
