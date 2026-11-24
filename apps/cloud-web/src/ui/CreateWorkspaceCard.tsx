import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  messagesForCreateRefusal,
  messagesForWorkspaceProblems,
  REGION_HINT,
  SLUG_HINT,
} from '../domain/messages';
import type { WorkspaceFormMessages } from '../domain/messages';
import { checkNewWorkspace, NEW_DRAFT, REGIONS, withName, withSlug } from '../domain/workspace';
import type { WorkspaceDraft, WorkspaceProblem } from '../domain/workspace';
import { createWorkspace } from '../services/api';

function problemsOf(draft: WorkspaceDraft): WorkspaceProblem[] {
  const checked = checkNewWorkspace(draft);
  return checked.ok ? [] : checked.problems;
}

/**
 * The form that makes a workspace. Nothing is said about a field until the person first tries
 * to create it; from then on the page's own check follows their typing, and what the server
 * answers is shown where it belongs. Once it is made, the page loads again (`onCreated`), now
 * in the new workspace. `onCancel` is offered only to someone who has a workspace to go back to.
 */
export function CreateWorkspaceCard({
  first,
  onCreated,
  onCancel,
}: {
  first: boolean;
  onCreated: () => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<WorkspaceDraft>(NEW_DRAFT);
  const [tried, setTried] = useState(false);
  const [messages, setMessages] = useState<WorkspaceFormMessages>({});
  const [pending, setPending] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);
  const firstRegion = useRef<HTMLInputElement>(null);

  function change(next: WorkspaceDraft) {
    setDraft(next);
    if (tried) setMessages(messagesForWorkspaceProblems(problemsOf(next)));
  }

  /** Shows what is wrong, and takes the person to the first field it is about. */
  function refuse(next: WorkspaceFormMessages) {
    setMessages(next);
    const field = next.name ? nameInput : next.slug ? slugInput : next.region ? firstRegion : null;
    field?.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    const checked = checkNewWorkspace(draft);
    if (!checked.ok) {
      refuse(messagesForWorkspaceProblems(checked.problems));
      return;
    }
    setMessages({});
    setPending(true);
    const answer = await createWorkspace(checked.workspace);
    if (answer.kind === 'created' || answer.kind === 'signed-out') {
      await onCreated();
    } else {
      refuse(messagesForCreateRefusal(answer));
    }
    setPending(false);
  }

  const described = (...ids: Array<string | false>) => ids.filter(Boolean).join(' ') || undefined;

  return (
    <section className="card">
      <h1 className="heading">{first ? 'Create your first workspace' : 'Create a workspace'}</h1>
      <p className="muted">
        A workspace holds your work in Consola Cloud. Make one for a company, a team or only you.
      </p>
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
            placeholder="Acme"
            autoComplete="organization"
            aria-invalid={messages.name ? true : undefined}
            aria-describedby={described(!!messages.name && `${id}-name-error`)}
            onChange={(event) => change(withName(draft, event.target.value))}
          />
          {messages.name && (
            <p id={`${id}-name-error`} className="error">
              {messages.name}
            </p>
          )}
        </div>

        <div className="field">
          <label className="label" htmlFor={`${id}-slug`}>
            Slug
          </label>
          <input
            ref={slugInput}
            id={`${id}-slug`}
            className="input"
            value={draft.slug}
            placeholder="acme"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={messages.slug ? true : undefined}
            aria-describedby={described(`${id}-slug-hint`, !!messages.slug && `${id}-slug-error`)}
            onChange={(event) => change(withSlug(draft, event.target.value))}
          />
          <p id={`${id}-slug-hint`} className="hint">
            {SLUG_HINT}
          </p>
          {messages.slug && (
            <p id={`${id}-slug-error`} className="error">
              {messages.slug}
            </p>
          )}
        </div>

        <fieldset
          className="field regions"
          aria-describedby={described(
            `${id}-region-hint`,
            !!messages.region && `${id}-region-error`,
          )}
        >
          <legend className="label">Region</legend>
          <div className="region-options">
            {REGIONS.map((region, index) => (
              <label key={region.id} className="region-option">
                <input
                  ref={index === 0 ? firstRegion : undefined}
                  type="radio"
                  name={`${id}-region`}
                  value={region.id}
                  checked={draft.region === region.id}
                  onChange={() => change({ ...draft, region: region.id })}
                />
                <span className="region-text">
                  <span className="region-name">{region.name}</span>
                  <span className="muted">{region.place}</span>
                </span>
              </label>
            ))}
          </div>
          <p id={`${id}-region-hint`} className="hint">
            {REGION_HINT}
          </p>
          {messages.region && (
            <p id={`${id}-region-error`} className="error">
              {messages.region}
            </p>
          )}
        </fieldset>

        {messages.form && (
          <p className="error" role="alert">
            {messages.form}
          </p>
        )}

        <div className="actions">
          {onCancel && (
            <button type="button" className="button" disabled={pending} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="button primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create workspace'}
          </button>
        </div>
      </form>
    </section>
  );
}
