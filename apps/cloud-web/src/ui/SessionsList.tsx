import { Bot, ExternalLink, FolderGit2, MessagesSquare, Plus, Workflow } from 'lucide-react';
import { useRef, useState } from 'react';
import { messageForCellRefusal } from '../domain/cell';
import {
  agentRunPhase,
  isAgentRun,
  keepsShownOn,
  listPollIntervalMs,
  pullRequestLabel,
  pullRequestUrl,
  sessionLabel,
  startedAt,
} from '../domain/cloudSession';
import type { AgentRun, CloudSession, SessionsAnswer } from '../domain/cloudSession';
import {
  AGENT_RUN_LABEL,
  AGENT_RUN_PHASE_WORDS,
  HARNESS_NAMES,
  NO_SESSIONS_TITLE,
  NO_SESSIONS_WORDS,
  SESSION_STATUS_WORDS,
  sessionsRefreshFailedWords,
} from '../domain/cloudSessionMessages';
import { hashOfNewSession, hashOfSession } from '../domain/sessionsRoute';
import { agoInWords, fullTime } from '../domain/runWords';
import type { MyWorkspace } from '../domain/workspace';
import { cloudSessionsService } from '../services/cloudSessions';
import { useNow, usePoll } from './usePoll';

type ListView =
  | { kind: 'loading' }
  | { kind: 'shown'; sessions: CloudSession[]; failedAt: string | null }
  | { kind: 'refused'; answer: Exclude<SessionsAnswer, { kind: 'listed' }> };

/**
 * The person's cloud sessions and the workspace's agent runs, newest first as the cell lists
 * them: each a row of its status, its name, its repository and harness, and when it started,
 * linking to its page. An agent run's row names the automation that started it and links its
 * pull request on GitHub, with where the run stands in words. It reads them again while the page
 * shows, as often as the liveliest session asks, and now and then once none can change; a
 * refresh that fails for a while keeps the rows, and says when they were read.
 */
export function SessionsList({ workspace }: { workspace: MyWorkspace }) {
  const [view, setView] = useState<ListView>({ kind: 'loading' });
  const shown = useRef(view);
  shown.current = view;
  const now = useNow(30_000);

  const readNow = usePoll(workspace.id, async (current) => {
    const answer = await cloudSessionsService.loadSessions(workspace);
    if (!current()) return null;
    if (answer.kind === 'listed') {
      setView({ kind: 'shown', sessions: answer.sessions, failedAt: null });
      return listPollIntervalMs(answer.sessions);
    }
    const previous = shown.current;
    if (keepsShownOn(answer) && previous.kind === 'shown') {
      // The rows stay as they were read, saying when; the next read may work. Signed out or
      // switched, the list says so instead.
      setView({ ...previous, failedAt: previous.failedAt ?? new Date().toISOString() });
      return listPollIntervalMs(previous.sessions);
    }
    setView({ kind: 'refused', answer });
    return null;
  });

  return (
    <div className="sessions">
      <header className="sessions-head">
        <h1 className="sessions-title">Sessions</h1>
        <a className="button primary" href={hashOfNewSession()}>
          <Plus size={14} aria-hidden="true" />
          New session
        </a>
      </header>

      {view.kind === 'shown' && view.failedAt && (
        <p className="sessions-stale" role="status">
          {sessionsRefreshFailedWords(view.failedAt)}
        </p>
      )}

      {view.kind === 'loading' && (
        <div className="sessions-loading" role="status" aria-busy="true">
          <span className="sr-only">Loading your sessions…</span>
          <span className="sessions-loading-bar" />
          <span className="sessions-loading-bar sessions-loading-short" />
        </div>
      )}

      {view.kind === 'refused' && (
        <div className="sessions-notice" role="alert">
          <p>{messageForCellRefusal(view.answer, workspace)}</p>
          {(view.answer.kind === 'pending' || view.answer.kind === 'unavailable') && (
            <button type="button" className="button" onClick={readNow}>
              Try again
            </button>
          )}
        </div>
      )}

      {view.kind === 'shown' &&
        (view.sessions.length === 0 ? (
          <div className="sessions-empty">
            <span className="sessions-empty-tile" aria-hidden="true">
              <MessagesSquare size={20} />
            </span>
            <h2 className="sessions-empty-title">{NO_SESSIONS_TITLE}</h2>
            <p className="sessions-empty-words">{NO_SESSIONS_WORDS}</p>
            <a className="button" href={hashOfNewSession()}>
              New session
            </a>
          </div>
        ) : (
          <ul className="sessions-list" aria-label="Sessions">
            {view.sessions.map((session) =>
              isAgentRun(session) ? (
                <AgentRunRow key={session.id} run={session} now={now} />
              ) : (
                <SessionRow key={session.id} session={session} now={now} />
              ),
            )}
          </ul>
        ))}
    </div>
  );
}

function SessionRow({ session, now }: { session: CloudSession; now: number }) {
  const started = startedAt(session);
  const status = SESSION_STATUS_WORDS[session.status];
  return (
    <li className="sessions-entry">
      <a className="sessions-row" href={hashOfSession(session.id)}>
        <span className="sessions-dot" data-status={session.status} aria-hidden="true" />
        <span className="sessions-row-title">{sessionLabel(session)}</span>
        <span className="sessions-row-meta">
          <span className="sessions-tag" title={`Repository ${session.repository}`}>
            <FolderGit2 size={12} aria-hidden="true" />
            <span className="sessions-tag-text">{session.repository}</span>
          </span>
          <span className="sessions-tag" title={`Harness ${HARNESS_NAMES[session.harness]}`}>
            <Bot size={12} aria-hidden="true" />
            <span className="sessions-tag-text">{HARNESS_NAMES[session.harness]}</span>
          </span>
          <span className="sessions-row-status">{status}</span>
          <time className="sessions-row-time" dateTime={started} title={fullTime(started)}>
            {agoInWords(started, now)}
          </time>
        </span>
      </a>
    </li>
  );
}

/**
 * An agent run's row: the automation that started it, its pull request as a link to GitHub (a
 * new tab), where the run stands, its status and when it started. The row's own link is its
 * name, stretched over the row, so the pull request's link sits beside it rather than inside it.
 */
function AgentRunRow({ run, now }: { run: AgentRun; now: number }) {
  const started = startedAt(run);
  const { origin } = run;
  const pullRequest = pullRequestLabel(origin.item);
  const url = pullRequestUrl(origin.item);
  const phase = agentRunPhase(run);
  return (
    <li className="sessions-entry">
      <div className="sessions-row" data-kind="agent-run">
        <span className="sessions-dot" data-status={run.status} aria-hidden="true" />
        <span className="sessions-run-main">
          <a
            className="sessions-row-title sessions-row-link"
            href={hashOfSession(run.id)}
            title={sessionLabel(run)}
          >
            <Workflow size={14} aria-hidden="true" />
            <span className="sessions-run-name">{origin.automation}</span>
            <span className="sr-only">
              , {AGENT_RUN_LABEL.toLowerCase()} on {pullRequest}
            </span>
          </a>
          {url ? (
            <a
              className="sessions-run-item"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${pullRequest} on GitHub`}
            >
              <span className="sessions-tag-text">{pullRequest}</span>
              <ExternalLink size={12} aria-hidden="true" />
              <span className="sr-only"> (opens GitHub in a new tab)</span>
            </a>
          ) : (
            <span className="sessions-run-item">
              <span className="sessions-tag-text">{pullRequest}</span>
            </span>
          )}
        </span>
        <span className="sessions-row-meta">
          <span className="sessions-tag" title={`${AGENT_RUN_LABEL} of ${origin.factoryName}`}>
            <Bot size={12} aria-hidden="true" />
            <span className="sessions-tag-text">{AGENT_RUN_LABEL}</span>
          </span>
          <span className="sessions-run-phase" data-phase={phase}>
            {AGENT_RUN_PHASE_WORDS[phase]}
          </span>
          <span className="sessions-row-status">{SESSION_STATUS_WORDS[run.status]}</span>
          <time className="sessions-row-time" dateTime={started} title={fullTime(started)}>
            {agoInWords(started, now)}
          </time>
        </span>
      </div>
    </li>
  );
}
