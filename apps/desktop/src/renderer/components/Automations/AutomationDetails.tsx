import { useEffect, useId, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarDays,
  ChevronRight,
  CircleDashed,
  FileCode,
  Hand,
  Timer,
  Workflow,
} from 'lucide-react';
import type { AutomationView, RunListEntry } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { AutomationInsights } from './AutomationInsights';
import { EntrySource, PipelineGraph } from './AutomationPipeline';
import { RunNowButton, StatusIcon, useArrivals, useArrivedOnMount, useIntent, useNow } from './parts';
import {
  filterRuns,
  formatAgo,
  formatCountdown,
  formatDueAt,
  formatDuration,
  formatTime,
  latestRun,
  NO_RUN_FILTER,
  runAbout,
  runInsights,
  statusLabel,
  triggerInWords,
  type LatestRun,
  type RunInsights,
} from './presentation';

/** Runs listed under an automation; the rest are in Activity. */
const RUNS_SHOWN = 30;

const NO_RUNS: RunListEntry[] = [];

/**
 * One automation from factory.yml, laid out as a CI service lays out a
 * pipeline: how it is doing and what to do about it, the pipeline itself
 * (as a graph, or as written), its last 30 days, and its runs.
 *
 * Each fact has one place. The lead says how the latest run went; the graph
 * says what fires it, what stands between, what runs, and what is live now;
 * the numbers sum the month up; the list names every run.
 * Opening it is the person seeing an agent-added entry, so it stops being new.
 */
export function AutomationDetails({ workspace, name }: { workspace: Workspace; name: string }) {
  const snapshot = useAutomationsStore((state) => state.snapshots[workspace.id]);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const showAutomationRuns = useAutomationsStore((state) => state.showAutomationRuns);
  const { busy, error, act } = useIntent();
  const [view, setView] = useState<'graph' | 'yaml'>('graph');
  const pipelineHeading = useId();
  const insightsHeading = useId();
  const runsHeading = useId();
  const allRuns = snapshot?.runs ?? NO_RUNS;
  const arrivals = useArrivals(allRuns);
  // A run working counts its duration in seconds; the countdown needs only the minute.
  const now = useNow(allRuns.some((run) => run.automationId === name && run.status === 'running') ? 1000 : 30_000);
  const automation = snapshot?.automations.find((candidate) => candidate.name === name);
  const isNew = automation?.addedBy?.isNew ?? false;

  useEffect(() => {
    if (!isNew) return;
    automationsBridge.acknowledge(workspace.id, name).catch((failure: unknown) => {
      // Only the "New" marker rides on it; it stays until the next open.
      console.error('automations acknowledge failed:', failure);
    });
  }, [workspace.id, name, isNew]);

  if (!snapshot) return <p className="automations-hint">Loading…</p>;
  if (!automation) return <p className="automations-hint">factory.yml no longer has an automation named {name}.</p>;

  // What Activity would list for it, so "Open in Activity" shows the same runs.
  const runs = filterRuns(snapshot.runs, { ...NO_RUN_FILTER, automation: name }, now);
  const place = (runId: string) => snapshot.queue[runId];
  const latest = latestRun([...runs].reverse(), now, place);
  const insights = runInsights(runs);
  const waiting = runs.find((run) => run.status === 'needs-approval');
  const running = runs.some((run) => run.status === 'running');
  const openRun = (runId: string) => openPanel({ kind: 'run', runId });
  const openFile = () => void act('open', () => automationsBridge.openFile(workspace.id));

  return (
    <div className="automations-detail">
      {error && (
        <div className="automations-error" role="alert">
          {error}
        </div>
      )}

      {automation.problem && (
        <div className="automations-problem-banner" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <strong>Not running</strong>
            <span>{automation.problem}</span>
          </div>
        </div>
      )}

      <div className="automations-lead">
        <LeadState latest={latest} insights={insights} automation={automation} onShowEntry={() => setView('yaml')} />
        <div className="automations-lead-actions">
          {waiting && (
            <button
              type="button"
              className="dialog-button-primary automations-small-button"
              onClick={() => openRun(waiting.id)}
            >
              <Hand size={12} aria-hidden="true" />
              Review run
            </button>
          )}
          {/* One primary action: the run waiting for you, else the fix for a problem, else running it. */}
          <RunNowButton
            automation={automation}
            primary={!waiting && !automation.problem}
            running={busy === 'run' || running}
            disabled={busy !== null}
            onRun={() => void act('run', () => automationsBridge.runNow(workspace.id, name))}
          />
          <button
            type="button"
            className={`${automation.problem && !waiting ? 'dialog-button-primary' : 'dialog-button-secondary'} automations-small-button`}
            onClick={() => openPanel({ kind: 'new', basis: { automation: name } })}
          >
            <Bot size={12} aria-hidden="true" />
            Change with agent
          </button>
        </div>
      </div>

      <section className="automations-detail-section" aria-labelledby={pipelineHeading}>
        <div className="automations-detail-section-head">
          <h3 id={pipelineHeading} className="automations-section-title">
            Pipeline
          </h3>
          <div className="automations-segmented automations-view-toggle" role="group" aria-label="Show the pipeline as">
            <button
              type="button"
              className={`automations-segment ${view === 'graph' ? 'active' : ''}`}
              aria-pressed={view === 'graph'}
              onClick={() => setView('graph')}
            >
              <Workflow size={12} aria-hidden="true" />
              Graph
            </button>
            <button
              type="button"
              className={`automations-segment ${view === 'yaml' ? 'active' : ''}`}
              aria-pressed={view === 'yaml'}
              onClick={() => setView('yaml')}
            >
              <FileCode size={12} aria-hidden="true" />
              YAML
            </button>
          </div>
        </div>
        {view === 'graph' ? (
          <PipelineGraph automation={automation} runs={runs} now={now} place={place} onOpenRun={openRun} />
        ) : (
          <EntrySource
            workspaceId={workspace.id}
            automation={automation}
            opening={busy === 'open'}
            onOpenFile={openFile}
          />
        )}
      </section>

      {runs.length > 0 && (
        <section className="automations-detail-section" aria-labelledby={insightsHeading}>
          <div className="automations-detail-section-head">
            <h3 id={insightsHeading} className="automations-section-title">
              Last 30 days
            </h3>
          </div>
          <AutomationInsights insights={insights} runs={runs} now={now} onOpenRun={openRun} />
        </section>
      )}

      <section className="automations-detail-section" aria-labelledby={runsHeading}>
        <div className="automations-detail-section-head">
          <h3 id={runsHeading} className="automations-section-title">
            Runs
            {runs.length > 0 && <span className="automations-runs-count">{runs.length}</span>}
          </h3>
          {runs.length > 0 && (
            <button
              type="button"
              className="automations-link-button automations-runs-elsewhere"
              onClick={() => showAutomationRuns(workspace.id, name)}
            >
              {runs.length > RUNS_SHOWN ? `All ${runs.length} in Activity` : 'Open in Activity'}
              <ArrowRight size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        {runs.length > 0 ? (
          <ul className="automations-run-list">
            {runs.slice(0, RUNS_SHOWN).map((run) => (
              <RunItem
                key={run.id}
                run={run}
                now={now}
                place={place(run.id)}
                arrived={arrivals.has(run.id)}
                onOpen={() => openRun(run.id)}
              />
            ))}
          </ul>
        ) : (
          <RunsEmpty automation={automation} now={now} />
        )}
      </section>
    </div>
  );
}

/**
 * How the automation is doing, said once and large: the run `latestRun`
 * speaks for, how long ago, and a streak once it is one. Under it, where it
 * is written and who wrote it.
 */
function LeadState({
  latest,
  insights,
  automation,
  onShowEntry,
}: {
  latest: LatestRun | null;
  insights: RunInsights;
  automation: AutomationView;
  onShowEntry: () => void;
}) {
  const streak = insights.streak;
  const showStreak = latest && streak && streak.status === latest.tone && streak.count >= 3;
  return (
    <div className="automations-lead-state">
      {latest ? (
        <StatusIcon status={latest.tone} size={22} />
      ) : (
        <CircleDashed size={22} className="automations-status-icon" aria-hidden="true" />
      )}
      <div className="automations-lead-text">
        <p className="automations-lead-headline">
          {latest ? (
            <>
              <span className={`automations-tone-${latest.tone}`}>{latest.label}</span>
              <span className="automations-lead-when">{latest.detail}</span>
              {showStreak && <span className="automations-lead-when">· {streak.count} in a row</span>}
            </>
          ) : (
            <span className="automations-lead-quiet">No recent runs</span>
          )}
        </p>
        <p className="automations-lead-meta">
          <button
            type="button"
            className="automations-lead-file"
            title="Show the entry as written"
            onClick={onShowEntry}
          >
            factory.yml{automation.line !== undefined ? `:${automation.line}` : ''}
          </button>
          {automation.addedBy && <span> · added by {automation.addedBy.sessionName}</span>}
        </p>
      </div>
    </div>
  );
}

/**
 * One run as GitHub Actions lists a workflow's: what it did on top, how it
 * ended and what fired it under that, when and how long on the right. A
 * run that lands while the list shows washes in once.
 */
function RunItem({
  run,
  now,
  place,
  arrived,
  onOpen,
}: {
  run: RunListEntry;
  now: Date;
  place?: number;
  arrived: boolean;
  onOpen: () => void;
}) {
  const washed = useArrivedOnMount(arrived);
  const about = runAbout(run);
  const status = `${statusLabel(run.status)}${run.status === 'queued' && place !== undefined ? ` · ${place} in line` : ''}`;
  // With nothing to say about itself, a run's "about" is its status: the title says that instead.
  const title = about !== run.status ? about : status;
  const worked = run.status === 'completed' || run.status === 'failed' || run.status === 'running';
  const duration = worked ? formatDuration(run, now) : null;
  const fired = triggerInWords(run);
  const when = formatTime(run.createdAt);
  return (
    <li>
      <button
        type="button"
        className={`automations-run-item ${washed ? 'automations-run-arrived' : ''}`}
        // The cells are laid out apart, so their text has no separators of its own to read out.
        aria-label={[status, title !== status ? title : null, fired, when, duration ? `took ${duration}` : null]
          .filter(Boolean)
          .join(', ')}
        onClick={onOpen}
      >
        <StatusIcon status={run.status} />
        <span className="automations-run-item-main">
          <span className="automations-run-item-title">{title}</span>
          <span className="automations-run-item-meta">
            {title !== status && (
              <>
                <span className={`automations-tone-${run.status}`}>{status}</span>
                {' · '}
              </>
            )}
            {fired}
          </span>
        </span>
        <span className="automations-run-item-side">
          <time dateTime={run.createdAt} title={when}>
            <CalendarDays size={12} aria-hidden="true" />
            {formatAgo(run.createdAt, now)}
          </time>
          {duration && (
            <span>
              <Timer size={12} aria-hidden="true" />
              {duration}
            </span>
          )}
        </span>
        <ChevronRight size={14} className="automations-run-item-chevron" aria-hidden="true" />
      </button>
    </li>
  );
}

/** No runs in the last 30 days: what will make the first one, and what Run now would do. */
function RunsEmpty({ automation, now }: { automation: AutomationView; now: Date }) {
  const runNow =
    automation.mode === 'notify'
      ? 'Run now shows what it would do, and starts nothing.'
      : automation.mode === 'confirm' || automation.asksFirst
        ? 'Run now previews it; nothing changes until you approve.'
        : 'Run now runs it right away.';
  let text: string;
  if (automation.problem) text = 'It will not run until the problem above is fixed.';
  else if (automation.onEvent) text = 'It fires when an Inbox refresh finds something new. Check now looks right away.';
  else if (automation.nextRunAt) {
    const countdown = formatCountdown(automation.nextRunAt, now);
    text = `${countdown === 'due now' ? 'Its next run is due now' : `Its next run is ${countdown} (${formatDueAt(automation.nextRunAt, now)})`}. ${runNow}`;
  } else text = runNow;
  return (
    <div className="automations-runs-empty">
      <CircleDashed size={16} className="automations-status-icon" aria-hidden="true" />
      <div>
        <strong>No runs in the last 30 days</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}
