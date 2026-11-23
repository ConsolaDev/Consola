import { MessageCircleQuestion, MessagesSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  CONVERSATION_LATER_TITLE,
  CONVERSATION_LATER_WORDS,
  questionOpenWords,
} from '../domain/runMessages';
import { type RunDetail, type RunSummary, starterOf } from '../domain/runs';
import type { RunPlace } from '../domain/runsRoute';
import { agoInWords, fullTime } from '../domain/runWords';
import type { WorkspaceMember } from '../domain/teams';
import { Avatar } from './Avatar';
import { StepTrace } from './StepTrace';

/**
 * A request's main pane: its conversation with the orchestrator. `AgentChat` (`@consola/agent-ui`)
 * mounts here once requests run in cloud sessions, with the request as its first message and
 * the composer for follow-ups. Until then (`conversation === null`) the pane shows what the cell
 * holds, the request as the person gave it, and says plainly what will join it.
 *
 * The request's text is untrusted (it may be a pasted ticket): it is shown as plain text, never as
 * markup.
 */
export function RequestPane({
  detail,
  members,
  now,
  lead,
}: {
  detail: RunDetail;
  members: WorkspaceMember[] | null;
  now: number;
  /** What comes before the conversation: the approval card, while the request waits for one. */
  lead?: ReactNode;
}) {
  const { run, request } = detail;
  if (!request) return null;
  const starter = starterOf(run, members);
  const name =
    starter.kind === 'member'
      ? starter.member.name
      : starter.kind === 'left'
        ? 'Someone who left'
        : 'Someone';
  return (
    <div className="run-conversation">
      {lead}
      <ol className="run-messages" aria-label="Conversation">
        <li className="run-message">
          <div className="run-message-head">
            <Avatar
              user={{
                name: starter.kind === 'member' ? name : '',
                image: starter.kind === 'member' ? starter.member.image : null,
              }}
              size={22}
            />
            <span className="run-message-who">{name}</span>
            <time
              className="run-message-when"
              dateTime={run.createdAt}
              title={fullTime(run.createdAt)}
            >
              {agoInWords(run.createdAt, now)}
            </time>
          </div>
          <p className="run-message-text">{request.text}</p>
        </li>
      </ol>

      {request.question && (
        <div className="run-callout" data-tone="warning" role="status">
          <MessageCircleQuestion size={16} aria-hidden="true" />
          <p>{questionOpenWords(request.question.until)}</p>
        </div>
      )}

      {detail.conversation === null && (
        <div className="run-later">
          <MessagesSquare size={18} aria-hidden="true" />
          <h2 className="run-later-title">{CONVERSATION_LATER_TITLE}</h2>
          <p className="run-later-words">{CONVERSATION_LATER_WORDS}</p>
        </div>
      )}

      <Outcome run={run} />
    </div>
  );
}

/** How a run ended, in its own sentence, when it says one: its error, else its summary. */
function Outcome({ run }: { run: RunSummary }) {
  if (run.error) {
    return (
      <p className="run-outcome" data-tone="error">
        {run.error}
      </p>
    );
  }
  if (run.summary) return <p className="run-outcome">{run.summary}</p>;
  return null;
}

/**
 * An automation run's main pane: the approval card while it waits for one (`lead`), how it ended,
 * then its steps traced as the desktop traces them, or the file behind them (`StepTrace`). A failed
 * run's own note says where it broke.
 */
export function StepsPane({
  detail,
  now,
  place,
  onPlace,
  lead,
}: {
  detail: RunDetail;
  now: number;
  place: RunPlace;
  onPlace: (place: RunPlace) => void;
  lead?: ReactNode;
}) {
  const { run } = detail;
  return (
    <div className="run-steps-pane">
      {lead}
      {run.phase !== 'failed' && <Outcome run={run} />}
      <StepTrace detail={detail} now={now} place={place} onPlace={onPlace} />
    </div>
  );
}
