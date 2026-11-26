import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
import { CallDetail, WouldCall } from './CallDetail';
import { RunSteps, useRunConversation } from './ConversationView';
import { useNow } from './parts';
import {
  agentFacts,
  artifactNote,
  artifactTitle,
  attemptsLine,
  conditionValues,
  deniedLine,
  diffMarkdown,
  earlierCosts,
  failureIsExit,
  formatBytes,
  logWasCapped,
  notRunReason,
  retryLine,
  runIsOver,
  skippedCondition,
  stepTone,
  turnLine,
  variableRows,
  visibleTail,
  writeRows,
} from './stepDetail';
import type { StepTone } from './stepDetail';

/** What a log read said when the file's own cap cut it short. */
export const LOG_CAPPED = 'The command wrote more than this; Consola kept the first 1 MB.';

/** An image in an artifact is never fetched: someone else's text could point it anywhere. */
const dropImage = () => undefined;

/** How often a running command's logs are read again. */
const LOG_FOLLOW_MS = 2000;

type Read<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'failed'; reason: string };

type Definition = StepDetailData['step'];

/**
 * One step's trace, read from its folder, as a column of labelled facts: a
 * command's exact text, where it ran, its variables with the values they
 * had, how it ended and what it printed; an agent's session and transcript;
 * the outputs and artifacts either left for the steps after it. A step that
 * did not run says why, and what it would have run.
 *
 * Opening it only reads. Logs, variables and outputs are text and are never
 * interpreted; an artifact goes through the sanitizing renderer alone. The
 * caller keys it by run and step, so a late answer for another step has
 * nowhere to land.
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
  // A command's logs, and a call's server log and answer, grow while it runs: read them again until it ends.
  const following = (step.kind === 'run' || step.kind === 'uses') && step.status === 'running';
  const tick = useNow(following ? LOG_FOLLOW_MS : null);
  const beat = following ? tick.getTime() : 0;

  // The record moves as the step does; read the folder again when it does.
  useEffect(() => {
    const request = ++requests.current;
    automationsBridge.getStepDetail(run.id, step.id).then(
      (value) => {
        if (request === requests.current) setDetail({ state: 'ready', value });
      },
      (failure: unknown) => {
        if (request === requests.current) {
          setDetail({ state: 'failed', reason: ipcErrorMessage(failure) });
        }
      },
    );
    return () => {
      requests.current++;
    };
  }, [run.id, step.id, step.status, step.attempt, step.finishedAt, beat]);

  const ready = detail.state === 'ready' ? detail.value : null;
  const record = ready?.record ?? step;
  const attempts = attemptsLine(record);
  const tone = stepTone(record, runIsOver(run.status));
  // Failed before it started (its `if:` could not be read, a value it needed was missing): nothing ran to trace.
  const failedEarly = tone === 'failed' && record.startedAt === undefined;
  const ran = (tone === 'passed' || tone === 'failed' || tone === 'running') && !failedEarly;

  return (
    <div className="automations-trace-detail">
      {attempts && <p className="automations-hint">{attempts}</p>}
      {detail.state === 'failed' && (
        <p className="automations-error" role="alert">
          Could not read this step: {detail.reason}
        </p>
      )}
      {tone === 'reported' && record.kind !== 'uses' && (
        <div className="automations-trace-note">
          <h4 className="automations-trace-note-title">Would have run</h4>
          <p className="automations-hint">
            A dry run reports what this command would do instead of running it.
          </p>
        </div>
      )}
      <dl className="automations-facts">
        {tone === 'failed' && !(record.kind === 'run' && failureIsExit(record.error)) && (
          <Fact label="Error">
            <p className="automations-fact-text automations-fact-bad">
              {record.error ?? 'It failed without saying why.'}
            </p>
          </Fact>
        )}
        {failedEarly && ready?.step && <WouldRun definition={ready.step} />}
        {!ran && !failedEarly && tone !== 'reported' && (
          <NotRunFacts run={run} step={record} tone={tone} definition={ready?.step} />
        )}
        {(ran || tone === 'reported') &&
          record.kind !== 'gate' &&
          (record.kind === 'agent' ? (
            <AgentFacts workspace={workspace} run={run} step={record} detail={ready} />
          ) : record.kind === 'uses' ? (
            <CallDetail step={record} detail={ready} loaded={detail.state === 'ready'} />
          ) : (
            <CommandFacts
              run={run}
              step={record}
              detail={ready}
              loaded={detail.state === 'ready'}
              reported={tone === 'reported'}
            />
          ))}
        <WriteFacts step={record} />
        <ChangesFact changes={ready?.changes} />
        <OutputsFact step={record} />
        <ArtifactsFact runId={run.id} step={record} paths={ready?.paths} />
      </dl>
    </div>
  );
}

/** One labelled fact of a step's trace: a quiet label, then what it was. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="automations-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A step that did not run: why — its `if:` and the values that made it
 * false, or where the run stopped — then what it would have run, as the
 * run's definition has it.
 */
function NotRunFacts({
  run,
  step,
  tone,
  definition,
}: {
  run: RunRecord;
  step: StepRun;
  tone: StepTone;
  definition: Definition | undefined;
}) {
  const condition = tone === 'skipped' ? skippedCondition(step.skipped) : null;
  const values = condition ? conditionValues(condition, run.steps ?? []) : [];
  return (
    <>
      <Fact
        label={tone === 'pending' || tone === 'waiting' || tone === 'retrying' ? 'Waits' : 'Why'}
      >
        {tone === 'skipped' ? (
          condition ? (
            <>
              <p className="automations-fact-text">Its condition was false, so it was skipped.</p>
              <code className="automations-fact-code">if: {condition}</code>
              {values.length > 0 && (
                <ul className="automations-fact-list">
                  {values.map((value) => (
                    <li key={value.ref}>
                      <code>{value.ref}</code>{' '}
                      {value.value === undefined ? (
                        'was not set'
                      ) : (
                        <>
                          was <code>{String(value.value)}</code>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="automations-fact-text">{step.skipped ?? 'It was skipped.'}</p>
          )
        ) : tone === 'waiting' ? (
          <p className="automations-fact-text">
            For a free agent slot. A few automation sessions work at once; the rest start in order.
          </p>
        ) : tone === 'retrying' ? (
          <>
            <p className="automations-fact-text">
              To try again by itself: it {step.error ? 'failed' : 'stopped'}, and its file lets it
              retry.
            </p>
            <p className="automations-fact-text">{retryLine(step, definition)}</p>
            {step.error && (
              <p className="automations-fact-text automations-fact-bad">{step.error}</p>
            )}
          </>
        ) : tone === 'pending' ? (
          <p className="automations-fact-text">It starts once the steps before it are done.</p>
        ) : (
          <p className="automations-fact-text">{notRunReason(run, step)}</p>
        )}
      </Fact>
      {definition && <WouldRun definition={definition} />}
    </>
  );
}

/** What a step that did not run would have run: its command and variables as written, its call, or its prompt; a gate's question. */
function WouldRun({ definition }: { definition: Definition }) {
  if (definition.kind === 'uses') return <WouldCall definition={definition} />;
  if (definition.kind === 'gate') {
    return (
      <Fact label="Would ask">
        <p className="automations-fact-text">{definition.ask}</p>
      </Fact>
    );
  }
  if (definition.kind === 'run') {
    const env = Object.entries(definition.env);
    return (
      <>
        <Fact label="Would run">
          <pre className="automations-prompt automations-fact-pre">{definition.run}</pre>
        </Fact>
        {env.length > 0 && (
          <Fact label="Env">
            <ul className="automations-vars">
              {env.map(([name, template]) => (
                <li key={name}>
                  <span className="automations-var-name">
                    <code>{name}</code>
                    <span className="automations-var-eq"> = </span>
                  </span>
                  <code className="automations-var-value">{template}</code>
                </li>
              ))}
            </ul>
          </Fact>
        )}
      </>
    );
  }
  return (
    <Fact label="Would run">
      {definition.action !== undefined ? (
        <p className="automations-fact-text">
          The action <code>{definition.action}</code>, in a read-only session.
        </p>
      ) : (
        <pre className="automations-prompt automations-fact-pre">{definition.prompt ?? ''}</pre>
      )}
    </Fact>
  );
}

/**
 * A step in a run's own checkout (slice 3-B): its environment and how it is
 * held, the Claude version it ran under, the variables it got and lacked,
 * its commits and flagged paths. Nothing for any other step.
 */
function WriteFacts({ step }: { step: StepRun }) {
  return (
    <>
      {writeRows(step).map(([label, value]) => (
        <Fact key={label} label={label}>
          <p className="automations-fact-text">{value}</p>
        </Fact>
      ))}
    </>
  );
}

/**
 * What a write step's failed attempt changed, kept as its `changes.patch`
 * and never committed (slice 3-B): opens in place as a diff, in the
 * sanitizing renderer. Nothing when no attempt kept one.
 */
function ChangesFact({ changes }: { changes: StepDetailData['changes'] }) {
  const [open, setOpen] = useState(false);
  if (!changes) return null;
  return (
    <Fact label="Changes it made">
      <button
        type="button"
        className="automations-link-button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        changes.patch
      </button>{' '}
      <span className="automations-fact-note">
        {formatBytes(changes.bytes)} · attempt {changes.attempt}, kept and not committed
        {changes.truncated ? ' · showing its end' : ''}
      </span>
      {open && (
        <div className="automations-step-artifact">
          <div className="automations-answer">
            <MarkdownRenderer
              content={diffMarkdown(changes.text)}
              enableCommandHighlighting={false}
              resolveImageSrc={dropImage}
            />
          </div>
        </div>
      )}
    </Fact>
  );
}

/** The outputs a step set, as `name = value`, and how a later step reads them. */
function OutputsFact({ step }: { step: StepRun }) {
  const entries = Object.entries(step.outputs ?? {});
  if (entries.length === 0) return null;
  return (
    <Fact label="Outputs">
      <ul className="automations-vars">
        {entries.map(([name, value]) => (
          <li key={name}>
            <span className="automations-var-name">
              <code>{name}</code>
              <span className="automations-var-eq"> = </span>
            </span>
            <code className="automations-var-value">{String(value)}</code>
          </li>
        ))}
      </ul>
      <p className="automations-fact-note">
        Later steps read {entries.length === 1 ? 'it' : 'them'} as{' '}
        <code>
          steps.{step.id}.{entries.length === 1 ? entries[0][0] : '<name>'}
        </code>
      </p>
    </Fact>
  );
}

/**
 * What the CLI reported of the step's turns: the latest attempt's turns,
 * cost and model, what earlier attempts cost, the tools it was refused.
 * Each line only when it was reported; nothing at all when none was.
 */
function TurnFact({ step }: { step: StepRun }) {
  const turns = turnLine(step);
  const earlier = earlierCosts(step);
  const denied = deniedLine(step);
  if (turns === null && earlier === null && denied === null) return null;
  return (
    <Fact label="Turn">
      {turns !== null && <p className="automations-fact-text">{turns}</p>}
      {earlier !== null && <p className="automations-fact-text">{earlier}</p>}
      {denied !== null && <p className="automations-fact-text">{denied}</p>}
    </Fact>
  );
}

/**
 * The agent a step ran as, and the harness its conversation is on when it
 * has one (`reviewer · stub-personal`); nothing for a step with no agent.
 * The model is the Turn fact's, as the CLI reported it.
 */
function AgentFact({ step }: { step: StepRun }) {
  if (step.agent === undefined) return null;
  const harness = step.conversation?.harnessId;
  return (
    <Fact label="Agent">
      <p className="automations-fact-text">
        {step.agent}
        {harness !== undefined ? ` · ${harness}` : ''}
      </p>
    </Fact>
  );
}

/** An agent step's servers and skills, as its run's definition holds its agent; nothing when it names neither. */
function GrantFacts({ detail }: { detail: StepDetailData | null }) {
  if (!detail) return null;
  return (
    <>
      {agentFacts(detail).map((fact) => (
        <Fact key={fact.label} label={fact.label}>
          <p className="automations-fact-text">{fact.value}</p>
        </Fact>
      ))}
    </>
  );
}

/** The agent, the session, what its turns reported, its transcript while it works and after. */
function AgentFacts({
  workspace,
  run,
  step,
  detail,
}: {
  workspace: Workspace;
  run: RunRecord;
  step: StepRun;
  /** The step's detail once read: its agent's servers and skills. */
  detail: StepDetailData | null;
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

  if (!hasConversation) {
    return (
      <>
        <AgentFact step={step} />
        <GrantFacts detail={detail} />
        <Fact label="Session">
          <p className="automations-fact-text">
            {following ? 'Starting its session…' : 'It never started a session.'}
          </p>
        </Fact>
        <TurnFact step={step} />
      </>
    );
  }

  return (
    <>
      <AgentFact step={step} />
      <GrantFacts detail={detail} />
      <Fact label="Session">
        <div className="automations-fact-inline">
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
            <span className="automations-fact-text">Session removed</span>
          )}
          <span className="automations-fact-note">
            {step.tools === undefined
              ? 'A read-only session'
              : `A session that writes, ${step.environment?.isolation === 'sandbox' ? 'sandboxed' : 'on host, a convention'}`}
          </span>
        </div>
      </Fact>
      <TurnFact step={step} />
      <Fact label="Transcript">
        {error && !conversation ? (
          <p className="automations-error" role="alert">
            Could not read its transcript: {error}
          </p>
        ) : !conversation ? (
          <p className="automations-fact-text automations-fact-quiet">Reading its transcript…</p>
        ) : !conversation.readable ? (
          <p className="automations-fact-text automations-fact-quiet">
            This harness’s transcripts can’t be read here. Open the session to see what it did.
          </p>
        ) : !transcript ? (
          <p className="automations-fact-text automations-fact-quiet">
            {following ? 'Nothing in its transcript yet.' : 'Its transcript is no longer on disk.'}
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
      </Fact>
    </>
  );
}

/** Artifacts by name and size, and what each is for; one opens in place, in the sanitizing renderer. */
function ArtifactsFact({
  runId,
  step,
  paths,
}: {
  runId: string;
  step: StepRun;
  /** Its path artifacts' paths (slice 3-B), for their titles. */
  paths?: StepDetailData['paths'];
}) {
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

  const toggle = (name: string) => {
    const request = ++requests.current;
    if (open?.name === name) {
      setOpen(null);
      return;
    }
    setOpen({ name, read: { state: 'loading' } });
    automationsBridge.readArtifact(runId, { step: step.id, name }).then(
      (value) => {
        if (request === requests.current) setOpen({ name, read: { state: 'ready', value } });
      },
      (failure: unknown) => {
        if (request === requests.current) {
          setOpen({ name, read: { state: 'failed', reason: ipcErrorMessage(failure) } });
        }
      },
    );
  };

  return (
    <Fact label="Artifacts">
      <ul className="automations-fact-list">
        {artifacts.map((artifact) => {
          const note = artifactNote(artifact.name, step.kind);
          return (
            <li key={artifact.name}>
              <button
                type="button"
                className="automations-link-button"
                aria-expanded={open?.name === artifact.name}
                onClick={() => toggle(artifact.name)}
              >
                {artifactTitle(artifact.name, paths)}
              </button>{' '}
              <span className="automations-fact-note">
                {formatBytes(artifact.bytes)}
                {note ? ` · ${note}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {open && (
        <div className="automations-step-artifact">
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
    </Fact>
  );
}

/** A command's text exactly as written, where it ran, its variables, how it ended and what it printed. */
function CommandFacts({
  run,
  step,
  detail,
  loaded,
  reported,
}: {
  run: RunRecord;
  step: StepRun;
  detail: StepDetailData | null;
  loaded: boolean;
  reported: boolean;
}) {
  const command = detail?.command;
  const exit = step.command;
  const running = step.status === 'running';
  const ended =
    exit?.signal !== undefined
      ? `Stopped by ${exit.signal}`
      : exit?.exitCode !== undefined
        ? `Exit code ${exit.exitCode}`
        : running
          ? 'Still running…'
          : exit?.intentAt
            ? 'No exit recorded'
            : null;
  const printed = (tail: LogTail | undefined, bytes: number | undefined) =>
    Boolean(tail?.text) || (bytes ?? 0) > 0;
  const hasStdout = printed(detail?.stdout, exit?.stdoutBytes);
  const hasStderr = printed(detail?.stderr, exit?.stderrBytes);

  return (
    <>
      {command ? (
        <>
          <Fact label="Command">
            <pre className="automations-prompt automations-fact-pre">{command.command}</pre>
            <p className="automations-fact-note">
              in <code>{command.cwd}</code>
            </p>
          </Fact>
          {(command.env.length > 0 || (command.secrets?.length ?? 0) > 0) && (
            <Fact label="Env">
              <ul className="automations-vars">
                {variableRows(command).map((row) => (
                  <li key={row.name}>
                    <span className="automations-var-name">
                      <code>{row.name}</code>
                      <span className="automations-var-eq"> = </span>
                    </span>
                    {/* A secret's row says where it was bound when the step ran: it has no value to show. */}
                    {row.secret ? (
                      <span className="automations-var-secret">{row.value}</span>
                    ) : row.long ? (
                      <pre className="automations-prompt automations-var-block">{row.value}</pre>
                    ) : (
                      <code className="automations-var-value">{row.value}</code>
                    )}
                    {row.templated && (
                      <span className="automations-var-from">
                        from <code>{row.template}</code>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Fact>
          )}
        </>
      ) : (
        loaded && (
          <Fact label="Command">
            <p className="automations-fact-text automations-fact-quiet">
              Its command was not recorded.
            </p>
          </Fact>
        )
      )}
      {!reported && ended && (
        <Fact label="Result">
          <p
            className={`automations-fact-text ${exit?.exitCode !== undefined && exit.exitCode !== 0 ? 'automations-fact-bad' : ''}`}
          >
            {ended}
          </p>
        </Fact>
      )}
      {loaded && !reported && (
        <>
          {hasStdout && (
            <Fact label="stdout">
              <Log runId={run.id} step={step} stream="stdout" initial={detail?.stdout} />
            </Fact>
          )}
          {hasStderr && (
            <Fact label="stderr">
              <Log runId={run.id} step={step} stream="stderr" initial={detail?.stderr} />
            </Fact>
          )}
          {!hasStdout && !hasStderr && (
            <Fact label="Output">
              <p className="automations-fact-text automations-fact-quiet">
                {running ? 'Nothing printed yet.' : 'It printed nothing.'}
              </p>
            </Fact>
          )}
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
        if (request === requests.current) {
          setAll({ state: 'failed', reason: ipcErrorMessage(failure) });
        }
      },
    );
  };

  const wrote = step.command?.[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'];
  const capped = logWasCapped(wrote);

  return (
    <>
      {tail?.text ? (
        <pre
          className={`automations-prompt automations-fact-pre automations-log automations-log-${stream}`}
        >
          {tail.text}
        </pre>
      ) : (
        step.status !== 'running' && (
          <p className="automations-fact-text automations-fact-quiet">
            Its log is no longer on disk.
          </p>
        )
      )}
      {tail?.truncated && (
        <p className="automations-fact-note">
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
      {capped && <p className="automations-fact-note">{LOG_CAPPED}</p>}
      {all.state === 'failed' && (
        <p className="automations-error" role="alert">
          Could not read its log: {all.reason}
        </p>
      )}
      {all.state === 'gone' && (
        <p className="automations-fact-note">Its log is no longer on disk.</p>
      )}
    </>
  );
}
