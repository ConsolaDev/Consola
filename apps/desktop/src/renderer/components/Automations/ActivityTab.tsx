import { useId, useRef, type KeyboardEvent } from 'react';
import { History, Search } from 'lucide-react';
import type { AutomationsSnapshot, RunListEntry } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { useAutomationsStore } from '../../stores/automationsStore';
import { AutomationInsights } from './AutomationInsights';
import { AutomationFilterMenu, RunItem, useArrivals, useMarkRunsSeen, useNow } from './parts';
import {
  filterRuns,
  groupRunsByDay,
  isRunFilterNarrowed,
  NO_RUN_FILTER,
  runAutomationOptions,
  runInsights,
  runKindCounts,
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

/**
 * Every run of the workspace's automations, as CircleCI lists a project's
 * pipelines: how the last 30 days went, then each run, newest first and by
 * day, narrowed by automation, kind and text. The Automations tab says how
 * each automation is doing; this is the log behind it, the runs from
 * outside factory.yml included. Looking at it is looking at every run, so
 * it is always what the sidebar's "N failed" counts from. Everything a run
 * says — summaries, item titles — is other people's text, shown as text.
 */
export function ActivityTab({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  useMarkRunsSeen(workspace.id, snapshot);
  const filter = useAutomationsStore((state) => state.runFilters[workspace.id] ?? NO_RUN_FILTER);
  const setRunFilter = useAutomationsStore((state) => state.setRunFilter);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const overviewHeading = useId();
  // A running run's duration counts in seconds; the rest needs only the minute.
  const now = useNow(snapshot.runs.some((run) => run.status === 'running') ? 1000 : 30_000);

  if (snapshot.runs.length === 0) return <NoRunsYet />;

  const history = filterRuns(snapshot.runs, NO_RUN_FILTER, now);
  const options = runAutomationOptions(snapshot, history, filter.automation);
  const chosen = options.find((option) => option.id === filter.automation);
  // The month of the automation chosen, whatever the kind or search: a rate of "Failed" runs says nothing.
  const overview = filterRuns(snapshot.runs, { ...NO_RUN_FILTER, automation: filter.automation }, now);

  return (
    <div className="automations-activity automations-log">
      {overview.length > 0 && (
        <section className="automations-detail-section" aria-labelledby={overviewHeading}>
          <div className="automations-detail-section-head">
            <h2 id={overviewHeading} className="automations-section-title">
              Last 30 days
              {chosen && <span className="automations-overview-scope">{chosen.label}</span>}
            </h2>
          </div>
          <AutomationInsights
            insights={runInsights(overview)}
            runs={overview}
            now={now}
            onOpenRun={(runId) => openPanel({ kind: 'run', runId })}
          />
        </section>
      )}
      <RunList
        snapshot={snapshot}
        filter={filter}
        options={options}
        history={history}
        now={now}
        onChange={(next) => setRunFilter(workspace.id, next)}
      />
    </div>
  );
}

/** Nothing has run here yet: what will put runs in this list. */
function NoRunsYet() {
  return (
    <div className="automations-activity">
      <div className="automations-runs-empty">
        <History size={16} className="automations-status-icon" aria-hidden="true" />
        <div>
          <strong>No runs yet.</strong>
          <p>Runs show here as automations fire on their schedules and events, and as you press Run now.</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The last 30 days of runs, newest first and split by day: searchable,
 * narrowed by automation and by kind (each kind saying how many it would
 * show). ↑ and ↓ move between runs; Enter opens one.
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
        <AutomationFilterMenu options={options} value={filter.automation} onChange={(automation) => onChange({ automation })} />
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
