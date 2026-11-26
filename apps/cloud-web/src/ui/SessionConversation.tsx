import { lazy, Suspense } from 'react';
import { isAgentRun, sessionScreen } from '../domain/cloudSession';
import type { CloudSession } from '../domain/cloudSession';
import { CHAT_NOT_LOADED_WORDS, CONNECTING_WORDS } from '../domain/cloudSessionMessages';
import { AgentRunReport } from './AgentRunReport';
import type { ChatAccess } from './useCloudSession';
// A run's page shows a session too, so the session's styles come with this, not with Sessions.
import './Sessions.css';

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

/**
 * What a session's status shows (`sessionScreen`), below whatever names it. While it runs, the
 * chat, connected straight to the session's host with the pass `access` holds, under the warning
 * that unpushed changes are lost when it stops; otherwise its words. An agent run adds the runner's
 * last report of it (`AgentRunReport`: the foreman's result and the agents it dispatched), above
 * the chat while it runs and alone, after its words, once it has ended.
 *
 * Its session page and its run's Conversation tab both show a session this way, each from
 * `useCloudSession`.
 */
export function SessionConversation({
  session,
  access,
  renewPass,
  onRetry,
}: {
  session: CloudSession;
  access: ChatAccess;
  renewPass: () => Promise<string>;
  /** Reads the session again, for a pass the cell refused. */
  onRetry: () => void;
}) {
  const screen = sessionScreen(session);
  const run = isAgentRun(session) ? session : null;

  if (screen.kind !== 'running') {
    if (!run) {
      return (
        <p className="session-words" data-kind={screen.kind} role="status">
          {screen.words}
        </p>
      );
    }
    // Starting, stopped or failed: the words, then what the run reported, which stays.
    return (
      <div className="agent-run-pane">
        <p className="session-words" data-kind={screen.kind} role="status">
          {screen.words}
        </p>
        <AgentRunReport run={run} />
      </div>
    );
  }

  return (
    <>
      {run && (
        <div className="agent-run-pane" data-live="">
          <AgentRunReport run={run} />
        </div>
      )}
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
            <button type="button" className="button" onClick={onRetry}>
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
  );
}
