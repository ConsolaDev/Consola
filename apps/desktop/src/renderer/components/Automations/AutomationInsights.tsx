import type { CSSProperties } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { RunListEntry } from '../../../shared/automations';
import {
  formatAgo,
  formatElapsed,
  runsByDay,
  statusCounts,
  statusCountsInWords,
  type RunDay,
  type RunInsights,
} from './presentation';

/**
 * An automation's last 30 days as CircleCI's Insights sums up a pipeline:
 * how often it ran, how often that worked, how long it takes, when it last
 * failed — and every day as a bar, so a schedule's gaps show as gaps.
 */
export function AutomationInsights({
  insights,
  runs,
  now,
  onOpenRun,
}: {
  insights: RunInsights;
  /** What history keeps for it, newest first. */
  runs: RunListEntry[];
  now: Date;
  onOpenRun: (runId: string) => void;
}) {
  const rate = insights.successRate;
  return (
    <div className="automations-insights">
      <dl className="automations-stats">
        <Stat label="Runs" value={String(insights.total)} />
        <Stat
          label="Success rate"
          value={rate === null ? '—' : percent(rate)}
          tone={rate === 1 ? 'good' : rate !== null && rate < 0.5 ? 'bad' : undefined}
          title="Completed out of the runs that worked to an end; dismissed and waiting runs are left out"
        />
        <Stat
          label="Median duration"
          value={insights.medianMs === null ? '—' : formatElapsed(insights.medianMs)}
        />
        <Stat
          label="Last failure"
          value={insights.lastFailureAt ? formatAgo(insights.lastFailureAt, now) : 'None'}
          tone={insights.lastFailureAt ? 'bad' : undefined}
        />
      </dl>
      <DayChart days={runsByDay(runs, now)} onOpenRun={onOpenRun} />
    </div>
  );
}

/** Rounded so that neither end lies: 99.6% is not "100%", and one success in 300 is not "0%". */
function percent(rate: number): string {
  if (rate === 1 || rate === 0) return `${rate * 100}%`;
  return `${Math.min(99, Math.max(1, Math.round(rate * 100)))}%`;
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: 'good' | 'bad'; title?: string }) {
  return (
    <div className={`automations-stat ${tone ? `automations-stat-${tone}` : ''}`} title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * One bar per day, today on the right, stacked by how the day's runs went
 * in the strip's colours. A bar says its day on hover and opens the day's
 * latest run on click; to a screen reader the chart is its totals, and the
 * run list below names every run.
 */
function DayChart({ days, onOpenRun }: { days: Array<RunDay<RunListEntry>>; onOpenRun: (runId: string) => void }) {
  const busiest = Math.max(1, ...days.map((day) => day.runs.length));
  const total = days.reduce((sum, day) => sum + day.runs.length, 0);
  const active = days.filter((day) => day.runs.length > 0).length;
  const first = days[0]?.day;
  return (
    <Tooltip.Provider delayDuration={80} skipDelayDuration={300}>
      <figure className="automations-days">
        <div
          className="automations-days-bars"
          role="img"
          aria-label={`Runs per day over the last ${days.length} days: ${total} ${total === 1 ? 'run' : 'runs'} on ${active} ${active === 1 ? 'day' : 'days'}`}
        >
          {days.map((day, index) => (
            <DayBar
              key={day.day.toISOString()}
              day={day}
              busiest={busiest}
              // Today grows first and the month ripples back from it.
              order={days.length - 1 - index}
              today={index === days.length - 1}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
        <figcaption className="automations-days-axis" aria-hidden="true">
          <span>{first ? first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>
          <span>Today</span>
        </figcaption>
      </figure>
    </Tooltip.Provider>
  );
}

function DayBar({
  day,
  busiest,
  order,
  today,
  onOpenRun,
}: {
  day: RunDay<RunListEntry>;
  busiest: number;
  order: number;
  today: boolean;
  onOpenRun: (runId: string) => void;
}) {
  const count = day.runs.length;
  const latest = day.runs[0];
  const label = today ? 'Today' : day.day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span
          className={`automations-day ${today ? 'automations-day-today' : ''} ${latest ? 'automations-day-ran' : ''}`}
          style={{ '--order': order } as CSSProperties}
          onClick={latest ? () => onOpenRun(latest.id) : undefined}
        >
          {count === 0 ? (
            <span className="automations-day-none" />
          ) : (
            // Keyed by its count, so a run landing today grows the bar again.
            <span key={count} className="automations-day-stack" style={{ height: `${Math.max(14, (count / busiest) * 100)}%` }}>
              {statusCounts(day.runs).map(({ status, count: runs }) => (
                <span key={status} className={`automations-day-part automations-bar-${status}`} style={{ flexGrow: runs }} />
              ))}
            </span>
          )}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content automations-bar-tooltip" side="top" sideOffset={6}>
          <strong>{label}</strong>
          <span className="automations-bar-tooltip-meta">
            {count === 0 ? 'No runs' : `${count} ${count === 1 ? 'run' : 'runs'}: ${statusCountsInWords(day.runs)}`}
          </span>
          {latest && (
            <span className="automations-bar-tooltip-meta">{count === 1 ? 'Click to open it' : 'Click to open the latest'}</span>
          )}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
