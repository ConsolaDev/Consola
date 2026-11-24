import { lazy, Suspense, useRef, useState } from 'react';
import {
  type CloudSession,
  chatMounted,
  isEnded,
  pollIntervalMs,
  type SessionAnswer,
  sessionLabel,
  sessionScreen,
  shouldRenewPass,
  startedAt,
} from '../domain/cloudSession';
import {
  CHAT_NOT_LOADED_WORDS,
  CONNECTING_WORDS,
  HARNESS_NAMES,
  messageForPassAnswer,
  messageForSessionAnswer,
  messageForStopAnswer,
  SESSION_STATUS_WORDS,
  sessionRefreshFailedWords,
} from '../domain/cloudSessionMessages';
import { agoInWords, fullTime } from '../domain/runWords';
import { hashOfSessions } from '../domain/sessionsRoute';
import type { MyWorkspace } from '../domain/workspace';
import { cloudSessionsService } from '../services/cloudSessions';
import { useNow, usePoll } from './usePoll';

/** What stands in the chat's place when its code could not be loaded. */
function ChatNotLoaded() {
  return (
    <p className="session-words" role="alert">
      {CHAT_NOT_LOADED_WORDS}
    </p>
  );
}

// The chat is most of the app's weight, so it loads only when a session runs.
const SessionChat = lazy(() =>
  import('./SessionChat').then(
    (module) => ({ default: module.SessionChat }),
    () => ({ default: ChatNotLoaded }),
  ),
);

type PageView =
  | { kind: 'loading' }
  | { kind: 'shown'; session: CloudSession; failedAt: string | null }
  | { kind: 'refused'; answer: Exclude<SessionAnswer, { kind: 'found' }> };

/** The way into a running session's chat: none yet, a pass to its host, or why there is none. */
type ChatAccess =
  | { kind: 'none' }
  | { kind: 'open'; pass: string; hostUrl: string }
  | { kind: 'refused'; message: string };

type Stopping =
  | { kind: 'idle' }
  /** Stop was pressed: the page asks first, in place, since what was not pushed is lost. */
  | { kind: 'asking' }
  | { kind: 'stopping' }
  | { kind: 'failed'; message: string };

/**
 * One cloud session, laid out as a run's page: its header (the way back, its name, its status and
 * Stop), a line of its facts, then what its status shows (`sessionScreen`). While it runs, that is
 * the chat, connected straight to the session's host with a pass from the cell, under the warning
 * that unpushed changes are lost when it stops.
 *
 * It reads the session again every 2 s while it starts and every 10 s while it runs, and never
 * once it has ended. The read that finds it ended unmounts the chat, which drops its connection
 * and its pass, and the page asks for no pass again: nothing reconnects.
 */
export function SessionPage({
  workspace,
  sessionId,
}: {
  workspace: MyWorkspace;
  sessionId: string;
}) {
  const [view, setView] = useState<PageView>({ kind: 'loading' });
  const [access, setAccess] = useState<ChatAccess>({ kind: 'none' });
  const [stopping, setStopping] = useState<Stopping>({ kind: 'idle' });
  // What the reads and the chat's renewal see as they start.
  const latest = useRef({ view, access });
  latest.current = { view, access };
  const now = useNow(30_000);

  const readNow = usePoll(`${workspace.id} ${sessionId}`, async (current) => {
    const answer = await cloudSessionsService.loadSession(workspace, sessionId);
    if (!current()) return null;
    if (answer.kind !== 'found') {
      const previous = latest.current.view;
      if (answer.kind !== 'not-found' && previous.kind === 'shown') {
        // The session stays as it was read, saying when; the next read may work.
        setView({ ...previous, failedAt: previous.failedAt ?? new Date().toISOString() });
        return pollIntervalMs(previous.session.status);
      }
      setView({ kind: 'refused', answer });
      setAccess({ kind: 'none' });
      return null;
    }

    const { session } = answer;
    setView({ kind: 'shown', session, failedAt: null });
    if (!chatMounted(session.status)) {
      // The chat unmounts; its pass is forgotten with it.
      setAccess({ kind: 'none' });
    } else if (latest.current.access.kind !== 'open') {
      const pass = await cloudSessionsService.issuePass(workspace, sessionId);
      if (!current()) return null;
      if (pass.kind === 'issued') {
        setAccess({ kind: 'open', pass: pass.pass.pass, hostUrl: pass.pass.hostUrl });
      } else if (pass.kind !== 'not-found') {
        setAccess({ kind: 'refused', message: messageForPassAnswer(pass, workspace) });
      }
      // Not found: the host has not said its address yet, or the session just ended. The next
      // read asks again, or finds it ended.
    }
    return pollIntervalMs(session.status);
  });

  /** The chat's `onPassExpired`: a new pass from the cell, only while the session runs. */
  const renewPass = async (): Promise<string> => {
    const shown = latest.current.view;
    if (shown.kind !== 'shown' || !shouldRenewPass(shown.session.status)) {
      throw new Error(messageForPassAnswer({ kind: 'not-found' }, workspace));
    }
    try {
      return await cloudSessionsService.renewPass(workspace, sessionId);
    } catch (error) {
      // The session has most likely ended: read it now, so the chat goes without waiting. Its
      // pass is dropped, so a session still running gets a new one from that read (or a later
      // one, at the poll's pace), never from a loop of the chat's own.
      setAccess({ kind: 'none' });
      readNow();
      throw error;
    }
  };

  const stop = async () => {
    setStopping({ kind: 'stopping' });
    const answer = await cloudSessionsService.stopSession(workspace, sessionId);
    if (answer.kind !== 'stopped') {
      setStopping({ kind: 'failed', message: messageForStopAnswer(answer, workspace) });
      return;
    }
    setStopping({ kind: 'idle' });
    setView({ kind: 'shown', session: answer.session, failedAt: null });
    setAccess({ kind: 'none' });
    // A read already under way may predate the stop: start again, so it is never shown.
    readNow();
  };

  const session = view.kind === 'shown' ? view.session : null;
  const screen = session ? sessionScreen(session) : null;
  const started = session ? startedAt(session) : null;

  return (
    <div className="session-page">
      <header className="session-header">
        <h1 className="session-crumbs">
          <a className="session-crumb" href={hashOfSessions()}>
            Sessions
          </a>
          <span className="session-crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="session-crumb-name">
            {session
              ? sessionLabel(session)
              : view.kind === 'refused' && view.answer.kind === 'not-found'
                ? 'Not found'
                : ''}
          </span>
        </h1>
        {session && (
          <span className="session-state" data-status={session.status}>
            <span className="sessions-dot" data-status={session.status} aria-hidden="true" />
            {SESSION_STATUS_WORDS[session.status]}
          </span>
        )}
        {session && !isEnded(session.status) && (
          <div className="session-controls">
            {stopping.kind === 'asking' ? (
              <>
                <span>Stop this session?</span>
                <button
                  type="button"
                  className="button"
                  onClick={() => setStopping({ kind: 'idle' })}
                >
                  Keep it
                </button>
                <button type="button" className="button danger" onClick={() => void stop()}>
                  Stop session
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button"
                disabled={stopping.kind === 'stopping'}
                aria-busy={stopping.kind === 'stopping'}
                onClick={() => setStopping({ kind: 'asking' })}
              >
                {stopping.kind === 'stopping' ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
        )}
      </header>

      {view.kind === 'loading' && (
        <div className="sessions">
          <div className="sessions-loading" role="status" aria-busy="true">
            <span className="sr-only">Loading the session…</span>
            <span className="sessions-loading-bar" />
            <span className="sessions-loading-bar sessions-loading-short" />
          </div>
        </div>
      )}

      {view.kind === 'refused' && (
        <div className="sessions sessions-narrow">
          <div className="sessions-notice" role="alert">
            <p>{messageForSessionAnswer(view.answer, workspace)}</p>
            <div className="sessions-actions">
              {(view.answer.kind === 'pending' || view.answer.kind === 'unavailable') && (
                <button type="button" className="button" onClick={readNow}>
                  Try again
                </button>
              )}
              <a className="button" href={hashOfSessions()}>
                Back to sessions
              </a>
            </div>
          </div>
        </div>
      )}

      {session && screen && started && (
        <>
          <div className="session-facts">
            <span className="session-repository">{session.repository}</span>
            <span>{HARNESS_NAMES[session.harness]}</span>
            <span>
              Started{' '}
              <time dateTime={started} title={fullTime(started)}>
                {agoInWords(started, now)}
              </time>
            </span>
            {view.kind === 'shown' && view.failedAt && (
              <span role="status">{sessionRefreshFailedWords(view.failedAt)}</span>
            )}
            {stopping.kind === 'failed' && (
              <span className="error" role="alert">
                {stopping.message}
              </span>
            )}
          </div>

          {screen.kind === 'running' ? (
            <>
              <p className="session-warning">{screen.warning}</p>
              <div className="session-body">
                {access.kind === 'open' ? (
                  <div className="session-chat">
                    <Suspense
                      fallback={
                        <p className="session-words" role="status">
                          {CONNECTING_WORDS}
                        </p>
                      }
                    >
                      <SessionChat
                        hostUrl={access.hostUrl}
                        pass={access.pass}
                        sessionId={session.id}
                        onPassExpired={renewPass}
                      />
                    </Suspense>
                  </div>
                ) : access.kind === 'refused' ? (
                  <div className="session-words" role="alert">
                    <p>{access.message}</p>
                    <button type="button" className="button" onClick={readNow}>
                      Try again
                    </button>
                  </div>
                ) : (
                  <p className="session-words" role="status">
                    {CONNECTING_WORDS}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="session-words" data-kind={screen.kind} role="status">
              {screen.words}
            </p>
          )}
        </>
      )}
    </div>
  );
}
