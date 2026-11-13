import { useEffect, useId, useRef } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import type { AutomationsSnapshot, RunListEntry } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { isLookedAt } from '../../utils/windowAttention';
import { AutomationFilterMenu, RunRow, useArrivals, useIntent } from './parts';
import { GetStarted } from './TemplatesTab';
import {
  activityCounts,
  filterRuns,
  formatTime,
  isRunFilterNarrowed,
  NO_RUN_FILTER,
  runAutomationOptions,
  runTitle,
  triggerLabel,
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
 * What the workspace's automations have been doing: problems with the file,
 * the counts, what waits for the person, then every run of the last 30 days.
 * Looking at it is what the sidebar's "failed since you last looked" counts
 * from. Everything a run says — summaries, item titles — is other people's
 * text, shown as text.
 */
export function ActivityTab({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
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
  const waiting = snapshot.runs.filter((run) => run.status === 'needs-approval');

  return (
    <div className="automations-activity">
      {error && <div className="automations-error" role="alert">{error}</div>}

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
        <>
          <Counts snapshot={snapshot} />
          {waiting.length > 0 && (
            <WaitingForYou runs={waiting} onReview={(runId) => openPanel({ kind: 'run', runId })} />
          )}
          <RunList snapshot={snapshot} workspaceId={workspace.id} />
        </>
      )}
    </div>
  );
}

function Counts({ snapshot }: { snapshot: AutomationsSnapshot }) {
  const counts = activityCounts(snapshot, new Date());
  return (
    <ul className="automations-counts" aria-label="At a glance">
      <Count
        value={counts.automations}
        label={counts.automations === 1 ? 'automation' : 'automations'}
        detail={counts.onEvents > 0 ? `${counts.onEvents} on events` : undefined}
      />
      <Count value={counts.waiting} label="waiting for you" tone={counts.waiting > 0 ? 'waiting' : undefined} />
      <Count
        value={counts.running}
        label="running"
        detail={counts.queued > 0 ? `${counts.queued} queued` : undefined}
      />
      <Count value={counts.ranThisWeek} label={counts.ranThisWeek === 1 ? 'run in 7 days' : 'runs in 7 days'} />
      <Count
        value={counts.failedThisWeek}
        label="failed in 7 days"
        tone={counts.failedThisWeek > 0 ? 'failed' : undefined}
      />
    </ul>
  );
}

function Count({
  value,
  label,
  detail,
  tone,
}: {
  value: number;
  label: string;
  detail?: string;
  tone?: 'waiting' | 'failed';
}) {
  return (
    <li className={`automations-count ${tone ? `automations-count-${tone}` : ''}`}>
      <span className="automations-count-value">{value}</span>
      <span className="automations-count-label">
        {label}
        {detail ? <span className="automations-count-detail"> · {detail}</span> : null}
      </span>
    </li>
  );
}

/** Every run waiting for a person, plans and agents' requests alike, each opening its details. */
function WaitingForYou({ runs, onReview }: { runs: RunListEntry[]; onReview: (runId: string) => void }) {
  const headingId = useId();
  return (
    <section className="automations-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="automations-section-title">
        Waiting for you
      </h2>
      {runs.map((run) => (
        <div key={run.id} className="automations-waiting-card">
          <div className="automations-waiting-text">
            <div className="automations-card-heading">
              <span className="automations-name">{runTitle(run)}</span>
              <span className="automations-meta">
                {triggerLabel(run)} · {formatTime(run.createdAt)}
              </span>
            </div>
            {run.summary && <p className="automations-summary">{run.summary}</p>}
          </div>
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            onClick={() => onReview(run.id)}
          >
            Review…
          </button>
        </div>
      ))}
    </section>
  );
}

/**
 * The last 30 days of runs, newest first: searchable, and narrowed by kind
 * and by automation. The filter lives in the store, per workspace, so an
 * automation's details can open this list already narrowed to it.
 */
function RunList({ snapshot, workspaceId }: { snapshot: AutomationsSnapshot; workspaceId: string }) {
  const headingId = useId();
  const filter = useAutomationsStore((state) => state.runFilters[workspaceId] ?? NO_RUN_FILTER);
  const setRunFilter = useAutomationsStore((state) => state.setRunFilter);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const openRunId = useAutomationsStore((state) => (state.panel?.kind === 'run' ? state.panel.runId : null));
  const arrivals = useArrivals(snapshot.runs);
  const now = new Date();
  const history = filterRuns(snapshot.runs, NO_RUN_FILTER, now);
  const runs = filterRuns(snapshot.runs, filter, now);
  const options = runAutomationOptions(snapshot, history, filter.automation);
  const narrowed = isRunFilterNarrowed(filter);
  const change = (next: Partial<RunListFilter>) => setRunFilter(workspaceId, next);

  return (
    <section className="automations-section automations-runs-section" aria-labelledby={headingId}>
      <div className="automations-runs-toolbar">
        <div className="automations-runs-heading">
          <h2 id={headingId} className="automations-section-title">
            Runs
          </h2>
          <span className="automations-runs-count" aria-live="polite">
            {narrowed ? `${runs.length} of ${history.length}` : history.length}
          </span>
        </div>
        <AutomationFilterMenu
          options={options}
          value={filter.automation}
          onChange={(automation) => change({ automation })}
        />
        <div className="automations-segmented" role="group" aria-label="Filter runs">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`automations-segment ${filter.kind === id ? 'active' : ''}`}
              aria-pressed={filter.kind === id}
              onClick={() => change({ kind: id })}
            >
              {label}
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
            onChange={(event) => change({ query: event.target.value })}
          />
        </label>
      </div>
      {runs.length > 0 ? (
        <ul className="automations-runs automations-runs-named">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              now={now}
              showName
              place={snapshot.queue[run.id]}
              selected={run.id === openRunId}
              arrived={arrivals.has(run.id)}
              onOpen={() => openPanel({ kind: 'run', runId: run.id })}
            />
          ))}
        </ul>
      ) : (
        <p className="automations-hint">
          {emptyRunsMessage(filter, options, history.length)}
          {narrowed && (
            <>
              {' '}
              <button type="button" className="automations-link-button" onClick={() => change(NO_RUN_FILTER)}>
                Clear filters
              </button>
            </>
          )}
        </p>
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
