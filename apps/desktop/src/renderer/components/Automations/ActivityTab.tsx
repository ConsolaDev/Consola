import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { AlertTriangle, Hand, Layers, Search } from 'lucide-react';
import type { AutomationsSnapshot, RunListEntry } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { isLookedAt } from '../../utils/windowAttention';
import { AutomationInsights } from './AutomationInsights';
import { AutomationFilterMenu, RunItem, StatusDot, useArrivals, useIntent, useNow } from './parts';
import { GetStarted } from './TemplatesTab';
import {
  filterRuns,
  formatAgo,
  formatTime,
  groupRunsByDay,
  isRunFilterNarrowed,
  latestRun,
  NO_RUN_FILTER,
  runAutomationOptions,
  runInsights,
  runKindCounts,
  runTitle,
  triggerInWords,
  type RunAutomationOption,
  type RunFilter,
  type RunListFilter,
} from './presentation';

const FILTERS: ReadonlyArray<{ id: RunFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Prompts & reviews' },
  { id: 'tool', label: 'Tools' },
  { id: 'failed', label: 'Failed' },
];

/** The person has looked at this workspace's Activity now. */
function markSeen(workspaceId: string): void {
  useAutomationsStore.getState().markActivitySeen(workspaceId, new Date().toISOString());
}

/**
 * What the workspace's automations have been doing, laid out as GitHub
 * Actions lays out a repository's runs: the automations down the left as
 * a filter, and beside them what waits for the person, how the last 30
 * days went, and every run, by day. Looking at it is what the sidebar's
 * "failed since you last looked" counts from. Everything a run says —
 * summaries, item titles — is other people's text, shown as text.
 */
export function ActivityTab({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  const { busy, error, act } = useIntent();

  // Opening Activity is looking at it. After that, a run that changes counts
  // as seen only if someone can see this window: main keeps pushing to a
  // minimized or background one, and those failures are exactly what the
  // sidebar's "N failed" is for.
  const hasMarked = useRef(false);
  useEffect(() => {
    if (hasMarked.current && !isLookedAt()) return;
    hasMarked.current = true;
    markSeen(workspace.id);
  }, [workspace.id, snapshot]);

  // Coming back to the window while Activity is showing is looking at it.
  useEffect(() => {
    const onReturn = () => {
      if (isLookedAt()) markSeen(workspace.id);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [workspace.id]);

  const isEmpty = snapshot.automations.length === 0 && snapshot.runs.length === 0;

  return (
    <div className="automations-activity">
      {error && (
        <div className="automations-error" role="alert">
          {error}
        </div>
      )}

      {snapshot.issues.length > 0 && (
        <div className="automations-issues" role="status">
          <div className="automations-issues-title">
            <AlertTriangle size={13} />
            {snapshot.automations.length === 0 ? 'factory.yml did not load' : 'Some entries did not load'}
          </div>
          <ul>
            {snapshot.issues.map((issue, index) => (
              <li key={index}>
                {issue.line ? <span className="automations-line">line {issue.line}</span> : null}
                {issue.path ? <code>{issue.path}</code> : null} {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {snapshot.suggestAssignedReviews && (
        <div className="automations-callout" role="region" aria-label="Review PRs assigned to me automatically">
          <div className="automations-callout-text">
            <div className="automations-callout-title">Review PRs assigned to me automatically</div>
            <p className="automations-hint">
              Adds <code>review-assigned-prs</code> to factory.yml: your {snapshot.suggestAssignedReviews.action} action
              runs, read-only, on each pull request that asks for your review or is assigned to you. It asks you once
              before the first.
            </p>
          </div>
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            onClick={() => void act('add-reviews', () => automationsBridge.addAssignedReviews(workspace.id))}
            disabled={busy === 'add-reviews'}
          >
            Add
          </button>
        </div>
      )}

      {isEmpty ? (
        <GetStarted workspace={workspace} snapshot={snapshot} />
      ) : (
        <ActivityBoard workspaceId={workspace.id} snapshot={snapshot} />
      )}
    </div>
  );
}

/**
 * The rail and the column beside it. One filter, kept in the store per
 * workspace, drives both: the rail and the narrow layout's menu choose the
 * automation, the column's buttons and search narrow the runs further.
 */
function ActivityBoard({ workspaceId, snapshot }: { workspaceId: string; snapshot: AutomationsSnapshot }) {
  const filter = useAutomationsStore((state) => state.runFilters[workspaceId] ?? NO_RUN_FILTER);
  const setRunFilter = useAutomationsStore((state) => state.setRunFilter);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const overviewHeading = useId();
  // A running run's duration counts in seconds; the rest needs only the minute.
  const now = useNow(snapshot.runs.some((run) => run.status === 'running') ? 1000 : 30_000);
  const history = filterRuns(snapshot.runs, NO_RUN_FILTER, now);
  const options = runAutomationOptions(snapshot, history, filter.automation);
  const chosen = options.find((option) => option.id === filter.automation);
  // The month of the automation chosen, whatever the kind or search: a rate of "Failed" runs says nothing.
  const overview = filterRuns(snapshot.runs, { ...NO_RUN_FILTER, automation: filter.automation }, now);
  const waiting = snapshot.runs.filter((run) => run.status === 'needs-approval');
  const change = (next: Partial<RunListFilter>) => setRunFilter(workspaceId, next);
  const openRun = (runId: string) => openPanel({ kind: 'run', runId });

  return (
    <div className="automations-board">
      <AutomationRail
        options={options}
        history={history}
        now={now}
        value={filter.automation}
        onChange={(automation) => change({ automation })}
      />
      <div className="automations-board-main">
        {waiting.length > 0 && <WaitingForYou runs={waiting} now={now} onReview={openRun} />}
        {overview.length > 0 && (
          <section className="automations-detail-section" aria-labelledby={overviewHeading}>
            <div className="automations-detail-section-head">
              <h2 id={overviewHeading} className="automations-section-title">
                Last 30 days
                {chosen && <span className="automations-overview-scope">{chosen.label}</span>}
              </h2>
            </div>
            <AutomationInsights insights={runInsights(overview)} runs={overview} now={now} onOpenRun={openRun} />
          </section>
        )}
        <RunList
          snapshot={snapshot}
          filter={filter}
          options={options}
          history={history}
          now={now}
          onChange={change}
        />
      </div>
    </div>
  );
}

/**
 * The automations as GitHub Actions lists a repository's workflows: "All"
 * first, then each entry of factory.yml with how its latest run went and
 * how many it has, then anything else with runs — an entry since removed,
 * an agent's request. Choosing one narrows everything beside it; choosing
 * it again goes back to all.
 */
function AutomationRail({
  options,
  history,
  now,
  value,
  onChange,
}: {
  options: RunAutomationOption[];
  history: RunListEntry[];
  now: Date;
  value: string | null;
  onChange: (automation: string | null) => void;
}) {
  const inFile = options.filter((option) => option.inFile);
  const others = options.filter((option) => !option.inFile);
  const item = (option: RunAutomationOption) => {
    const latest = latestRun(
      history.filter((run) => run.automationId === option.id).reverse(),
      now,
    );
    const selected = value === option.id;
    return (
      <li key={option.id}>
        <button
          type="button"
          className="automations-rail-item"
          aria-current={selected ? 'true' : undefined}
          title={latest ? `Last run: ${latest.label.toLowerCase()} ${latest.detail}` : 'No runs in the last 30 days'}
          onClick={() => onChange(selected ? null : option.id)}
        >
          {latest ? (
            <StatusDot status={latest.tone} />
          ) : (
            <span className="automations-dot automations-dot-none" aria-hidden="true" />
          )}
          <span className="automations-rail-name">{option.label}</span>
          <span className="automations-rail-count">{option.count}</span>
        </button>
      </li>
    );
  };
  return (
    <nav className="automations-rail" aria-label="Filter by automation">
      <button
        type="button"
        className="automations-rail-item automations-rail-all"
        aria-current={value === null ? 'true' : undefined}
        onClick={() => onChange(null)}
      >
        <Layers size={13} aria-hidden="true" />
        <span className="automations-rail-name">All automations</span>
        <span className="automations-rail-count">{history.length}</span>
      </button>
      {inFile.length > 0 && (
        <>
          <div className="automations-rail-label">In factory.yml</div>
          <ul className="automations-rail-list">{inFile.map(item)}</ul>
        </>
      )}
      {others.length > 0 && (
        <>
          <div className="automations-rail-label">Other runs</div>
          <ul className="automations-rail-list">{others.map(item)}</ul>
        </>
      )}
    </nav>
  );
}

/**
 * Every run waiting for a person, plans and agents' requests alike, as
 * CircleCI holds a workflow at an approval: amber, first, each with its
 * Review.
 */
function WaitingForYou({ runs, now, onReview }: { runs: RunListEntry[]; now: Date; onReview: (runId: string) => void }) {
  const headingId = useId();
  return (
    <section className="automations-waiting" aria-labelledby={headingId}>
      <h2 id={headingId} className="automations-waiting-title">
        <Hand size={14} aria-hidden="true" />
        Waiting for you
        <span className="automations-waiting-count" aria-hidden="true">
          {runs.length}
        </span>
      </h2>
      <ul className="automations-waiting-list">
        {runs.map((run) => (
          <li key={run.id} className="automations-waiting-card">
            <div className="automations-waiting-text">
              <span className="automations-waiting-name">{runTitle(run)}</span>
              {run.summary && <span className="automations-waiting-summary">{run.summary}</span>}
            </div>
            <span className="automations-waiting-when" title={formatTime(run.createdAt)}>
              {triggerInWords(run)} · {formatAgo(run.createdAt, now)}
            </span>
            <button
              type="button"
              className="dialog-button-primary automations-small-button"
              onClick={() => onReview(run.id)}
            >
              Review…
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The last 30 days of runs, newest first and split by day: searchable,
 * narrowed by kind (each kind saying how many it would show) and by the
 * automation the rail chose. ↑ and ↓ move between runs; Enter opens one.
 */
function RunList({
  snapshot,
  filter,
  options,
  history,
  now,
  onChange,
}: {
  snapshot: AutomationsSnapshot;
  filter: RunListFilter;
  options: RunAutomationOption[];
  history: RunListEntry[];
  now: Date;
  onChange: (next: Partial<RunListFilter>) => void;
}) {
  const headingId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const openRunId = useAutomationsStore((state) => (state.panel?.kind === 'run' ? state.panel.runId : null));
  const arrivals = useArrivals(snapshot.runs);
  const runs = filterRuns(snapshot.runs, filter, now);
  const kindCounts = runKindCounts(snapshot.runs, filter, now);
  const narrowed = isRunFilterNarrowed(filter);
  const running = history.filter((run) => run.status === 'running').length;
  const queued = history.filter((run) => run.status === 'queued').length;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.automations-run-item') ?? []);
    const index = items.findIndex((item) => item === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  return (
    <section className="automations-detail-section automations-activity-runs" aria-labelledby={headingId}>
      <div className="automations-runs-toolbar">
        <div className="automations-runs-heading">
          <h2 id={headingId} className="automations-section-title">
            Runs
          </h2>
          <span className="automations-runs-count" aria-live="polite">
            {narrowed ? `${runs.length} of ${history.length}` : history.length}
          </span>
          {running + queued > 0 && (
            <span className="automations-live" title="Updates as runs start and finish">
              <span className="automations-live-dot" aria-hidden="true" />
              {[running > 0 ? `${running} running` : null, queued > 0 ? `${queued} queued` : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
        {/* The rail's job where there is no room for the rail. */}
        <div className="automations-filter-narrow">
          <AutomationFilterMenu options={options} value={filter.automation} onChange={(automation) => onChange({ automation })} />
        </div>
        <div className="automations-segmented" role="group" aria-label="Filter runs">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`automations-segment ${filter.kind === id ? 'active' : ''}`}
              aria-pressed={filter.kind === id}
              onClick={() => onChange({ kind: id })}
            >
              {label}
              <span className="automations-segment-count">{kindCounts[id]}</span>
            </button>
          ))}
        </div>
        <label className="automations-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search runs"
            aria-label="Search runs"
            value={filter.query}
            onChange={(event) => onChange({ query: event.target.value })}
          />
        </label>
      </div>
      {runs.length > 0 ? (
        <div ref={listRef} className="automations-run-days" onKeyDown={onKeyDown}>
          {groupRunsByDay(runs, now).map((group) => (
            <div key={group.key} className="automations-run-day">
              <h3 className="automations-run-day-head">
                {group.label}
                <span className="automations-run-day-count">
                  {group.runs.length} {group.runs.length === 1 ? 'run' : 'runs'}
                </span>
              </h3>
              <ul className="automations-run-list">
                {group.runs.map((run) => (
                  <RunItem
                    key={run.id}
                    run={run}
                    now={now}
                    place={snapshot.queue[run.id]}
                    showName
                    when="time"
                    selected={run.id === openRunId}
                    arrived={arrivals.has(run.id)}
                    onOpen={() => openPanel({ kind: 'run', runId: run.id })}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="automations-runs-empty">
          <Search size={16} className="automations-status-icon" aria-hidden="true" />
          <div>
            <strong>{emptyRunsMessage(filter, options, history.length)}</strong>
            <p>
              {narrowed ? (
                <button
                  type="button"
                  className="automations-link-button"
                  onClick={() => onChange(NO_RUN_FILTER)}
                >
                  Clear filters
                </button>
              ) : (
                'Runs show here as automations fire, and as you press Run now.'
              )}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/** Why the list is empty, as specifically as the filter allows. */
function emptyRunsMessage(filter: RunListFilter, options: RunAutomationOption[], historyCount: number): string {
  if (historyCount === 0) return 'No runs in the last 30 days.';
  if (filter.automation !== null && filter.query.trim() === '' && filter.kind === 'all') {
    const label = options.find((option) => option.id === filter.automation)?.label ?? filter.automation;
    return `${label} has not run in the last 30 days.`;
  }
  return 'No runs match.';
}
