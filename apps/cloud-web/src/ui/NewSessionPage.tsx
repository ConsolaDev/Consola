import { type FormEvent, useEffect, useId, useState } from 'react';
import { type CellRefusal, messageForCellRefusal } from '../domain/cell';
import type { CloudSessionOptions, Harness } from '../domain/cloudSession';
import {
  HARNESS_NAMES,
  messageForStartAnswer,
  NO_RUNNER_WORDS,
  NOTHING_OFFERED_WORDS,
  START_NOTE,
} from '../domain/cloudSessionMessages';
import { hashOfSession, hashOfSessions } from '../domain/sessionsRoute';
import type { MyWorkspace } from '../domain/workspace';
import { replaceHash } from '../services/address';
import { cloudSessionsService } from '../services/cloudSessions';

type FormView =
  | { kind: 'loading' }
  | { kind: 'offered'; options: CloudSessionOptions }
  /** No runner is connected for the workspace: its sentence takes the form's place. */
  | { kind: 'no-runner' }
  | { kind: 'refused'; answer: CellRefusal };

/**
 * The form that starts a cloud session: a repository and a harness, each from what the
 * workspace's runner offers (`GET /api/cloud-sessions/options`), and the sentence saying what
 * starting trusts above Start. With no runner connected, that sentence stands in the form's
 * place. A session started opens its page in the form's place in the history, so back leads to
 * the list.
 */
export function NewSessionPage({ workspace }: { workspace: MyWorkspace }) {
  const id = useId();
  const [view, setView] = useState<FormView>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const [repository, setRepository] = useState<string | null>(null);
  const [harness, setHarness] = useState<Harness | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is Try again, which reads them again.
  useEffect(() => {
    let live = true;
    setView({ kind: 'loading' });
    void cloudSessionsService.loadOptions({ id: workspace.id }).then((answer) => {
      if (!live) return;
      if (answer.kind === 'offered') setView({ kind: 'offered', options: answer.options });
      else if (answer.kind === 'no-runner') setView({ kind: 'no-runner' });
      else setView({ kind: 'refused', answer });
    });
    return () => {
      live = false;
    };
  }, [workspace.id, round]);

  const tryAgain = () => {
    setProblem(null);
    setRound((n) => n + 1);
  };

  const options = view.kind === 'offered' ? view.options : null;
  // What the person picked, while the runner still offers it; else the first it offers.
  const chosenRepository =
    repository && options?.repositories.includes(repository)
      ? repository
      : (options?.repositories[0] ?? null);
  const chosenHarness =
    harness && options?.harnesses.includes(harness) ? harness : (options?.harnesses[0] ?? null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || chosenRepository === null || chosenHarness === null) return;
    const asked = { repository: chosenRepository, harness: chosenHarness };
    setPending(true);
    setProblem(null);
    const answer = await cloudSessionsService.startSession(workspace, asked);
    if (answer.kind === 'started') {
      replaceHash(hashOfSession(answer.session.id));
      return;
    }
    setPending(false);
    if (answer.kind === 'refused' && answer.code === 'no_runner') {
      setView({ kind: 'no-runner' });
      return;
    }
    setProblem(messageForStartAnswer(answer, asked, workspace));
  }

  return (
    <div className="sessions sessions-narrow">
      <header className="sessions-head">
        <h1 className="sessions-title">New session</h1>
      </header>

      {view.kind === 'loading' && (
        <div className="sessions-loading" role="status" aria-busy="true">
          <span className="sr-only">Asking the runner what it offers…</span>
          <span className="sessions-loading-bar" />
          <span className="sessions-loading-bar sessions-loading-short" />
        </div>
      )}

      {(view.kind === 'no-runner' || view.kind === 'refused') && (
        <div className="sessions-notice" role="alert">
          <p>
            {view.kind === 'no-runner'
              ? NO_RUNNER_WORDS
              : messageForCellRefusal(view.answer, workspace)}
          </p>
          <div className="sessions-actions">
            {(view.kind === 'no-runner' ||
              view.answer.kind === 'pending' ||
              view.answer.kind === 'unavailable') && (
              <button type="button" className="button" onClick={tryAgain}>
                Try again
              </button>
            )}
            <a className="button" href={hashOfSessions()}>
              Back to sessions
            </a>
          </div>
        </div>
      )}

      {options &&
        (chosenRepository === null || chosenHarness === null ? (
          <div className="sessions-notice" role="alert">
            <p>{NOTHING_OFFERED_WORDS}</p>
            <div className="sessions-actions">
              <button type="button" className="button" onClick={tryAgain}>
                Try again
              </button>
              <a className="button" href={hashOfSessions()}>
                Back to sessions
              </a>
            </div>
          </div>
        ) : (
          <form
            className="form card sessions-form"
            noValidate
            onSubmit={(event) => void submit(event)}
          >
            <div className="field">
              <label className="label" htmlFor={`${id}-repository`}>
                Repository
              </label>
              <select
                id={`${id}-repository`}
                className="input select"
                value={chosenRepository}
                disabled={pending}
                onChange={(event) => setRepository(event.target.value)}
              >
                {options.repositories.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor={`${id}-harness`}>
                Harness
              </label>
              <select
                id={`${id}-harness`}
                className="input select"
                value={chosenHarness}
                disabled={pending}
                onChange={(event) => {
                  const picked = options.harnesses.find((each) => each === event.target.value);
                  if (picked) setHarness(picked);
                }}
              >
                {options.harnesses.map((each) => (
                  <option key={each} value={each}>
                    {HARNESS_NAMES[each]}
                  </option>
                ))}
              </select>
            </div>

            <p className="sessions-note">{START_NOTE}</p>

            {problem && (
              <p className="error" role="alert">
                {problem}
              </p>
            )}

            <div className="actions">
              <a className="button" href={hashOfSessions()}>
                Cancel
              </a>
              <button type="submit" className="button primary" disabled={pending}>
                {pending ? 'Starting…' : 'Start session'}
              </button>
            </div>
          </form>
        ))}
    </div>
  );
}
