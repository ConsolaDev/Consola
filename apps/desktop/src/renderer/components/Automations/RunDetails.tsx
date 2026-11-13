import { useEffect, useState } from 'react';
import { GitFork, SquareTerminal, Square } from 'lucide-react';
import { isAgentRunPreview, type RunRecord } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { workspaceBridge } from '../../services/workspaceBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { activateSession } from '../../utils/sessionActions';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { ConversationView } from './ConversationView';
import { AgentRunDetails, CleanupDetails, RunItemLink, StatusDot, useIntent, useNow } from './parts';
import { formatDuration, formatTime, ranInWords, runStage, statusWord, triggerLabel } from './presentation';

/**
 * One run, whole, in the side panel: the facts first, then what it is doing
 * or did, by kind and state, with what the person can do about it.
 *
 * Read with `getRun` — the activity list carries only a summary — and read
 * again whenever main says the run changed. Showing it never starts,
 * resumes or attaches to anything: only Start, Approve, Open session and
 * Continue with full tools do, and only when pressed.
 */
export function RunDetails({ workspace, runId }: { workspace: Workspace; runId: string }) {
  const updatedAt = useAutomationsStore(
    (state) => state.snapshots[workspace.id]?.runs.find((run) => run.id === runId)?.updatedAt
  );
  const [loaded, setLoaded] = useState<{ run: RunRecord | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    automationsBridge.getRun(runId).then(
      (run) => {
        if (!live) return;
        setLoaded({ run });
        setLoadError(null);
      },
      (failure: unknown) => {
        if (live) setLoadError(ipcErrorMessage(failure));
      }
    );
    return () => {
      live = false;
    };
  }, [runId, updatedAt]);

  if (loadError && !loaded) return <div className="automations-error" role="alert">{loadError}</div>;
  if (!loaded) return <p className="automations-hint">Loading…</p>;
  // A notification or a stale panel can name a run that history has since dropped.
  if (!loaded.run) return <p className="automations-hint">This run is no longer in history.</p>;
  return <RunView workspace={workspace} run={loaded.run} />;
}

function RunView({ workspace, run }: { workspace: Workspace; run: RunRecord }) {
  const place = useAutomationsStore((state) => state.snapshots[workspace.id]?.queue[run.id]);
  const { busy, error, act } = useIntent();
  const stage = runStage(run);
  const preview = isAgentRunPreview(run.result) ? run.result : null;
  // A session ran it, so there is a transcript to read — even once the session is removed.
  const hasSession = Boolean(run.conversation || run.sessionId);
  const session = run.sessionId ? workspace.sessions.find((candidate) => candidate.id === run.sessionId) : undefined;

  return (
    <div className="automations-run-details">
      <RunFactsList workspace={workspace} run={run} />
      {/* An agent run's summary repeats its facts ("Running in …", "Did not finish in …"). */}
      {run.summary && (stage === 'tool' || stage === 'agent-unstarted') && (
        <p className="automations-summary">{run.summary}</p>
      )}
      {run.error && <div className="automations-error automations-run-error">{run.error}</div>}
      {error && <div className="automations-error" role="alert">{error}</div>}

      {stage === 'agent-waiting' && preview && (
        <>
          <AgentRunDetails preview={preview} />
          <div className="automations-card-actions">
            <button
              type="button"
              className="dialog-button-primary automations-small-button"
              disabled={busy !== null}
              onClick={() => void act('approve', () => automationsBridge.approve(run.id))}
            >
              {busy === 'approve' ? 'Starting…' : 'Start'}
            </button>
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              disabled={busy !== null}
              onClick={() => void act('dismiss', () => automationsBridge.dismiss(run.id))}
            >
              Dismiss
            </button>
          </div>
          <p className="automations-hint">
            Starting opens a read-only session with exactly this prompt: it can read the code and the change, and
            cannot run it or act on GitHub. It waits its turn if other automation sessions are working.
          </p>
        </>
      )}

      {stage === 'agent-queued' && preview && (
        <>
          <div className="automations-panel-row">
            <span className="automations-meta">{place !== undefined ? `${place} in line` : 'Waiting to start'}</span>
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              disabled={busy !== null}
              onClick={() => void act('dismiss', () => automationsBridge.dismiss(run.id))}
            >
              Cancel
            </button>
          </div>
          <div className="automations-details">
            <div className="automations-panel-label">The prompt it will send</div>
            <pre className="automations-prompt">{preview.prompt}</pre>
          </div>
          <p className="automations-hint">
            A few automation sessions work at once, across every workspace; the rest start in order as those finish
            or stop to wait for you.
          </p>
        </>
      )}

      {stage === 'agent-running' && (
        <>
          <div className="automations-card-actions">
            <StopButton runId={run.id} />
          </div>
          {!hasSession && <p className="automations-hint">Starting its session…</p>}
        </>
      )}

      {stage === 'agent-finished' && (
        <>
          {session ? (
            <div className="automations-card-actions">
              <button
                type="button"
                className="dialog-button-secondary automations-small-button"
                onClick={() => activateSession(workspace.id, session.id)}
              >
                <SquareTerminal size={12} />
                Open session
              </button>
              <button
                type="button"
                className="dialog-button-secondary automations-small-button"
                disabled={busy !== null}
                title="A new session that continues this conversation with your own tools and permissions"
                onClick={() =>
                  void act('fork', async () => {
                    const fork = await workspaceBridge.forkSession(workspace.id, session.id);
                    activateSession(workspace.id, fork.id);
                  })
                }
              >
                <GitFork size={12} />
                {busy === 'fork' ? 'Continuing…' : 'Continue with full tools'}
              </button>
            </div>
          ) : (
            <span className="automations-session-removed">Session removed</span>
          )}
        </>
      )}

      {/* One place for both, so the view carries on rather than reloading when the run settles. */}
      {(stage === 'agent-running' || stage === 'agent-finished') && hasSession && (
        <ConversationView runId={run.id} follow={stage === 'agent-running'} />
      )}

      {stage === 'agent-unstarted' && preview && <AgentRunDetails preview={preview} />}

      {stage === 'tool' && (
        <>
          <CleanupDetails result={run.result} />
          {run.status === 'needs-approval' && (
            <>
              <div className="automations-card-actions">
                <button
                  type="button"
                  className="dialog-button-primary automations-small-button"
                  disabled={busy !== null}
                  onClick={() => void act('approve', () => automationsBridge.approve(run.id))}
                >
                  {busy === 'approve' ? 'Running…' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="dialog-button-secondary automations-small-button"
                  disabled={busy !== null}
                  onClick={() => void act('dismiss', () => automationsBridge.dismiss(run.id))}
                >
                  Dismiss
                </button>
              </div>
              <p className="automations-hint">
                Approving acts only on what is listed, checking each again first. Ignored files in a removed worktree
                (build output, dependencies, local env files) go with it.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Stop ends the turn as Ctrl+C would. The run itself reports the outcome once
 * the turn has ended, so the button stays pressed until then.
 */
function StopButton({ runId }: { runId: string }) {
  const [stopping, setStopping] = useState(false);
  const { busy, error, act } = useIntent();
  return (
    <>
      <button
        type="button"
        className="dialog-button-secondary automations-small-button"
        disabled={stopping || busy !== null}
        onClick={() =>
          void act('stop', async () => {
            await automationsBridge.stop(runId);
            setStopping(true);
          })
        }
      >
        <Square size={11} />
        {stopping || busy === 'stop' ? 'Stopping…' : 'Stop'}
      </button>
      {error && <div className="automations-error" role="alert">{error}</div>}
    </>
  );
}

/**
 * Status and duration, what fired it, what it ran, and an agent run's
 * session. The item's title and author are other people's text, shown as text.
 */
function RunFactsList({ workspace, run }: { workspace: Workspace; run: RunRecord }) {
  const harnessName = useHarnessStore(
    (state) => state.harnesses.find((harness) => harness.id === run.conversation?.harnessId)?.name
  );
  const now = useNow(run.status === 'running' ? 1000 : null);
  const duration = run.startedAt ? formatDuration(run, now) : null;
  const preview = isAgentRunPreview(run.result) ? run.result : null;
  const author = preview?.item?.author;
  const asker =
    run.trigger.by === 'agent' && run.trigger.actorId
      ? workspace.sessions.find((session) => session.id === run.trigger.actorId)?.name
      : undefined;
  const session = run.conversation
    ? ['Read-only', harnessName ?? run.conversation.harnessId, run.conversation.cwd].filter(Boolean).join(' · ')
    : null;

  return (
    <dl className="automations-facts">
      <div className="automations-fact automations-fact-status">
        <dt>Status</dt>
        <dd>
          <StatusDot status={run.status} />
          <span className={`automations-run-status-${run.status}`}>{statusWord(run.status)}</span>
          {duration ? ` · ${duration}` : ''}
        </dd>
      </div>
      <div className="automations-fact">
        <dt>Trigger</dt>
        <dd>
          {triggerLabel(run)} · {formatTime(run.trigger.at)}
          {asker ? ` · ${asker}` : ''}
          {run.trigger.item && (
            <>
              {' · '}
              <RunItemLink run={run} />
              {author ? ` by @${author}` : ''}
            </>
          )}
        </dd>
      </div>
      <div className="automations-fact">
        <dt>Ran</dt>
        <dd>
          {ranInWords(run)} · {run.mode}
        </dd>
      </div>
      {session && (
        <div className="automations-fact">
          <dt>Session</dt>
          <dd className="automations-fact-session">{session}</dd>
        </div>
      )}
    </dl>
  );
}
