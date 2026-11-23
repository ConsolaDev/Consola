import { ChevronRight, CircleDot, Factory, GitPullRequest, Link2 } from 'lucide-react';
import { useId } from 'react';
import { NO_CHILDREN_WORDS } from '../domain/runMessages';
import { type RunSummary, starterOf } from '../domain/runs';
import { hashOfRun } from '../domain/runsRoute';
import {
  agoInWords,
  durationInWords,
  fullTime,
  itemLabel,
  progressWords,
  workedFor,
} from '../domain/runWords';
import type { WorkspaceMember } from '../domain/teams';
import { RunStatusIcon, StarterMark } from './RunStatusIcon';

/** What a request's row shows of the automations it started, once it is opened. */
export type ChildrenView =
  | { kind: 'loading' }
  | { kind: 'shown'; runs: RunSummary[] }
  | { kind: 'failed'; message: string };

const ITEM_ICONS = { pr: GitPullRequest, issue: CircleDot } as const;

/**
 * One run in the list, laid out as Warp lays out its runs: its status (a request's with the count
 * of automations it started), its title, then the item and the factory as chips, who started it
 * and when. The row is a link to the run's page. A request's row has a chevron of its own before
 * it, which opens the automations it started under it, each a link to its own page.
 *
 * `arrived` washes a row in once, for a run a refresh brought; `ended` draws the check of a run
 * seen ending while the list was open.
 */
export function RunRow({
  run,
  members,
  now,
  open,
  childrenView,
  arrived,
  ended,
  endedChildren,
  onToggle,
}: {
  run: RunSummary;
  members: WorkspaceMember[] | null;
  now: number;
  open: boolean;
  childrenView: ChildrenView | undefined;
  arrived: boolean;
  ended: boolean;
  endedChildren: ReadonlySet<string>;
  onToggle: () => void;
}) {
  const childrenId = useId();
  const opens = run.kind === 'request' && (run.children?.total ?? 0) > 0;
  const item = run.item;
  const ItemIcon =
    item?.kind && Object.hasOwn(ITEM_ICONS, item.kind) ? ITEM_ICONS[item.kind] : Link2;

  return (
    <li className="runs-entry" data-open={open || undefined}>
      <div className="runs-row" data-arrived={arrived || undefined}>
        {opens ? (
          <button
            type="button"
            className="runs-disclosure"
            aria-expanded={open}
            aria-controls={open ? childrenId : undefined}
            aria-label={`${open ? 'Hide' : 'Show'} the automations “${run.title}” started`}
            onClick={onToggle}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        ) : (
          <span className="runs-disclosure" aria-hidden="true" />
        )}
        <a className="runs-row-link" href={hashOfRun(run.id)}>
          <RunStatusIcon run={run} ended={ended} />
          <span className="runs-row-title">{run.title}</span>
          <span className="runs-row-meta">
            {item && (
              <span className="runs-tag" title={item.title}>
                <ItemIcon size={12} aria-hidden="true" />
                <span className="runs-tag-text">{itemLabel(item)}</span>
              </span>
            )}
            <span className="runs-tag runs-tag-factory" title={`Factory ${run.factory.name}`}>
              <Factory size={12} aria-hidden="true" />
              <span className="runs-tag-text">{run.factory.name}</span>
            </span>
            <StarterMark starter={starterOf(run, members)} trigger={run.trigger} />
            <time
              className="runs-row-time"
              dateTime={run.createdAt}
              title={fullTime(run.createdAt)}
            >
              {agoInWords(run.createdAt, now)}
            </time>
          </span>
        </a>
      </div>
      {open && (
        <div id={childrenId} className="runs-children">
          {childrenView === undefined || childrenView.kind === 'loading' ? (
            <p className="runs-children-note">Reading the automations it started…</p>
          ) : childrenView.kind === 'failed' ? (
            <p className="runs-children-note" role="alert">
              {childrenView.message}
            </p>
          ) : childrenView.runs.length === 0 ? (
            <p className="runs-children-note">{NO_CHILDREN_WORDS}</p>
          ) : (
            <ul className="runs-children-list">
              {childrenView.runs.map((child) => (
                <ChildRow
                  key={child.id}
                  run={child}
                  now={now}
                  ended={endedChildren.has(child.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** An automation a request started: its status, its name, where it is, and for how long. */
function ChildRow({ run, now, ended }: { run: RunSummary; now: number; ended: boolean }) {
  const worked = workedFor(run, now);
  const where = run.error ?? run.summary ?? (run.progress ? progressWords(run.progress) : null);
  return (
    <li>
      <a className="runs-child" href={hashOfRun(run.id)}>
        <RunStatusIcon run={run} size={14} ended={ended} />
        <span className="runs-child-name">{run.automation ?? run.title}</span>
        {where && (
          <span className="runs-child-where" data-tone={run.error ? 'error' : undefined}>
            {where}
          </span>
        )}
        <span className="runs-child-time">
          {worked !== null ? durationInWords(worked) : agoInWords(run.createdAt, now)}
        </span>
      </a>
    </li>
  );
}
