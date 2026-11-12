import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Search, Zap } from 'lucide-react';
import type { AutomationsSnapshot, RunListEntry } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { StatusDot, useIntent } from './parts';
import {
  activityCounts,
  filterRuns,
  formatTime,
  runAbout,
  runTitle,
  statusWord,
  triggerLabel,
  type RunFilter,
} from './presentation';

const FILTERS: ReadonlyArray<{ id: RunFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Prompts & reviews' },
  { id: 'tool', label: 'Tools' },
  { id: 'failed', label: 'Failed' },
];

/**
 * What the workspace's automations have been doing: problems with the file,
 * the counts, what waits for the person, then every run of the last 30 days.
 * Looking at it is what the sidebar's "failed since you last looked" counts
 * from. Everything a run says — summaries, item titles — is other people's
 * text, shown as text.
 */
export function ActivityTab({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const setTab = useAutomationsStore((state) => state.setTab);
  const { busy, error, act } = useIntent();

  // A run that changes while Activity is showing has been seen.
  useEffect(() => {
    useAutomationsStore.getState().markActivitySeen(workspace.id, new Date().toISOString());
  }, [workspace.id, snapshot]);

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
        <div className="automations-empty-state">
          <Zap size={20} className="automations-empty-icon" aria-hidden="true" />
          <p className="automations-empty-lede">
            Automations work in this workspace without you: on a schedule, or when a pull request asks for your
            review. Each runs a prompt, one of your actions or a Consola tool, and can ask you before it acts.
          </p>
          <div className="automations-empty-actions">
            <button type="button" className="dialog-button-primary" onClick={() => openPanel({ kind: 'new' })}>
              New automation
            </button>
            <button type="button" className="dialog-button-secondary" onClick={() => setTab('templates')}>
              Browse templates
            </button>
          </div>
        </div>
      ) : (
        <>
          <Counts snapshot={snapshot} />
          {waiting.length > 0 && (
            <WaitingForYou runs={waiting} onReview={(runId) => openPanel({ kind: 'run', runId })} />
          )}
          <RunList snapshot={snapshot} onOpen={(runId) => openPanel({ kind: 'run', runId })} />
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

/** The last 30 days of runs, newest first, searchable and filtered by kind. */
function RunList({ snapshot, onOpen }: { snapshot: AutomationsSnapshot; onOpen: (runId: string) => void }) {
  const headingId = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const runs = filterRuns(snapshot.runs, query, filter, new Date());

  return (
    <section className="automations-section" aria-labelledby={headingId}>
      <div className="automations-runs-toolbar">
        <h2 id={headingId} className="automations-section-title">
          Runs
        </h2>
        <label className="automations-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search runs"
            aria-label="Search runs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="automations-filters" role="group" aria-label="Filter runs">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`automations-chip ${filter === id ? 'active' : ''}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {runs.length > 0 ? (
        <ul className="automations-runs">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} place={snapshot.queue[run.id]} onOpen={() => onOpen(run.id)} />
          ))}
        </ul>
      ) : (
        <p className="automations-hint">
          {query.trim() || filter !== 'all' ? 'No runs match.' : 'No runs in the last 30 days.'}
        </p>
      )}
    </section>
  );
}

function RunRow({ run, place, onOpen }: { run: RunListEntry; place?: number; onOpen: () => void }) {
  const about = runAbout(run);
  return (
    <li>
      <button type="button" className="automations-run-row" onClick={onOpen}>
        <StatusDot status={run.status} />
        <span className="automations-run-name">{runTitle(run)}</span>
        <span className="automations-run-about">
          <span className={`automations-run-status automations-run-status-${run.status}`}>{statusWord(run.status)}</span>
          {run.status === 'queued' && place !== undefined ? ` · ${place} in line` : ''}
          {/* With nothing to say about itself, a run's "about" is its status, already shown. */}
          {about !== run.status ? ` · ${about}` : ''}
        </span>
        <span className="automations-run-when">
          {triggerLabel(run)} · {formatTime(run.createdAt)}
        </span>
      </button>
    </li>
  );
}
