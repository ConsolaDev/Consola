import { useState } from 'react';
import {
  agentRunPhase,
  isAgentRun,
  isEnded,
  repositoryTitle,
  repositoryWords,
  sessionLabel,
  showsRepository,
  startedAt,
} from '../domain/cloudSession';
import {
  AGENT_RUN_PHASE_WORDS,
  HARNESS_NAMES,
  messageForSessionAnswer,
  messageForStopAnswer,
  SESSION_STATUS_WORDS,
  sessionRefreshFailedWords,
} from '../domain/cloudSessionMessages';
import { agoInWords, fullTime } from '../domain/runWords';
import { hashOfSessions } from '../domain/sessionsRoute';
import type { MyWorkspace } from '../domain/workspace';
import { cloudSessionsService } from '../services/cloudSessions';
import { AgentRunFacts } from './AgentRunReport';
import { SessionConversation } from './SessionConversation';
import { useCloudSession } from './useCloudSession';
import { useNow } from './usePoll';

type Stopping =
  | { kind: 'idle' }
  /** Stop was pressed: the page asks first, in place, since what was not pushed is lost. */
  | { kind: 'asking' }
  | { kind: 'stopping' }
  | { kind: 'failed'; message: string };

/**
 * One cloud session, laid out as a run's page: its header (the way back, its name, its status and
 * Stop), a line of its facts, then what its status shows (`SessionConversation`): while it runs,
 * the chat, connected straight to the session's host with a pass from the API, under the warning
 * that unpushed changes are lost when it stops. The session is read and its chat's pass kept as
 * `useCloudSession` says.
 *
 * An agent run's session is its run's conversation, which its run's page shows (Runs); opened by
 * its address, this page shows it too, saying what it is in its facts (the automation and its
 * factory, the pull request, the commit) and where it stands beside its status, with the runner's
 * last report of it.
 */
export function SessionPage({
  workspace,
  sessionId,
}: {
  workspace: MyWorkspace;
  sessionId: string;
}) {
  const { view, access, readNow, renewPass, showStopped } = useCloudSession(workspace, sessionId);
  const [stopping, setStopping] = useState<Stopping>({ kind: 'idle' });
  const now = useNow(30_000);

  const stop = async () => {
    setStopping({ kind: 'stopping' });
    const answer = await cloudSessionsService.stopSession(workspace, sessionId);
    if (answer.kind !== 'stopped') {
      setStopping({ kind: 'failed', message: messageForStopAnswer(answer) });
      return;
    }
    setStopping({ kind: 'idle' });
    showStopped(answer.session);
  };

  const session = view.kind === 'shown' ? view.session : null;
  const started = session ? startedAt(session) : null;
  const run = session && isAgentRun(session) ? session : null;
  const phase = run ? agentRunPhase(run) : null;
  const what = run ? 'run' : 'session';

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
        {phase && (
          <span className="session-state agent-run-phase" data-phase={phase}>
            {AGENT_RUN_PHASE_WORDS[phase]}
          </span>
        )}
        {session && !isEnded(session.status) && (
          <div className="session-controls">
            {stopping.kind === 'asking' ? (
              <>
                <span>Stop this {what}?</span>
                <button
                  type="button"
                  className="button"
                  onClick={() => setStopping({ kind: 'idle' })}
                >
                  Keep it
                </button>
                <button type="button" className="button danger" onClick={() => void stop()}>
                  Stop {what}
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
            <p>{messageForSessionAnswer(view.answer)}</p>
            <div className="sessions-actions">
              {view.answer.kind === 'unavailable' && (
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

      {session && started && (
        <>
          <div className="session-facts">
            {run && <AgentRunFacts run={run} />}
            {showsRepository(session) && (
              <span
                // A repository's name is monospaced; "No repository" is words.
                className={session.repository === null ? undefined : 'session-repository'}
                title={repositoryTitle(session.repository)}
              >
                {repositoryWords(session.repository)}
              </span>
            )}
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

          <SessionConversation
            session={session}
            access={access}
            renewPass={renewPass}
            onRetry={readNow}
          />
        </>
      )}
    </div>
  );
}
