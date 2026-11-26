import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { History, Search } from 'lucide-react';
import type { AutomationsSnapshot, RunListEntry } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { AutomationInsights } from './AutomationInsights';
import { AutomationFilterMenu, RunItem, useArrivals, useMarkRunsSeen, useNow } from './parts';
import {
  filterRuns,
  groupRunsByDay,
  isRunFilterNarrowed,
  foldDroppedRuns,
  mergeRunPages,
  newestRunFirst,
  olderRunsCursor,
  NO_RUN_FILTER,
  runAutomationOptions,
  runInsights,
  snapshotRunCounts,
  waitingForYouRuns,
} from './presentation';
import type { RunAutomationOption, RunFilter, RunListFilter } from './presentation';

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
export function ActivityTab({
  workspace,
  snapshot,
}: {
  workspace: Workspace;
  snapshot: AutomationsSnapshot;
}) {
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
  const overview = filterRuns(
    snapshot.runs,
    { ...NO_RUN_FILTER, automation: filter.automation },
    now,
  );

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
        workspaceId={workspace.id}
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
          <p>
            Runs show here as automations fire on their schedules and events, and as you press Run
            now.
          </p>
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
  workspaceId,
  snapshot,
  filter,
  options,
  history,
  now,
  onChange,
}: {
  workspaceId: string;
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
  const openRunId = useAutomationsStore((state) =>
    state.panel?.kind === 'run' ? state.panel.runId : null,
  );
  const arrivals = useArrivals(snapshot.runs);
  const { runs, hasOlder, loading, error, showOlder, paged } = useRunPages(
    workspaceId,
    snapshot,
    filter,
    now,
  );
  const counts = snapshotRunCounts(snapshot, filter, now);
  const narrowed = isRunFilterNarrowed(filter);
  // A run waiting for the person at a gate is listed once, in its own group first (review S7).
  const waiting = waitingForYouRuns(runs);
  const byDay = waiting.length > 0 ? runs.filter((run) => !waiting.includes(run)) : runs;
  const running = history.filter((run) => run.status === 'running').length;
  const queued = history.filter((run) => run.status === 'queued').length;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('.automations-run-item') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    items[
      Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    ]?.focus();
  };

  return (
    <section
      className="automations-detail-section automations-activity-runs"
      aria-labelledby={headingId}
    >
      <div className="automations-runs-toolbar">
        <div className="automations-runs-heading">
          <h2 id={headingId} className="automations-section-title">
            Runs
          </h2>
          <span className="automations-runs-count" aria-live="polite">
            {narrowed
              ? `${runs.length}${hasOlder ? '+' : ''}`
              : paged
                ? `${runs.length}${hasOlder ? '+' : ''}`
                : counts.all}
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
        <AutomationFilterMenu
          options={options}
          value={filter.automation}
          onChange={(automation) => onChange({ automation })}
        />
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
              {/* Counts come from the snapshot: beside narrowed or paged rows they could read "Failed 0". */}
              {!narrowed && !paged && (
                <span className="automations-segment-count">{counts.kinds[id]}</span>
              )}
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
      {error && (
        <p className="automations-runs-error" role="alert">
          Could not load runs: {error}
        </p>
      )}
      {runs.length > 0 ? (
        <div ref={listRef} className="automations-run-days" onKeyDown={onKeyDown}>
          {/* Runs waiting for the person at a gate come first, and only here, not again in their day. */}
          {waiting.length > 0 && (
            <div className="automations-run-day automations-run-waiting">
              <h3 className="automations-run-day-head">
                Waiting for you
                <span className="automations-run-day-count">
                  {waiting.length} {waiting.length === 1 ? 'run' : 'runs'}
                </span>
              </h3>
              <ul className="automations-run-list">
                {waiting.map((run) => (
                  <RunItem
                    key={run.id}
                    run={run}
                    now={now}
                    showName
                    when="time"
                    selected={run.id === openRunId}
                    arrived={arrivals.has(run.id)}
                    onOpen={() => openPanel({ kind: 'run', runId: run.id })}
                  />
                ))}
              </ul>
            </div>
          )}
          {groupRunsByDay(byDay, now).map((group) => (
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
          {hasOlder && (
            <button
              type="button"
              className="automations-link-button"
              disabled={loading}
              onClick={showOlder}
            >
              {loading ? 'Loading…' : 'Show older runs'}
            </button>
          )}
        </div>
      ) : loading && narrowed ? (
        <p className="automations-runs-count" aria-live="polite">
          Searching…
        </p>
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

/** How many runs one page of the list asks main for. */
const PAGE = 200;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The rows of the run list. Unnarrowed, they are the snapshot's (so they stay
 * live with every push) with any older pages loaded below them, the
 * snapshot's copy of a run winning. Narrowed, they come from `listRuns`
 * (main's history, not just the snapshot): re-asked when the filter changes,
 * the search text 250 ms after typing stops, and when the set of live runs
 * changes, so a run that finishes while a search is open does not stay
 * "running". An answer that arrives after a newer question was sent is
 * dropped. A failed call keeps the rows and reports why.
 */
function useRunPages(
  workspaceId: string,
  snapshot: AutomationsSnapshot,
  filter: RunListFilter,
  now: Date,
) {
  const narrowed = isRunFilterNarrowed(filter);
  const query = filter.query.trim();
  const { kind, automation } = filter;
  const [older, setOlder] = useState<RunListEntry[]>([]);
  const [found, setFound] = useState<RunListEntry[]>([]);
  // Whether runs remain after the latest page asked for; null until one was.
  const [more, setMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One counter for the first page of a filter, one for "Show older runs": a
  // live refresh bumps only the first, so it cannot drop an older page.
  const request = useRef(0);
  const olderRequest = useRef(0);
  const lastQuery = useRef('');
  const lastShape = useRef('');
  const pagedOlder = useRef(false);

  // The live runs' ids and statuses: when they change, a narrowed list is stale.
  const liveKey = snapshot.runs
    .filter(
      (run) =>
        run.status === 'queued' ||
        run.status === 'running' ||
        run.status === 'needs-approval' ||
        run.status === 'waiting',
    )
    .map((run) => `${run.id}:${run.status}`)
    .sort()
    .join(',');
  const shape = `${workspaceId}|${narrowed ? `${query}|${kind}|${automation}` : ''}`;

  // The snapshot's edge moves as runs end: what it dropped goes into `older`.
  const [seen, setSeen] = useState({ workspaceId, runs: snapshot.runs });
  if (seen.runs !== snapshot.runs || seen.workspaceId !== workspaceId) {
    if (seen.workspaceId === workspaceId && older.length > 0 && !narrowed) {
      setOlder(foldDroppedRuns(seen.runs, snapshot.runs, older));
    }
    setSeen({ workspaceId, runs: snapshot.runs });
  }

  // A different workspace or filter starts over; anything still in flight is stale.
  useEffect(() => {
    request.current++;
    olderRequest.current++;
    pagedOlder.current = false;
    setFound([]);
    setOlder([]);
    setMore(null);
    setError(null);
    setLoading(false);
  }, [shape]);

  // Nothing sets state after the list is gone.
  useEffect(
    () => () => {
      request.current++;
      olderRequest.current++;
    },
    [],
  );

  useEffect(() => {
    if (!narrowed) return;
    const id = ++request.current;
    const filterChanged = lastShape.current !== shape;
    // Only a kind or automation change asks at once; typing and live changes wait for a pause.
    const immediate = filterChanged && lastQuery.current === query;
    lastShape.current = shape;
    lastQuery.current = query;
    if (filterChanged) setLoading(true);
    const timer = setTimeout(
      () => {
        automationsBridge
          .listRuns(workspaceId, { limit: PAGE, query, kind, automation })
          .then((page) => {
            if (id !== request.current) return;
            setError(null);
            // A refresh from a live change keeps the older pages already loaded.
            if (pagedOlder.current) {
              const edge = page.runs[page.runs.length - 1];
              setFound((prev) =>
                mergeRunPages(
                  page.runs,
                  edge ? prev.filter((run) => newestRunFirst(run, edge) > 0) : [],
                ),
              );
            } else {
              setFound(page.runs);
              setMore(page.hasOlder);
            }
          })
          .catch((reason: unknown) => {
            if (id === request.current) {
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          })
          .finally(() => {
            if (id === request.current) setLoading(false);
          });
      },
      immediate ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [workspaceId, narrowed, query, kind, automation, liveKey, shape]);

  const rows = narrowed ? found : filterRuns(mergeRunPages(snapshot.runs, older), filter, now);
  const cursor = olderRunsCursor(rows);
  // Without a cursor the page would start over at the newest run.
  const hasOlder =
    (narrowed ? (more ?? false) : (more ?? snapshot.hasOlder)) && cursor !== undefined;

  const showOlder = useCallback(() => {
    const id = olderRequest.current;
    setLoading(true);
    automationsBridge
      .listRuns(workspaceId, {
        before: cursor,
        limit: PAGE,
        query: narrowed ? query : undefined,
        kind: narrowed ? kind : undefined,
        automation: narrowed ? automation : undefined,
      })
      .then((page) => {
        if (id !== olderRequest.current) return;
        setError(null);
        pagedOlder.current = true;
        setMore(page.hasOlder);
        if (narrowed) setFound((prev) => mergeRunPages(prev, page.runs));
        else setOlder((prev) => mergeRunPages(prev, page.runs));
      })
      .catch((reason: unknown) => {
        if (id === olderRequest.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (id === olderRequest.current) setLoading(false);
      });
  }, [workspaceId, narrowed, query, kind, automation, cursor]);

  return { runs: rows, hasOlder, loading, error, showOlder, paged: older.length > 0 };
}

/** Why the list is empty, as specifically as the filter allows. */
function emptyRunsMessage(
  filter: RunListFilter,
  options: RunAutomationOption[],
  historyCount: number,
): string {
  if (historyCount === 0) return 'No runs in the last 30 days.';
  if (filter.automation !== null && filter.query.trim() === '' && filter.kind === 'all') {
    const label =
      options.find((option) => option.id === filter.automation)?.label ?? filter.automation;
    return `${label} has not run in the last 30 days.`;
  }
  return 'No runs match.';
}
