import { useEffect, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import type { GateView, StepRun } from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { MarkdownRenderer } from '../Markdown';
import { useIntent } from './parts';
import { answeredWords, gateChoiceLabel, gateHeading, newerRevisionLine } from './gateCardWords';

/** An image in a gate's material is never fetched: someone else's text could point it anywhere. */
const dropImage = () => undefined;

type Read =
  | { state: 'loading' }
  | { state: 'ready'; view: GateView | null }
  | { state: 'failed'; reason: string };

/**
 * A gate on the run page: its question, filled in from the run's trusted
 * values, the documents it shows (each under `material from the run`,
 * through the sanitizing renderer an artifact uses), and one button per
 * choice the run's own definition offers, then Reject. Answering is the
 * person's alone: this card is the one place it is done, through the bridge
 * to main's one handler. A refused answer (the gate was answered from
 * another window) says why in place; once answered, the card says how.
 *
 * Opening it only reads; a button press is the only thing here that moves
 * the run.
 */
export function GateCard({ runId, step, now }: { runId: string; step: StepRun; now: Date }) {
  const [read, setRead] = useState<Read>({ state: 'loading' });
  const requests = useRef(0);
  const { busy, error, act } = useIntent();

  // The row moves as the person answers (here or elsewhere): read the gate again when it does.
  useEffect(() => {
    const request = ++requests.current;
    automationsBridge.getGate(runId, step.id).then(
      (view) => {
        if (request === requests.current) setRead({ state: 'ready', view });
      },
      (failure: unknown) => {
        if (request === requests.current)
          setRead({ state: 'failed', reason: ipcErrorMessage(failure) });
      },
    );
    return () => {
      requests.current++;
    };
  }, [runId, step.id, step.status, step.gate?.decision]);

  if (read.state === 'loading') return <p className="automations-hint">Reading the gate…</p>;
  if (read.state === 'failed')
    return (
      <p className="automations-error" role="alert">
        Could not read this gate: {read.reason}
      </p>
    );
  const { view } = read;
  if (!view) return null;
  const waiting = step.status === 'waiting' && !view.answered;
  const answered = answeredWords(view, now);
  const newer = waiting ? newerRevisionLine(view) : null;
  const answer = (decision: string) =>
    act(decision, async () => {
      await automationsBridge.answerGate(runId, step.id, decision);
    });

  return (
    <section className="automations-gate-card" aria-label={`Gate ${step.id}`}>
      <h4 className="automations-gate-heading">
        <Hand size={14} aria-hidden="true" />
        <span>{gateHeading(view)}</span>
      </h4>
      {view.material.map((document) => (
        <div key={document.label} className="automations-gate-material">
          <p className="automations-gate-material-label">
            material from the run · <code>{document.label}</code>
            {document.truncated ? ' (its end)' : ''}
          </p>
          <div className="automations-answer">
            <MarkdownRenderer
              content={document.text}
              enableCommandHighlighting={false}
              resolveImageSrc={dropImage}
            />
          </div>
        </div>
      ))}
      {answered && <p className="automations-gate-answered">{answered}</p>}
      {waiting && (
        <>
          {newer && <p className="automations-gate-newer">{newer}</p>}
          <div className="automations-card-actions automations-gate-choices">
            {view.choices.map((choice, index) => (
              <button
                key={choice}
                type="button"
                className={`${index === 0 ? 'dialog-button-primary' : 'dialog-button-secondary'} automations-small-button`}
                disabled={busy !== null}
                onClick={() => void answer(choice)}
              >
                {busy === choice ? 'Answering…' : gateChoiceLabel(choice)}
              </button>
            ))}
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              disabled={busy !== null}
              onClick={() => void answer('reject')}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
          {error && (
            <p className="automations-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
