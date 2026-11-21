import { useEffect, useId, useRef, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import type {
  LogTail,
  RunRecord,
  StepDetail as StepDetailData,
  StepRun,
} from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { activateSession } from '../../utils/sessionActions';
import { MarkdownRenderer } from '../Markdown';
import { RunSteps, useRunConversation } from './ConversationView';
import { useNow } from './parts';
import { formatElapsed } from './presentation';
import {
  attemptsLine,
  durationOf,
  logWasCapped,
  stepHeading,
  variableRows,
  visibleTail,
} from './stepDetail';

/** What a log read said when the file's own cap cut it short. */
export const LOG_CAPPED = 'The command wrote more than this; Consola kept the first 1 MB.';

/** An image in an artifact is never fetched: someone else's text could point it anywhere. */
const dropImage = () => undefined;

type Read<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'failed'; reason: string };

/**
 * One step of a run, read from its folder: an agent's session, transcript,
 * outputs and artifacts; a command's exact text, variables, exit and logs.
 * Opening it only reads. Logs, variables and outputs are text and are never
 * interpreted; an artifact goes through the sanitizing renderer alone.
 *
 * The caller keys it by run and step, so a step switch starts clean and a
 * late answer for the old step has nowhere to land.
 */
export function StepDetail({
  workspace,
  run,
  step,
}: {
  workspace: Workspace;
  run: RunRecord;
  step: StepRun;
}) {
  const [detail, setDetail] = useState<Read<StepDetailData | null>>({ state: 'loading' });
  const requests = useRef(0);

  // The record moves as the step does; read the folder again when it does.
  useEffect(() => {
    const request = ++requests.current;
    automationsBridge.getStepDetail(run.id, step.id).then(
      (value) => {
        if (request === requests.current) setDetail({ state: 'ready', value });
      },
      (failure: unknown) => {
        if (request === requests.current)
          setDetail({ state: 'failed', reason: ipcErrorMessage(failure) });
      },
    );
    return () => {
      requests.current++;
    };
  }, [run.id, step.id, step.status, step.attempt, step.finishedAt]);

  const record = (detail.state === 'ready' && detail.value?.record) || step;
  const attempts = attemptsLine(record);

  return (
    <section
      className="automations-detail-section automations-run-section automations-step-detail"
      aria-label={`Step ${step.id}`}
    >
      <div className="automations-detail-section-head">
        <h3 className="automations-section-title">{stepHeading(record, run.dryRun === true)}</h3>
        <span className="automations-hint">
          {record.kind === 'agent' ? 'Agent step' : 'Command'} · {record.status}
          {record.kind === 'run' && ` · ${step.id}`}
        </span>
      </div>
      {attempts && <p className="automations-hint">{attempts}</p>}
      {record.skipped && <p className="automations-hint">{record.skipped}</p>}
      {record.error && <p className="automations-hint automations-step-error">{record.error}</p>}
      {detail.state === 'failed' && (
        <p className="automations-error" role="alert">
          Could not read this step: {detail.reason}
        </p>
      )}
      {record.kind === 'agent' ? (
        <AgentBody workspace={workspace} run={run} step={record} />
      ) : (
        <CommandBody
          run={run}
          step={record}
          detail={detail.state === 'ready' ? detail.value : null}
          loaded={detail.state === 'ready'}
        />
      )}
      <Outputs outputs={record.outputs} />
    </section>
  );
}

function Outputs({ outputs }: { outputs: StepRun['outputs'] }) {
  const entries = Object.entries(outputs ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="automations-step-block">
      <h4 className="automations-step-label">Outputs</h4>
      <ul className="automations-step-list">
        {entries.map(([name, value]) => (
          <li key={name}>
            <code className="automations-step-code">
              {name}: {String(value)}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The session, its transcript while it works and after, and the artifacts it wrote. */
function AgentBody({
  workspace,
  run,
  step,
}: {
  workspace: Workspace;
  run: RunRecord;
  step: StepRun;
}) {
  const ids = useId();
  const [expanded, setExpanded] = useState(false);
  const following = step.status === 'running';
  const now = useNow(following ? 1000 : null);
  const session = step.sessionId
    ? workspace.sessions.find((candidate) => candidate.id === step.sessionId)
    : undefined;
  const hasConversation = step.conversation !== undefined || step.sessionId !== undefined;
  const { conversation, error } = useRunConversation(run.id, hasConversation, following, step.id);
  const transcript = conversation?.readable ? conversation.conversation : null;
  // The transcript is drawn against this step alone, not the whole run.
  const scoped: RunRecord = {
    ...run,
    status: following ? 'running' : step.status === 'failed' ? 'failed' : 'completed',
    startedAt: step.startedAt ?? run.startedAt,
    finishedAt: step.finishedAt,
  };

  return (
    <>
      {step.sessionId && (
        <div className="automations-step-block">
          {session ? (
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              onClick={() => activateSession(workspace.id, session.id)}
            >
              <SquareTerminal size={12} aria-hidden="true" />
              Open session
            </button>
          ) : (
            <span className="automations-hint">Session removed</span>
          )}
        </div>
      )}
      {hasConversation && (
        <div className="automations-step-block">
          <h4 className="automations-step-label">Transcript</h4>
          {error && !conversation ? (
            <p className="automations-error" role="alert">
              Could not read its transcript: {error}
            </p>
          ) : !conversation ? (
            <p className="automations-hint">Reading its transcript…</p>
          ) : !conversation.readable ? (
            <p className="automations-hint">
              This harness’s transcripts can’t be read here. Open the session to see what it did.
            </p>
          ) : !transcript ? (
            <p className="automations-hint">
              {following
                ? 'Nothing in its transcript yet.'
                : 'Its transcript is no longer on disk.'}
            </p>
          ) : (
            <>
              {error && (
                <p className="automations-error" role="alert">
                  Could not read its transcript: {error}
                </p>
              )}
              <RunSteps
                run={scoped}
                entries={transcript.entries}
                truncated={transcript.truncated}
                now={now}
                idPrefix={ids}
                expanded={expanded}
                onExpand={() => setExpanded(true)}
              />
            </>
          )}
        </div>
      )}
      <Artifacts runId={run.id} step={step} />
    </>
  );
}

/** Artifacts by name and size; one opens in the sanitizing renderer under its label. */
function Artifacts({ runId, step }: { runId: string; step: StepRun }) {
  const [open, setOpen] = useState<{
    name: string;
    read: Read<{ content: string; bytes: number } | null>;
  } | null>(null);
  const requests = useRef(0);
  useEffect(
    () => () => {
      requests.current++;
    },
    [],
  );
  const artifacts = step.artifacts ?? [];
  if (artifacts.length === 0) return null;

  const show = (name: string) => {
    const request = ++requests.current;
    setOpen({ name, read: { state: 'loading' } });
    automationsBridge.readArtifact(runId, { step: step.id, name }).then(
      (value) => {
        if (request === requests.current) setOpen({ name, read: { state: 'ready', value } });
      },
      (failure: unknown) => {
        if (request === requests.current)
          setOpen({ name, read: { state: 'failed', reason: ipcErrorMessage(failure) } });
      },
    );
  };

  return (
    <div className="automations-step-block">
      <h4 className="automations-step-label">Artifacts</h4>
      <ul className="automations-step-list">
        {artifacts.map((artifact) => (
          <li key={artifact.name}>
            <button
              type="button"
              className="automations-link-button"
              onClick={() => show(artifact.name)}
            >
              {artifact.name}
            </button>{' '}
            <span className="automations-hint">{formatBytes(artifact.bytes)}</span>
          </li>
        ))}
      </ul>
      {open && (
        <div className="automations-step-artifact">
          <p className="automations-step-label">material from the run</p>
          {open.read.state === 'loading' ? (
            <p className="automations-hint">Reading {open.name}…</p>
          ) : open.read.state === 'failed' ? (
            <p className="automations-error" role="alert">
              Could not read {open.name}: {open.read.reason}
            </p>
          ) : open.read.value === null ? (
            <p className="automations-hint">{open.name} is no longer on disk.</p>
          ) : (
            <div className="automations-answer">
              <MarkdownRenderer
                content={open.read.value.content}
                enableCommandHighlighting={false}
                resolveImageSrc={dropImage}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A command's text exactly as written, where it ran, its variables, how it ended and what it printed. */
function CommandBody({
  run,
  step,
  detail,
  loaded,
}: {
  run: RunRecord;
  step: StepRun;
  detail: StepDetailData | null;
  loaded: boolean;
}) {
  const now = useNow(step.status === 'running' ? 1000 : null);
  const duration = durationOf(step, now);
  const command = detail?.command;
  const exit = step.command;
  const ended =
    exit?.signal !== undefined
      ? `Stopped by ${exit.signal}`
      : exit?.exitCode !== undefined
        ? `Exit code ${exit.exitCode}`
        : exit?.intentAt && step.status !== 'running'
          ? 'No exit recorded'
          : null;

  return (
    <>
      {command ? (
        <div className="automations-step-block">
          <h4 className="automations-step-label">Command</h4>
          <pre className="automations-prompt automations-step-command">{command.command}</pre>
          <p className="automations-hint">
            In <code className="automations-step-code">{command.cwd}</code>
          </p>
          {command.env.length > 0 && (
            <ul className="automations-step-list">
              {variableRows(command).map((row) => (
                <li key={row.name}>
                  {row.long ? (
                    <details className="automations-details">
                      <summary>
                        <code className="automations-step-code">
                          {row.name} = {row.template} →
                        </code>{' '}
                        <span className="automations-hint">a long value</span>
                      </summary>
                      <pre className="automations-prompt">{row.value}</pre>
                    </details>
                  ) : (
                    <code className="automations-step-code">
                      {row.name} = {row.template} → {row.value}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        loaded && <p className="automations-hint">Its command was not recorded.</p>
      )}
      {(ended || duration !== null) && (
        <p className="automations-hint">
          {[ended, duration !== null ? formatElapsed(duration) : null].filter(Boolean).join(' · ')}
        </p>
      )}
      {loaded && (
        <>
          <Log runId={run.id} step={step} stream="stdout" initial={detail?.stdout} />
          <Log runId={run.id} step={step} stream="stderr" initial={detail?.stderr} />
        </>
      )}
    </>
  );
}

/** One stream's tail as plain text, with Show all for the rest of the file. */
function Log({
  runId,
  step,
  stream,
  initial,
}: {
  runId: string;
  step: StepRun;
  stream: 'stdout' | 'stderr';
  initial: LogTail | undefined;
}) {
  // What Show all read; it wins only while the file is the size it was read at.
  const [full, setFull] = useState<LogTail | undefined>(undefined);
  const tail = visibleTail(initial, full);
  const [all, setAll] = useState<
    { state: 'idle' | 'loading' } | { state: 'failed'; reason: string } | { state: 'gone' }
  >({ state: 'idle' });
  const requests = useRef(0);
  useEffect(
    () => () => {
      requests.current++;
    },
    [],
  );

  const showAll = () => {
    const request = ++requests.current;
    setAll({ state: 'loading' });
    automationsBridge.readStepLog(runId, step.id, stream).then(
      (value) => {
        if (request !== requests.current) return;
        if (value === null) return setAll({ state: 'gone' });
        setFull(value);
        setAll({ state: 'idle' });
      },
      (failure: unknown) => {
        if (request === requests.current)
          setAll({ state: 'failed', reason: ipcErrorMessage(failure) });
      },
    );
  };

  const wrote = step.command?.[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'];
  const capped = logWasCapped(wrote);
  if (!tail && !wrote && all.state === 'idle') {
    return (
      <div className="automations-step-block">
        <h4 className="automations-step-label">{stream}</h4>
        <p className="automations-hint">Nothing on {stream}.</p>
      </div>
    );
  }

  return (
    <div className="automations-step-block">
      <h4 className="automations-step-label">{stream}</h4>
      {tail && <pre className="automations-prompt automations-step-log">{tail.text}</pre>}
      {tail?.truncated && (
        <p className="automations-hint">
          Showing the end of the log.{' '}
          <button
            type="button"
            className="automations-link-button"
            disabled={all.state === 'loading'}
            onClick={showAll}
          >
            {all.state === 'loading' ? 'Reading…' : 'Show all'}
          </button>
        </p>
      )}
      {capped && <p className="automations-hint">{LOG_CAPPED}</p>}
      {all.state === 'failed' && (
        <p className="automations-error" role="alert">
          Could not read its log: {all.reason}
        </p>
      )}
      {all.state === 'gone' && <p className="automations-hint">Its log is no longer on disk.</p>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
