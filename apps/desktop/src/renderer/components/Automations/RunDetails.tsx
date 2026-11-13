import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Copy,
  GitFork,
  RotateCcw,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import { isAgentRunPreview, type RunListEntry, type RunRecord } from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { workspaceBridge } from '../../services/workspaceBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { activateSession } from '../../utils/sessionActions';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { brokenStep, RunAnswer, RunSteps, stepRowId, useRunConversation } from './ConversationView';
import { RunGraph } from './RunGraph';
import { AgentRunDetails, CleanupDetails, RunItemLink, StatusIcon, useIntent, useNow } from './parts';
import {
  filterRuns,
  finalAnswer,
  formatAgo,
  formatDuration,
  formatElapsed,
  formatTime,
  NO_RUN_FILTER,
  runStage,
  statusLabel,
  triggerInWords,
} from './presentation';
import {
  adjacentRuns,
  durationAgainstUsual,
  runNotes,
  runStages,
  type RunStage,
  type RunStageKey,
} from './runPage';

const NO_RUNS: RunListEntry[] = [];

/**
 * One run, whole, in the side panel, laid out as a CI service lays out one
 * run of a pipeline: how it ended and what to do about it, its facts, the
 * stages it went through with the one it stopped in marked, what broke,
 * and then what it did — its steps on a timeline and its answer, or a
 * tool's output.
 *
 * Read with `getRun` — the activity list carries only a summary — and read
 * again whenever main says the run changed. Showing it never starts,
 * resumes or attaches to anything: only Start, Approve, Run again, Open
 * session and Continue with full tools do, and only when pressed.
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

/** A run still moving: its clock ticks by the second. */
const LIVE = new Set<RunRecord['status']>(['running', 'queued', 'needs-approval']);

function RunView({ workspace, run }: { workspace: Workspace; run: RunRecord }) {
  const snapshot = useAutomationsStore((state) => state.snapshots[workspace.id]);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const { busy, error, act } = useIntent();
  const now = useNow(LIVE.has(run.status) ? 1000 : 30_000);
  const ids = useId();
  const sectionId = (name: string) => `${ids}-${name}`;
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const landed = useLanded(run.status);

  const stage = runStage(run);
  const preview = isAgentRunPreview(run.result) ? run.result : null;
  // A session ran it, so there is a transcript to read — even once the session is removed.
  const hasSession = Boolean(run.conversation || run.sessionId);
  const session = run.sessionId ? workspace.sessions.find((candidate) => candidate.id === run.sessionId) : undefined;
  const showsSteps = hasSession && (stage === 'agent-running' || stage === 'agent-finished');
  const { conversation, error: conversationError } = useRunConversation(run.id, showsSteps, stage === 'agent-running');
  const transcript = conversation?.readable ? conversation.conversation : null;
  const entries = transcript?.entries ?? [];

  const place = snapshot?.queue[run.id];
  const history = filterRuns(snapshot?.runs ?? NO_RUNS, { ...NO_RUN_FILTER, automation: run.automationId }, now);
  const automation = run.source === 'manual' ? undefined : snapshot?.automations.find((entry) => entry.name === run.automationId);
  const stages = runStages(run, now);
  const stopped = stages.find((candidate) => candidate.state === 'failed');
  const broken = brokenStep(entries, run);
  const asker =
    run.trigger.by === 'agent' && run.trigger.actorId
      ? workspace.sessions.find((candidate) => candidate.id === run.trigger.actorId)?.name
      : undefined;

  const reveal = (id: string) => revealElement(id);
  // A step inside the fold shows once the list has unfolded around it.
  useEffect(() => {
    if (pendingReveal === null) return;
    revealElement(pendingReveal);
    setPendingReveal(null);
  }, [pendingReveal]);
  const revealStep = (index: number) => {
    setStepsExpanded(true);
    setPendingReveal(stepRowId(ids, index));
  };

  const hasOutput = stage === 'tool' && run.status !== 'needs-approval' && hasCleanupData(run.result);
  const targets: Partial<Record<RunStageKey, string>> = {
    ...(stopped ? { [stopped.key]: sectionId('problem') } : {}),
    ...(run.status === 'needs-approval' ? { approval: sectionId('approval') } : {}),
    ...(stage === 'agent-queued' ? { queue: sectionId('queue') } : {}),
    ...(showsSteps && !stopped ? { run: sectionId('steps') } : {}),
    ...(hasOutput && !stopped ? { run: sectionId('output') } : {}),
  };

  return (
    <div className="automations-detail automations-run">
      <div className="automations-lead">
        <RunLead run={run} now={now} place={place} history={history} landed={landed} />
        <div className="automations-lead-actions">
          {stage === 'agent-queued' && (
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              disabled={busy !== null}
              onClick={() => void act('dismiss', () => automationsBridge.dismiss(run.id))}
            >
              <X size={12} aria-hidden="true" />
              {busy === 'dismiss' ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {stage === 'agent-running' && <StopButton runId={run.id} />}
          {stage === 'agent-finished' && session && (
            <>
              <button
                type="button"
                className="dialog-button-secondary automations-small-button"
                onClick={() => activateSession(workspace.id, session.id)}
              >
                <SquareTerminal size={12} aria-hidden="true" />
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
                <GitFork size={12} aria-hidden="true" />
                {busy === 'fork' ? 'Continuing…' : 'Continue with full tools'}
              </button>
            </>
          )}
          {automation && !automation.onEvent && !LIVE.has(run.status) && (
            <button
              type="button"
              className="dialog-button-secondary automations-small-button"
              disabled={
                busy !== null ||
                Boolean(automation.problem) ||
                history.some((candidate) => candidate.status === 'running' || candidate.status === 'queued')
              }
              title={
                automation.problem
                  ? `Not running: ${automation.problem}`
                  : automation.mode === 'auto' && !automation.asksFirst
                    ? 'Run it again now'
                    : 'Preview it again now; nothing changes until you approve'
              }
              onClick={() =>
                void act('rerun', async () => {
                  const next = await automationsBridge.runNow(workspace.id, run.automationId);
                  if (next) openPanel({ kind: 'run', runId: next.id });
                })
              }
            >
              <RotateCcw size={12} aria-hidden="true" />
              {busy === 'rerun' ? 'Starting…' : 'Run again'}
            </button>
          )}
          <RunNav runId={run.id} history={history} onOpen={(runId) => openPanel({ kind: 'run', runId })} />
        </div>
      </div>

      {error && (
        <div className="automations-error" role="alert">
          {error}
        </div>
      )}

      <RunStats run={run} now={now} history={history} stages={stages} askerName={asker} sessionGone={hasSession && !session} />

      <section className="automations-detail-section" aria-label="Stages">
        <RunGraph
          run={run}
          stages={stages}
          place={place}
          askerName={asker}
          schedule={automation?.schedule ? automation.trigger : undefined}
          targets={targets}
          onReveal={reveal}
        />
      </section>

      {stopped && (
        <div id={sectionId('problem')} tabIndex={-1} className="automations-annotation" role="note">
          <CircleX size={16} aria-hidden="true" />
          <div className="automations-annotation-body">
            <strong>{failureTitle(stopped, Boolean(preview))}</strong>
            <p className="automations-annotation-message">{run.error ?? 'It failed without saying why.'}</p>
            {broken && (
              <button type="button" className="automations-annotation-step" onClick={() => revealStep(broken.index)}>
                <span className="automations-annotation-step-label">{broken.cut ? 'Stopped during' : 'Last failed step'}</span>
                <code>
                  {broken.step.tool}
                  {broken.step.detail ? ` ${broken.step.detail}` : ''}
                </code>
                <ArrowRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}

      {run.status === 'needs-approval' && (
        <Section id={sectionId('approval')} title="Waiting for your approval">
          {preview ? (
            <>
              {run.trigger.item && run.summary && <p className="automations-summary">{run.summary}</p>}
              <AgentRunDetails preview={preview} />
            </>
          ) : (
            <CleanupDetails result={run.result} />
          )}
          <div className="automations-card-actions">
            <button
              type="button"
              className="dialog-button-primary automations-small-button"
              disabled={busy !== null}
              onClick={() => void act('approve', () => automationsBridge.approve(run.id))}
            >
              {preview ? (busy === 'approve' ? 'Starting…' : 'Start') : busy === 'approve' ? 'Running…' : 'Approve'}
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
            {preview
              ? 'Starting opens a read-only session with exactly this prompt: it can read the code and the change, and cannot run it or act on GitHub. It waits its turn if other automation sessions are working.'
              : 'Approving acts only on what is listed, checking each again first. Ignored files in a removed worktree (build output, dependencies, local env files) go with it.'}
          </p>
        </Section>
      )}

      {stage === 'agent-queued' && preview && (
        <Section id={sectionId('queue')} title={place !== undefined ? `${place} in line` : 'Waiting to start'}>
          <p className="automations-hint">
            A few automation sessions work at once, across every workspace; the rest start in order as those finish or
            stop to wait for you.
          </p>
          <details className="automations-details">
            <summary>The prompt it will send</summary>
            <pre className="automations-prompt">{preview.prompt}</pre>
          </details>
        </Section>
      )}

      {stage === 'agent-running' && !hasSession && <p className="automations-hint">Starting its session…</p>}

      {showsSteps && (
        <Section id={sectionId('steps')} title="Steps">
          {conversationError && !conversation ? (
            <div className="automations-error" role="alert">
              {conversationError}
            </div>
          ) : !conversation ? (
            <p className="automations-hint">Reading its transcript…</p>
          ) : !conversation.readable ? (
            <p className="automations-hint">This harness’s transcripts can’t be read here. Open the session to see what it did.</p>
          ) : !transcript ? (
            <p className="automations-hint">
              {stage === 'agent-running' ? 'Nothing in its transcript yet.' : 'Its transcript is no longer on disk.'}
            </p>
          ) : (
            <RunSteps
              run={run}
              entries={transcript.entries}
              truncated={transcript.truncated}
              now={now}
              idPrefix={ids}
              expanded={stepsExpanded}
              onExpand={() => setStepsExpanded(true)}
            />
          )}
        </Section>
      )}

      {showsSteps && transcript && (
        <AnswerSection entries={transcript.entries} following={stage === 'agent-running'} id={sectionId('answer')} />
      )}

      {stage === 'agent-unstarted' && preview && (
        <Section id={sectionId('prompt')} title="What it would have started">
          <AgentRunDetails preview={preview} />
        </Section>
      )}

      {hasOutput && (
        <Section id={sectionId('output')} title="Output">
          <CleanupDetails result={run.result} />
        </Section>
      )}
    </div>
  );
}

/**
 * How the run ended, said once and large, with when and how long; under it,
 * what it was about, and notes against the automation's other runs. The
 * icon settles in once when a run being watched lands.
 */
function RunLead({
  run,
  now,
  place,
  history,
  landed,
}: {
  run: RunRecord;
  now: Date;
  place: number | undefined;
  history: RunListEntry[];
  landed: boolean;
}) {
  const duration = run.startedAt ? formatDuration(run, now) : null;
  const ended = run.finishedAt ?? run.updatedAt;
  const detail =
    run.status === 'running'
      ? `for ${duration ?? '0s'}`
      : run.status === 'queued'
        ? place !== undefined
          ? `${place} in line`
          : formatAgo(run.createdAt, now)
        : run.status === 'needs-approval'
          ? `asked ${formatAgo(run.createdAt, now)}`
          : [duration ? `${run.status === 'failed' ? 'after' : 'in'} ${duration}` : null, formatAgo(ended, now)]
              .filter(Boolean)
              .join(' · ');
  const notes = runNotes(run, history);
  const preview = isAgentRunPreview(run.result) ? run.result : null;
  // An agent run's own summary repeats what the page shows ("Running in …", "Ready in …").
  const summary = !preview || runStage(run) === 'agent-unstarted' || LIVE.has(run.status) ? run.summary : undefined;

  return (
    <div className="automations-lead-state">
      <span className={`automations-run-lead-icon ${landed ? 'automations-landed' : ''}`}>
        <StatusIcon status={run.status} size={22} />
      </span>
      <div className="automations-lead-text">
        <p className="automations-lead-headline">
          <span className={`automations-run-status automations-tone-${run.status}`}>{statusLabel(run.status)}</span>
          <span className="automations-lead-when" title={formatTime(ended)}>
            {detail}
          </span>
        </p>
        {run.trigger.item ? (
          <p className="automations-run-about">
            <RunItemLink run={run} />
            {preview?.item?.author ? <span className="automations-run-about-quiet"> by @{preview.item.author}</span> : null}
          </p>
        ) : (
          summary && <p className="automations-run-about">{summary}</p>
        )}
        {notes.length > 0 && (
          <p className="automations-run-notes">
            {notes.map((note) => (
              <span key={note.text} className={`automations-note automations-note-${note.tone}`}>
                {note.text}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The run's facts in a row, as GitHub Actions heads a run: what fired it,
 * when it started, how long it took against its usual, how long it waited
 * and for whom, and the session it ran in.
 */
function RunStats({
  run,
  now,
  history,
  stages,
  askerName,
  sessionGone,
}: {
  run: RunRecord;
  now: Date;
  history: RunListEntry[];
  stages: RunStage[];
  askerName?: string;
  sessionGone: boolean;
}) {
  const harnessName = useHarnessStore(
    (state) => state.harnesses.find((harness) => harness.id === run.conversation?.harnessId)?.name
  );
  const [copied, copy] = useCopied();
  const duration = run.startedAt ? formatDuration(run, now) : null;
  const usual = durationAgainstUsual(run, history, now);
  const forYou = stages.find((stage) => stage.key === 'approval')?.ms ?? null;
  const inLine = stages.find((stage) => stage.key === 'queue')?.ms ?? null;
  const waitedBefore = run.startedAt ? Date.parse(run.startedAt) - Date.parse(run.createdAt) : NaN;
  const waitParts = [
    forYou !== null && forYou >= 1000 ? `${formatElapsed(forYou)} for you` : null,
    inLine !== null && inLine >= 1000 ? `${formatElapsed(inLine)} in line` : null,
  ].filter((part): part is string => part !== null);
  const waited =
    waitParts.length > 0
      ? { value: formatElapsed((forYou ?? 0) + (inLine ?? 0)), sub: waitParts.join(' · ') }
      : forYou === null && inLine === null && waitedBefore >= 1000
        ? { value: formatElapsed(waitedBefore), sub: 'before it started' }
        : null;
  const started = run.startedAt ? new Date(run.startedAt) : null;

  return (
    <dl className="automations-run-stats">
      <Stat label="Triggered" value={triggerInWords(run)}>
        <span title={formatTime(run.trigger.at)}>{formatTime(run.trigger.at)}</span>
        {askerName && <span> · {askerName}</span>}
      </Stat>
      <Stat
        label="Started"
        value={started ? started.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
      >
        {started ? dayWords(started, now) : notStartedWords(run)}
      </Stat>
      <Stat label="Duration" value={duration ?? '—'} tone={usual?.tone === 'slow' ? 'slow' : undefined}>
        {usual ? usual.text : run.status === 'running' ? 'and counting' : null}
      </Stat>
      {waited && (
        <Stat label="Waited" value={waited.value}>
          {waited.sub}
        </Stat>
      )}
      {run.conversation && (
        <Stat label="Session" value={`${harnessName ?? run.conversation.harnessId} · read-only`}>
          {sessionGone ? 'Session removed' : run.conversation.cwd && <span className="automations-run-stat-path">{run.conversation.cwd}</span>}
        </Stat>
      )}
      <Stat label="Run" value={<span className="automations-run-stat-id">{run.id.slice(0, 8)}</span>}>
        <button
          type="button"
          className="automations-link-button automations-run-copy"
          onClick={() => copy(run.id)}
          aria-label={copied ? 'Copied the run ID' : 'Copy the run ID'}
        >
          {copied ? <Check size={11} className="automations-copied" aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy ID'}
        </button>
      </Stat>
    </dl>
  );
}

function Stat({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: ReactNode;
  tone?: 'slow';
  children?: ReactNode;
}) {
  return (
    <div className={`automations-run-stat ${tone ? `automations-run-stat-${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>
        <span className="automations-run-stat-value">{value}</span>
        {children ? <span className="automations-run-stat-sub">{children}</span> : null}
      </dd>
    </div>
  );
}

/** A section of the run page, headed, and a place a stage can link to. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} tabIndex={-1} className="automations-detail-section automations-run-section" aria-labelledby={`${id}-title`}>
      <div className="automations-detail-section-head">
        <h3 id={`${id}-title`} className="automations-section-title">
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

/**
 * The agent's closing answer: what it wrote after its last step. While it
 * works, that is only its latest message, so it says so, or that it is
 * still working.
 */
function AnswerSection({ entries, following, id }: { entries: ConversationEntry[]; following: boolean; id: string }) {
  if (finalAnswer(entries).answer === null) {
    return following ? <p className="automations-hint automations-following">Working…</p> : null;
  }
  return (
    <Section id={id} title={following ? 'Latest message' : 'Answer'}>
      <RunAnswer entries={entries} />
    </Section>
  );
}

/** Older and newer runs of the same automation, as a CI run page steps between runs. */
function RunNav({ runId, history, onOpen }: { runId: string; history: RunListEntry[]; onOpen: (runId: string) => void }) {
  const { newer, older } = adjacentRuns(runId, history);
  if (!newer && !older) return null;
  return (
    <div className="automations-run-nav" role="group" aria-label="Other runs of this automation">
      <button
        type="button"
        className="automations-icon-button"
        aria-label="Older run"
        title="Older run"
        disabled={!older}
        onClick={() => older && onOpen(older)}
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type="button"
        className="automations-icon-button"
        aria-label="Newer run"
        title="Newer run"
        disabled={!newer}
        onClick={() => newer && onOpen(newer)}
      >
        <ChevronRight size={14} />
      </button>
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
        <Square size={11} aria-hidden="true" />
        {stopping || busy === 'stop' ? 'Stopping…' : 'Stop'}
      </button>
      {error && <div className="automations-error" role="alert">{error}</div>}
    </>
  );
}

/** What broke, by the stage it broke in. */
function failureTitle(stage: RunStage, agent: boolean): string {
  switch (stage.key) {
    case 'run':
      return agent ? 'Failed in its session' : 'Failed while running';
    case 'approval':
      return 'Not run when approved';
    case 'queue':
      return 'Could not start';
    case 'preview':
      return 'Failed while previewing';
    default:
      return 'Failed';
  }
}

/** Why a run has no start, in a word or two. */
function notStartedWords(run: RunRecord): string {
  if (run.status === 'needs-approval') return 'when you approve';
  if (run.status === 'queued') return 'when a slot frees';
  if (run.mode === 'notify') return 'only told you';
  if (run.status === 'completed') return 'nothing to do';
  return 'never started';
}

/** "Today", "Yesterday", or the date, for a time already shown. */
function dayWords(at: Date, now: Date): string {
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function hasCleanupData(result: unknown): boolean {
  return typeof result === 'object' && result !== null && Array.isArray((result as { skipped?: unknown }).skipped);
}

/**
 * True for a moment when the run being watched lands — it was moving, and
 * now it completed — so its status can settle in once. A failure gets no
 * flourish; it gets the annotation.
 */
function useLanded(status: RunRecord['status']): boolean {
  const previous = useRef(status);
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status !== 'completed' || !LIVE.has(was)) return;
    setLanded(true);
    const timer = setTimeout(() => setLanded(false), 900);
    return () => clearTimeout(timer);
  }, [status]);
  return landed;
}

/** A copy button's "Copied" for a moment after it copies. */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    });
  };
  return [copied, copy];
}

/**
 * Scroll a section of the panel into view, move focus to it, and light it
 * briefly, so the eye lands where a stage pointed. Instant when the person
 * asked for less motion.
 */
function revealElement(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  element.focus({ preventScroll: true });
  element.classList.remove('automations-flash');
  // Restart the animation when the same place is shown twice in a row.
  void element.offsetWidth;
  element.classList.add('automations-flash');
  element.addEventListener('animationend', () => element.classList.remove('automations-flash'), { once: true });
}
