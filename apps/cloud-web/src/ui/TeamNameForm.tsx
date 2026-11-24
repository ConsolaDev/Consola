import { useId, useState } from 'react';
import { messageForTeamProblem } from '../domain/teamMessages';
import { checkTeamName, TEAM_NAME_MAX } from '../domain/teams';
import type { TeamProblem } from '../domain/teams';

/** What a submit came to: nothing to say, a sentence, or the problems with the name. */
type Outcome = string | null | { kind: 'invalid'; problems: TeamProblem[] };

/**
 * A team's name, to make a team or rename one. The name is checked as the cell would before it
 * is sent, and whatever the cell answers is shown under the field. `onSubmit` sends it.
 */
export function TeamNameForm({
  label,
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<Outcome>;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [pending, setPending] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const checked = checkTeamName(name);
    if (!checked.ok) {
      setProblems(checked.problems.map(messageForTeamProblem));
      return;
    }
    setPending(true);
    setProblems([]);
    const outcome = await onSubmit(checked.name);
    setPending(false);
    if (outcome === null) return;
    setProblems(
      typeof outcome === 'string' ? [outcome] : outcome.problems.map(messageForTeamProblem),
    );
  }

  return (
    <form className="teams-name-form" onSubmit={(event) => void submit(event)} noValidate>
      <label className="settings-option-label" htmlFor={id}>
        {label}
      </label>
      <div className="teams-name-row">
        <input
          id={id}
          className="input teams-input"
          value={name}
          maxLength={TEAM_NAME_MAX * 2}
          autoComplete="off"
          aria-invalid={problems.length > 0}
          aria-describedby={problems.length > 0 ? `${id}-problems` : undefined}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel();
          }}
          // The form opens on the person's own click, so the field takes the keyboard.
          autoFocus
        />
        <button type="submit" className="settings-button accent" disabled={pending}>
          {submitLabel}
        </button>
        <button type="button" className="settings-button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {problems.length > 0 && (
        <p id={`${id}-problems`} className="teams-error" role="alert">
          {problems.join(' ')}
        </p>
      )}
    </form>
  );
}
