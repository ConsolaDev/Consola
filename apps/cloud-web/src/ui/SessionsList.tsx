import { Bot, FolderGit2, MessagesSquare, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { messageForRefusal } from '../domain/refusal';
import { keepsShownOn, listPollIntervalMs, sessionLabel, startedAt } from '../domain/cloudSession';
import type { CloudSession, SessionsAnswer } from '../domain/cloudSession';
import {
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
 * The person's own cloud sessions, newest first as the API lists them: each a row of its status,
 * its name, its repository and harness, and when it started, linking to its page. The workspace's
 * agent runs are not here: each is a run, in Runs, whose page holds its session as its
 * conversation. It reads them again while the page shows, as often as the liveliest session asks,
 * and now and then once none can change; a refresh that fails for a while keeps the rows, and
 * says when they were read.
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
          <p>{messageForRefusal(view.answer)}</p>
          {view.answer.kind === 'unavailable' && (
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
            {view.sessions.map((session) => (
              <SessionRow key={session.id} session={session} now={now} />
            ))}
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
