import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { checkNewFactory, newFactoryDraft } from '../domain/factories';
import type { Factory, FactoryDraft } from '../domain/factories';
import {
  FACTORIES_ACCESS_NOTE,
  FACTORIES_INTRO,
  messagesForFactoryChange,
  messagesForFactoryProblems,
  NO_TEAMS_TO_OWN,
  TEAM_HINT,
} from '../domain/factoryMessages';
import type { FactoryFormMessages } from '../domain/factoryMessages';
import type { Team } from '../domain/teams';
import type { MyWorkspace } from '../domain/workspace';
import { factoriesService } from '../services/factories';
import { SourceChoice } from './SourceChoice';
import './NewFactoryDialog.css';

/**
 * New factory, a modal dialog over the dashboard, opened from the sidebar's +: a name, the team
 * that owns it, and where its files come from. The teams offered are the ones the cell lists for
 * the person, exactly the teams it lets them make a factory for; someone it lists in no team is
 * told to ask to be added to one. Its files are stored by Consola; a GitHub repository is shown
 * as coming later, and cannot be chosen.
 *
 * Nothing is said about a field until the person first tries to create it; from then on the
 * page's own check follows their typing, and what the cell answers is shown under the field it
 * is about. A team the cell no longer lists for them reads the list again (`onStale`). Once it
 * is made, `onCreated` closes the dialog and opens the new factory.
 */
export function NewFactoryDialog({
  teams,
  workspace,
  onCreated,
  onStale,
  onClose,
}: {
  teams: Team[];
  workspace: MyWorkspace;
  onCreated: (factory: Factory) => Promise<void>;
  onStale: () => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<FactoryDraft>(() => newFactoryDraft(teams));
  const [tried, setTried] = useState(false);
  const [messages, setMessages] = useState<FactoryFormMessages>({});
  const [pending, setPending] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const teamSelect = useRef<HTMLSelectElement>(null);

  // A modal dialog, so the dashboard behind it is inert; it opens on the person's own click, so
  // the keyboard starts in it.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => element.close();
  }, []);

  function problemsOf(next: FactoryDraft): FactoryFormMessages {
    const checked = checkNewFactory(next, teams);
    return checked.ok ? {} : messagesForFactoryProblems(checked.problems);
  }

  function change(next: FactoryDraft) {
    setDraft(next);
    if (tried) setMessages(problemsOf(next));
  }

  /** Shows what is wrong, and takes the person to the first field it is about. */
  function refuse(next: FactoryFormMessages) {
    setMessages(next);
    const field = next.name ? nameInput : next.team ? teamSelect : null;
    field?.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    const checked = checkNewFactory(draft, teams);
    if (!checked.ok) {
      refuse(messagesForFactoryProblems(checked.problems));
      return;
    }
    setMessages({});
    setPending(true);
    const answer = await factoriesService.createFactory(workspace, checked.factory);
    if (answer.kind === 'changed') {
      await onCreated(answer.factory);
      return;
    }
    setPending(false);
    refuse(messagesForFactoryChange(answer, workspace));
    if (answer.kind === 'team-not-found') await onStale();
  }

  // A team the cell no longer lists for the person (the list was read again) is none chosen.
  const teamId = teams.some((team) => team.id === draft.teamId) ? draft.teamId : null;
  const described = (...ids: (string | false)[]) => ids.filter(Boolean).join(' ') || undefined;

  return (
    <dialog
      ref={dialog}
      className="factory-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        // Escape: closed by the dashboard, and never while the factory is being made.
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="factory-dialog-head">
        <h2 id={`${id}-title`} className="factory-dialog-title">
          New factory
        </h2>
        <button
          type="button"
          className="factory-dialog-close"
          aria-label="Close"
          disabled={pending}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="factory-dialog-intro">
        {FACTORIES_INTRO} {FACTORIES_ACCESS_NOTE}
      </p>

      {teams.length === 0 ? (
        <>
          <p className="factory-dialog-notice" role="alert">
            {NO_TEAMS_TO_OWN}
          </p>
          <div className="actions">
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form className="form" noValidate onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label className="label" htmlFor={`${id}-name`}>
              Name
            </label>
            <input
              ref={nameInput}
              id={`${id}-name`}
              className="input"
              value={draft.name}
              placeholder="Releases"
              autoComplete="off"
              aria-invalid={messages.name ? true : undefined}
              aria-describedby={described(!!messages.name && `${id}-name-error`)}
              disabled={pending}
              onChange={(event) => change({ ...draft, name: event.target.value })}
              // The dialog opens on the person's own click, so the field takes the keyboard.
              autoFocus
            />
            {messages.name && (
              <p id={`${id}-name-error`} className="error">
                {messages.name}
              </p>
            )}
          </div>

          <div className="field">
            <label className="label" htmlFor={`${id}-team`}>
              Team
            </label>
            <select
              ref={teamSelect}
              id={`${id}-team`}
              className="input select"
              value={teamId ?? ''}
              aria-invalid={messages.team ? true : undefined}
              aria-describedby={described(`${id}-team-hint`, !!messages.team && `${id}-team-error`)}
              disabled={pending}
              onChange={(event) => change({ ...draft, teamId: event.target.value || null })}
            >
              {teamId === null && (
                <option value="" disabled>
                  Choose a team
                </option>
              )}
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
            <p id={`${id}-team-hint`} className="hint">
              {TEAM_HINT}
            </p>
            {messages.team && (
              <p id={`${id}-team-error`} className="error">
                {messages.team}
              </p>
            )}
          </div>

          <SourceChoice chosen="stored" />

          {messages.form && (
            <p className="error" role="alert">
              {messages.form}
            </p>
          )}

          <div className="actions">
            <button type="button" className="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={pending}>
              {pending ? 'Creating…' : 'Create factory'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
