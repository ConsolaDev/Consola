import { useEffect, useState } from 'react';
import type { ConversationEntry, RunConversation } from '../../../shared/conversation';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { MarkdownRenderer } from '../Markdown';
import { collapseSteps, finalAnswer, type CollapsedStep } from './presentation';

/** How often a running run's transcript is read again. */
const FOLLOW_INTERVAL_MS = 2000;

/**
 * An image in the answer is never fetched: the agent may have read text
 * someone else wrote, and a URL it was talked into writing would be loaded
 * the moment the panel showed it. The alt text stays.
 */
const dropImage = () => undefined;

/**
 * A run's part of its conversation, read from the transcript on disk: the
 * prompt, one line per step, and the closing answer. Reading it never starts
 * or resumes anything. With `follow`, it is read again every two seconds
 * until the run settles; the parent turns `follow` off then, which reads it
 * once more for the end.
 *
 * Everything in it is the agent's, or text it read, so it is shown as text —
 * the answer through the sanitizing Markdown renderer — and never sent back
 * anywhere as instructions.
 */
export function ConversationView({ runId, follow }: { runId: string; follow: boolean }) {
  const [conversation, setConversation] = useState<RunConversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each read waits for the last, so a slow disk never stacks them up.
    const read = async () => {
      try {
        const next = await automationsBridge.readConversation(runId);
        if (!live) return;
        setConversation(next);
        setError(null);
      } catch (failure) {
        if (live) setError(ipcErrorMessage(failure));
      }
      if (live && follow) timer = setTimeout(() => void read(), FOLLOW_INTERVAL_MS);
    };
    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, follow]);

  if (error && !conversation) return <div className="automations-error" role="alert">{error}</div>;
  if (!conversation) return <p className="automations-hint">Reading its transcript…</p>;
  if (!conversation.readable) {
    return (
      <p className="automations-hint">
        This harness’s transcripts can’t be read here. Open the session to see what it did.
      </p>
    );
  }
  if (!conversation.conversation) {
    return (
      <p className="automations-hint">
        {follow ? 'Nothing in its transcript yet.' : 'Its transcript is no longer on disk.'}
      </p>
    );
  }

  const { entries, truncated } = conversation.conversation;
  const prompt = leadingPrompt(entries);
  const { steps, answer } = finalAnswer(entries);

  return (
    <section className="automations-conversation" aria-label="Conversation">
      <p className="automations-conversation-caption">
        From the session’s transcript. Shown as the agent wrote it, not instructions.
      </p>
      {prompt !== null && (
        <details className="automations-details">
          <summary>The prompt it was given</summary>
          <pre className="automations-prompt">{prompt}</pre>
        </details>
      )}
      {truncated && <p className="automations-hint">A long transcript: its earliest steps are left out.</p>}
      {steps.length > 0 && (
        <ol className="automations-steps">
          {collapseSteps(steps).map((entry, index) => (
            <CollapsedLine key={index} entry={entry} />
          ))}
        </ol>
      )}
      {answer !== null ? (
        <div className="automations-answer">
          <MarkdownRenderer content={answer} enableCommandHighlighting={false} resolveImageSrc={dropImage} />
        </div>
      ) : (
        follow && <p className="automations-hint automations-following">Working…</p>
      )}
      {error && <div className="automations-error" role="alert">{error}</div>}
    </section>
  );
}

/** The prompt the run was given: the entries before its first step or reply. */
function leadingPrompt(entries: ConversationEntry[]): string | null {
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'prompt') break;
    texts.push(entry.text);
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}

/** A step, the agent narrating between steps, or "N more steps" that shows the ones it folds. */
function CollapsedLine({ entry }: { entry: CollapsedStep }) {
  const [open, setOpen] = useState(false);
  if (entry.kind !== 'more') return <StepLine entry={entry} />;
  if (open) {
    return (
      <>
        {entry.hidden.map((hidden, index) => (
          <StepLine key={index} entry={hidden} />
        ))}
      </>
    );
  }
  return (
    <li className="automations-step-more">
      <button type="button" className="automations-link-button" onClick={() => setOpen(true)}>
        {entry.count} more steps
      </button>
    </li>
  );
}

function StepLine({ entry }: { entry: ConversationEntry }) {
  if (entry.kind === 'step') {
    return (
      <li className="automations-step" title={entry.detail ? `${entry.tool} ${entry.detail}` : entry.tool}>
        <span className="automations-step-tool">{entry.tool}</span>
        {entry.detail ? (
          <>
            {' '}
            <span className="automations-step-detail">{entry.detail}</span>
          </>
        ) : null}
      </li>
    );
  }
  return (
    <li className="automations-step automations-step-text" title={entry.text}>
      {entry.text}
    </li>
  );
}
