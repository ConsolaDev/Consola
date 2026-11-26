import { SearchX, Zap } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { hasFilters, NO_FILTERS, queryOfFilters } from '../domain/runFilters';
import type { RunFilters } from '../domain/runFilters';
import {
  messageForRunAnswer,
  messageForRunsAnswer,
  NO_MATCH_TITLE,
  NO_MATCH_WORDS,
  NO_RUNS_TITLE,
  noRunsWords,
  refreshFailedWords,
} from '../domain/runMessages';
import {
  isLive,
  LIST_POLL_QUIET_MS,
  listPollDelay,
  mergeRefresh,
  refreshLimit,
} from '../domain/runs';
import type { PhaseCounts, RunFacets, RunList, RunsAnswer, RunSummary } from '../domain/runs';
import type { WorkspaceMember } from '../domain/teams';
import type { MyWorkspace } from '../domain/workspace';
import { runsService } from '../services/runs';
import { showRunsFilters } from '../services/runsAddress';
import { RunRow } from './RunRow';
import type { ChildrenView } from './RunRow';
import { RunsToolbar } from './RunsToolbar';
import { useNow, usePoll } from './usePoll';
import './RunsList.css';

/** The rows shown for one set of filters, and what happened to them since they were first read. */
type Shown = {
  /** The filters' query these rows answer: rows for other filters are never shown. */
  query: string;
  runs: RunSummary[];
  nextCursor: string | null;
  /** When a refresh last failed, while the rows stay as they were; null after one that worked. */
  failedAt: string | null;
  /** Runs a refresh brought, washed in once. */
  arrived: ReadonlySet<string>;
  /** Runs seen ending while the list was open, whose check draws itself once. */
  ended: ReadonlySet<string>;
};

type ListView =
  | { kind: 'loading' }
  | { kind: 'shown'; shown: Shown }
  | { kind: 'refused'; query: string; answer: Exclude<RunsAnswer, { kind: 'listed' }> };

/** Every run in `next` that was not in `before`, and every one that was live there and is not now. */
function changesBetween(
  before: readonly RunSummary[],
  next: readonly RunSummary[],
): { arrived: string[]; ended: string[] } {
  const was = new Map(before.map((run) => [run.id, run]));
  const arrived: string[] = [];
  const ended: string[] = [];
  for (const run of next) {
    const earlier = was.get(run.id);
    if (!earlier) arrived.push(run.id);
    else if (isLive(earlier) && !isLive(run)) ended.push(run.id);
  }
  return { arrived, ended };
}

/** The rows after the cell's answer for `query`: merged into the rows shown for it, or new. */
function shownAfter(previous: ListView, query: string, list: RunList): Shown {
  const before =
    previous.kind === 'shown' && previous.shown.query === query ? previous.shown : null;
  if (!before) {
    return {
      query,
      runs: list.runs,
      nextCursor: list.nextCursor,
      failedAt: null,
      arrived: new Set(),
      ended: new Set(),
    };
  }
  const merged = mergeRefresh(before, list);
  const { arrived, ended } = changesBetween(before.runs, merged.runs);
  return {
    ...before,
    ...merged,
    failedAt: null,
    arrived: arrived.length ? new Set([...before.arrived, ...arrived]) : before.arrived,
    ended: ended.length ? new Set([...before.ended, ...ended]) : before.ended,
  };
}

/**
 * The workspace's runs, newest first, narrowed by the filters the address holds. It reads them
 * again while the page shows: every few seconds while a run shown can still change, now and then
 * once none can, never while the tab is hidden. A refresh reads every row shown again, so a run
 * that ends changes in place, and one that arrives washes in at the top.
 *
 * A request's row opens to the automations it started, read from its own page's answer and read
 * again with the list while they can change.
 */
export function RunsList({
  workspace,
  filters,
  members,
}: {
  workspace: MyWorkspace;
  filters: RunFilters;
  members: WorkspaceMember[] | null;
}) {
  const query = queryOfFilters(filters);
  const [view, setView] = useState<ListView>({ kind: 'loading' });
  // The chips' numbers and the menus, kept while new filters load, so the row does not jump.
  const [toolbar, setToolbar] = useState<{ counts: PhaseCounts; facets: RunFacets } | null>(null);
  const [open, setOpen] = useState<string[]>([]);
  const [childrenOf, setChildrenOf] = useState<Record<string, ChildrenView>>({});
  const [endedChildren, setEndedChildren] = useState<ReadonlySet<string>>(new Set());
  const [more, setMore] = useState<{ loading: boolean; failed: string | null }>({
    loading: false,
    failed: null,
  });
  const now = useNow(30_000);

  // What the reads see as they start: the rows shown, and the requests opened.
  const latest = useRef({ view, open, childrenOf, query, filters });
  latest.current = { view, open, childrenOf, query, filters };

  /** Reads a request's automations, and shows them under its row. */
  const readChildren = useCallback(
    async (requestId: string, current: () => boolean = () => true) => {
      const answer = await runsService.loadRun(workspace, requestId);
      if (!current()) return null;
      if (answer.kind === 'found') {
        const runs = answer.detail.children;
        const before = latest.current.childrenOf[requestId];
        if (before?.kind === 'shown') {
          const { ended } = changesBetween(before.runs, runs);
          if (ended.length) setEndedChildren((all) => new Set([...all, ...ended]));
        }
        setChildrenOf((previous) => ({ ...previous, [requestId]: { kind: 'shown', runs } }));
        return runs;
      }
      setChildrenOf((previous) =>
        // A refresh that fails keeps what was read; only a first read says why it failed.
        previous[requestId]?.kind === 'shown'
          ? previous
          : {
              ...previous,
              [requestId]: { kind: 'failed', message: messageForRunAnswer(answer, workspace) },
            },
      );
      return null;
    },
    [workspace],
  );

  const readNow = usePoll(`${workspace.id} ${query}`, async (current) => {
    const { view: shownView, open: opened, childrenOf: known } = latest.current;
    const shown =
      shownView.kind === 'shown' && shownView.shown.query === query ? shownView.shown : null;
    // An opened request is read again while it, or an automation it started, can change, or
    // after a read of it failed; never while its first read is still under way.
    const liveRequest = (id: string) => {
      const entry = known[id];
      if (entry?.kind === 'loading') return false;
      if (entry?.kind !== 'shown') return true;
      const row = shown?.runs.find((run) => run.id === id);
      return (row ? isLive(row) : false) || entry.runs.some(isLive);
    };
    const [answer, childRuns] = await Promise.all([
      runsService.loadRuns(workspace, filters, { limit: refreshLimit(shown?.runs.length ?? 0) }),
      Promise.all(opened.filter(liveRequest).map((id) => readChildren(id, current))),
    ]);
    if (!current()) return null;
    if (answer.kind === 'listed') {
      setToolbar({ counts: answer.list.counts, facets: answer.list.facets });
      setView((previous) => ({ kind: 'shown', shown: shownAfter(previous, query, answer.list) }));
      return listPollDelay([...answer.list.runs, ...childRuns.flatMap((runs) => runs ?? [])]);
    }
    if (shown) {
      // Rows already shown stay, saying when they were read; the next read may work.
      setView((previous) =>
        previous.kind === 'shown' && previous.shown.query === query
          ? {
              kind: 'shown',
              shown: {
                ...previous.shown,
                failedAt: previous.shown.failedAt ?? new Date().toISOString(),
              },
            }
          : previous,
      );
      return LIST_POLL_QUIET_MS;
    }
    setView({ kind: 'refused', query, answer });
    return null;
  });

  const change = (next: RunFilters) => showRunsFilters(next);

  const toggle = (run: RunSummary) => {
    if (open.includes(run.id)) {
      setOpen(open.filter((id) => id !== run.id));
      return;
    }
    setOpen([...open, run.id]);
    if (childrenOf[run.id]?.kind !== 'shown') {
      setChildrenOf((previous) => ({ ...previous, [run.id]: { kind: 'loading' } }));
      void readChildren(run.id);
    }
  };

  const loadMore = async (shown: Shown) => {
    if (!shown.nextCursor || more.loading) return;
    setMore({ loading: true, failed: null });
    const asked = shown.query;
    const answer = await runsService.loadRuns(workspace, filters, { cursor: shown.nextCursor });
    if (latest.current.query !== asked) {
      setMore({ loading: false, failed: null });
      return;
    }
    if (answer.kind !== 'listed') {
      setMore({ loading: false, failed: messageForRunsAnswer(answer, workspace) });
      return;
    }
    setMore({ loading: false, failed: null });
    setView((previous) => {
      if (previous.kind !== 'shown' || previous.shown.query !== asked) return previous;
      const had = new Set(previous.shown.runs.map((run) => run.id));
      return {
        kind: 'shown',
        shown: {
          ...previous.shown,
          runs: [...previous.shown.runs, ...answer.list.runs.filter((run) => !had.has(run.id))],
          nextCursor: answer.list.nextCursor,
        },
      };
    });
  };

  const shown = view.kind === 'shown' && view.shown.query === query ? view.shown : null;
  const refused = view.kind === 'refused' && view.query === query ? view.answer : null;
  const narrowed = hasFilters(filters);

  return (
    <div className="runs">
      <RunsToolbar
        filters={filters}
        counts={toolbar?.counts ?? null}
        facets={toolbar?.facets ?? null}
        onChange={change}
      />

      {shown?.failedAt && (
        <p className="runs-stale" role="status">
          {refreshFailedWords(shown.failedAt)}
        </p>
      )}

      {refused ? (
        <div className="runs-notice" role="alert">
          <p>{messageForRunsAnswer(refused, workspace)}</p>
          {refused.kind === 'invalid' ? (
            <button type="button" className="button" onClick={() => change(NO_FILTERS)}>
              Clear filters
            </button>
          ) : (
            (refused.kind === 'pending' || refused.kind === 'unavailable') && (
              <button type="button" className="button" onClick={readNow}>
                Try again
              </button>
            )
          )}
        </div>
      ) : !shown ? (
        <SkeletonRows />
      ) : shown.runs.length === 0 ? (
        narrowed ? (
          <div className="runs-empty">
            <span className="runs-empty-tile" aria-hidden="true">
              <SearchX size={20} />
            </span>
            <h2 className="runs-empty-title">{NO_MATCH_TITLE}</h2>
            <p className="runs-empty-words">{NO_MATCH_WORDS}</p>
            <button type="button" className="button" onClick={() => change(NO_FILTERS)}>
              Clear filters
            </button>
          </div>
        ) : (
          <div className="runs-empty">
            <span className="runs-empty-tile" aria-hidden="true">
              <Zap size={20} />
            </span>
            <h2 className="runs-empty-title">{NO_RUNS_TITLE}</h2>
            <p className="runs-empty-words">{noRunsWords(workspace.name)}</p>
          </div>
        )
      ) : (
        <>
          <ul className="runs-list" aria-label="Runs">
            {shown.runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                members={members}
                now={now}
                open={open.includes(run.id)}
                childrenView={childrenOf[run.id]}
                arrived={shown.arrived.has(run.id)}
                ended={shown.ended.has(run.id)}
                endedChildren={endedChildren}
                onToggle={() => toggle(run)}
              />
            ))}
          </ul>
          {(shown.nextCursor || more.failed) && (
            <div className="runs-more">
              {more.failed && (
                <p className="runs-more-failed" role="alert">
                  {more.failed}
                </p>
              )}
              {shown.nextCursor && (
                <button
                  type="button"
                  className="button"
                  disabled={more.loading}
                  aria-busy={more.loading}
                  onClick={() => void loadMore(shown)}
                >
                  {more.loading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The list's shape while its first answer is on the way: still rows, in the rows' own places. */
function SkeletonRows() {
  const widths = [62, 48, 71, 40, 56, 66];
  return (
    <div className="runs-skeleton" aria-busy="true" role="status">
      <span className="sr-only">Loading runs…</span>
      {widths.map((width) => (
        <div key={width} className="runs-skeleton-row" aria-hidden="true">
          <span className="runs-skeleton-dot" />
          <span className="runs-skeleton-bar" style={{ width: `${width}%` }} />
          <span className="runs-skeleton-bar runs-skeleton-meta" />
        </div>
      ))}
    </div>
  );
}
