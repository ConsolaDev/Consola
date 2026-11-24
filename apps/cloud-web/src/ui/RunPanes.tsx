import { MessageCircleQuestion, MessagesSquare, Workflow } from 'lucide-react';
import { useId } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  CONVERSATION_LATER_TITLE,
  CONVERSATION_LATER_WORDS,
  questionOpenWords,
} from '../domain/runMessages';
import { starterOf } from '../domain/runs';
import type { RunDetail, RunSummary } from '../domain/runs';
import { placeOfTrace, traceOfPlace } from '../domain/runsRoute';
import type { RunPlace } from '../domain/runsRoute';
import { agoInWords, fullTime } from '../domain/runWords';
import type { WorkspaceMember } from '../domain/teams';
import type { MyWorkspace } from '../domain/workspace';
import { Avatar } from './Avatar';
import { RequestAutomations } from './RequestAutomations';
import { StepTrace } from './StepTrace';

type RequestView = 'conversation' | 'automations';

/**
 * A request's main pane: two tabs under the approval card (`lead`), its conversation with the
 * orchestrator first, then the automations the orchestrator started (`RequestAutomations`). The
 * address keeps which shows (`view=automations`) and the automation opened (`run=<id>`), each
 * choice in place of the entry it had (`onPlace`).
 */
export function RequestPane({
  detail,
  workspace,
  members,
  now,
  place,
  onPlace,
  reveal,
  lead,
}: {
  detail: RunDetail;
  workspace: MyWorkspace;
  members: WorkspaceMember[] | null;
  now: number;
  place: RunPlace;
  onPlace: (place: RunPlace) => void;
  /** An automation to open and take the person to, from the info panel or the address. */
  reveal: { run: string; seq: number } | null;
  /** What comes before the tabs: the approval card, while the request waits for one. */
  lead?: ReactNode;
}) {
  const ids = useId();
  const view: RequestView = place.view === 'automations' ? 'automations' : 'conversation';
  const count = detail.children.length;
  const tabs: { view: RequestView; label: string; icon: ReactNode }[] = [
    {
      view: 'conversation',
      label: 'Conversation',
      icon: <MessagesSquare size={14} aria-hidden="true" />,
    },
    { view: 'automations', label: 'Automations', icon: <Workflow size={14} aria-hidden="true" /> },
  ];
  const tabId = (of: RequestView) => `${ids}-tab-${of}`;
  const panelId = (of: RequestView) => `${ids}-panel-${of}`;
  const show = (next: RequestView) =>
    onPlace(
      next === 'automations'
        ? { view: 'automations', step: null, run: place.run }
        : { view: 'main', step: null, run: null },
    );
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: RequestView = view === 'conversation' ? 'automations' : 'conversation';
    show(next);
    requestAnimationFrame(() => document.getElementById(tabId(next))?.focus());
  };

  return (
    <div className="run-request-pane">
      {lead}
      <div
        className="request-tabs"
        role="tablist"
        aria-label="Show the conversation or its automations"
      >
        {tabs.map((tab) => (
          <button
            key={tab.view}
            type="button"
            role="tab"
            id={tabId(tab.view)}
            className="request-tab"
            aria-selected={view === tab.view}
            // Only the view shown has its panel on the page.
            aria-controls={view === tab.view ? panelId(tab.view) : undefined}
            tabIndex={view === tab.view ? 0 : -1}
            onKeyDown={onTabKey}
            onClick={() => show(tab.view)}
          >
            {tab.icon}
            {tab.label}
            {tab.view === 'automations' && (
              <span className="request-tab-count">
                <span className="sr-only">, </span>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={panelId(view)}
        aria-labelledby={tabId(view)}
        className="request-panel"
      >
        {view === 'conversation' ? (
          <Conversation detail={detail} members={members} now={now} />
        ) : (
          <RequestAutomations
            detail={detail}
            workspace={workspace}
            now={now}
            reveal={reveal}
            onOpen={(runId) => onPlace({ view: 'automations', step: null, run: runId })}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A request's conversation with the orchestrator. `AgentChat` (`@consola/agent-ui`) mounts here
 * once requests run in cloud sessions, with the request as its first message and the composer for
 * follow-ups. Until then (`conversation === null`) it shows what the cell holds, the request as
 * the person gave it and its open question's time and deadline, and says plainly what will join
 * them.
 *
 * The request's text is untrusted (it may be a pasted ticket): it is shown as plain text, never as
 * markup.
 */
function Conversation({
  detail,
  members,
  now,
}: {
  detail: RunDetail;
  members: WorkspaceMember[] | null;
  now: number;
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
      <StepTrace
        detail={detail}
        now={now}
        place={traceOfPlace(place)}
        onPlace={(trace) => onPlace(placeOfTrace(trace))}
      />
    </div>
  );
}
