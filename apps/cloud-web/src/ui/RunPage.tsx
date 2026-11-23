import { ExternalLink, List } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NO_FILTERS, withFactory } from '../domain/runFilters';
import { messageForRunAnswer, runRefreshFailedWords } from '../domain/runMessages';
import {
  type RunAnswer,
  type RunDetail,
  RUN_POLL_WAITING_MS,
  runPollDelay,
  safeItemUrl,
} from '../domain/runs';
import { hashOfRun, type RunPlace } from '../domain/runsRoute';
import { itemLabel, itemNoun, lookOf, statusWords } from '../domain/runWords';
import type { WorkspaceMember } from '../domain/teams';
import type { MyWorkspace } from '../domain/workspace';
import { readRunPagePrefs, type RunPagePrefs, writeRunPagePrefs } from '../services/runPagePrefs';
import { runsService } from '../services/runs';
import { showRunPlace } from '../services/runsAddress';
import { ApprovalCard } from './ApprovalCard';
import { type RunInfoSectionId, RunInfoPanel } from './RunInfoPanel';
import { RequestPane, StepsPane } from './RunPanes';
import { StatusGlyph } from './RunStatusIcon';
import { useNow, usePoll } from './usePoll';
import './RunPage.css';

type PageView =
  | { kind: 'loading' }
  | { kind: 'shown'; detail: RunDetail; failedAt: string | null }
  | { kind: 'refused'; answer: Exclude<RunAnswer, { kind: 'found' }> };

/**
 * One run, laid out as the desktop lays out a session: its header (the way back to the list, the
 * run's name, its status, and its controls), then its main pane beside the info panel. A request's
 * pane is its conversation with the orchestrator; an automation run's is its steps.
 *
 * It reads the run again every few seconds while the run or an automation it started works, more
 * slowly while it waits on someone, and not at all once nothing on it can change or the tab is
 * hidden. A refresh that fails keeps the run as it was read, and says when that was.
 */
export function RunPage({
  workspace,
  runId,
  place,
  meId,
  members,
  listHash,
}: {
  workspace: MyWorkspace;
  runId: string;
  /** Where on the page the address says: steps or file, and the step chosen. */
  place: RunPlace;
  /** The person's global id, to say "you" of their own answers. */
  meId: string;
  members: WorkspaceMember[] | null;
  listHash: string;
}) {
  const [view, setView] = useState<PageView>({ kind: 'loading' });
  const shownView = useRef(view);
  shownView.current = view;
  const [prefs, setPrefs] = useState<RunPagePrefs>(readRunPagePrefs);
  const detail = view.kind === 'shown' ? view.detail : null;
  const live = detail ? runPollDelay(detail) !== null : false;
  const now = useNow(live ? 1_000 : 30_000);
  // The file's own answer says the latest version; a run without one asks the list's facets.
  const askedLatest = useLatestVersion(
    workspace.id,
    detail && !detail.source ? detail.run.factory.id : null,
  );
  const latestVersion = detail?.source?.latestVersion ?? askedLatest;

  const readNow = usePoll(`${workspace.id} ${runId}`, async (current) => {
    const answer = await runsService.loadRun(workspace, runId);
    if (!current()) return null;
    if (answer.kind === 'found') {
      setView({ kind: 'shown', detail: answer.detail, failedAt: null });
      return runPollDelay(answer.detail);
    }
    const previous = shownView.current;
    if (answer.kind !== 'not-found' && previous.kind === 'shown') {
      // The run stays as it was read, saying when; the next read may work.
      setView({ ...previous, failedAt: previous.failedAt ?? new Date().toISOString() });
      return RUN_POLL_WAITING_MS;
    }
    setView({ kind: 'refused', answer });
    return null;
  });

  const change = (next: RunPagePrefs) => {
    setPrefs(next);
    writeRunPagePrefs(next);
  };
  const isOpen = (id: RunInfoSectionId) => !prefs.folded.includes(id);
  const toggleSection = (id: RunInfoSectionId) =>
    change({
      ...prefs,
      folded: isOpen(id) ? [...prefs.folded, id] : prefs.folded.filter((folded) => folded !== id),
    });

  const run = detail?.run ?? null;
  const itemUrl = run?.item ? safeItemUrl(run.item.url) : null;
  const approval = detail?.approval ? (
    <ApprovalCard
      approval={detail.approval}
      runId={runId}
      workspace={workspace}
      meId={meId}
      members={members}
      now={now}
      onAnswered={readNow}
    />
  ) : null;
  const look = run ? lookOf(run) : null;

  return (
    <div className="run-page">
      <header className="run-header">
        <h1 className="run-crumbs">
          <a className="run-crumb" href={listHash}>
            Runs
          </a>
          <span className="run-crumb-sep" aria-hidden="true">
            /
          </span>
          {detail?.parent && (
            <>
              <a className="run-crumb run-crumb-parent" href={hashOfRun(detail.parent.id)}>
                {detail.parent.title}
              </a>
              <span className="run-crumb-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
          <span className="run-crumb-name">
            {run ? run.title : view.kind === 'refused' ? 'Not found' : ''}
          </span>
        </h1>
        {run && look && (
          <span className="run-state" data-look={look}>
            <span className="run-status" data-look={look}>
              <StatusGlyph look={look} size={14} />
            </span>
            {statusWords(run)}
          </span>
        )}
        <div className="run-controls">
          {run?.item && itemUrl && (
            <a
              className="run-control"
              href={itemUrl}
              target="_blank"
              rel="noreferrer noopener"
              title={`Open ${itemLabel(run.item)} on its site`}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span className="sr-only">
                Open the {itemNoun(run.item)} {itemLabel(run.item)} (opens in a new tab)
              </span>
            </a>
          )}
          {detail && (
            <>
              <span className="run-controls-rule" aria-hidden="true" />
              <button
                type="button"
                className="run-control"
                aria-pressed={prefs.infoPanel}
                aria-label={prefs.infoPanel ? 'Hide info panel' : 'Show info panel'}
                title={prefs.infoPanel ? 'Hide info panel' : 'Show info panel'}
                onClick={() => change({ ...prefs, infoPanel: !prefs.infoPanel })}
              >
                <List size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </header>

      {view.kind === 'loading' && (
        <div className="run-loading" role="status" aria-busy="true">
          <span className="sr-only">Loading the run…</span>
          <span className="run-loading-bar" />
          <span className="run-loading-bar run-loading-short" />
        </div>
      )}

      {view.kind === 'refused' && (
        <div className="run-notice" role="alert">
          <p>{messageForRunAnswer(view.answer, workspace)}</p>
          <div className="run-notice-actions">
            {(view.answer.kind === 'pending' || view.answer.kind === 'unavailable') && (
              <button type="button" className="button" onClick={readNow}>
                Try again
              </button>
            )}
            <a className="button" href={listHash}>
              Back to runs
            </a>
          </div>
        </div>
      )}

      {view.kind === 'shown' && (
        <div className="run-body" data-info={prefs.infoPanel || undefined}>
          <section className="run-pane" aria-label={view.detail.request ? 'Conversation' : 'Steps'}>
            {view.failedAt && (
              <p className="run-stale" role="status">
                {runRefreshFailedWords(view.failedAt)}
              </p>
            )}
            {view.detail.request ? (
              <RequestPane detail={view.detail} members={members} now={now} lead={approval} />
            ) : (
              <StepsPane
                detail={view.detail}
                now={now}
                place={place}
                onPlace={(next) => showRunPlace(runId, next)}
                lead={approval}
              />
            )}
          </section>
          {prefs.infoPanel && (
            <div className="run-info">
              <RunInfoPanel
                detail={view.detail}
                members={members}
                latestVersion={latestVersion}
                now={now}
                isOpen={isOpen}
                onToggle={toggleSection}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The latest version of a run's factory, to say when the run used an older one; null until it
 * is known. The cell names it among the list's facets, read once for the factory.
 */
function useLatestVersion(workspaceId: string, factoryId: string | null): number | null {
  const [latest, setLatest] = useState<{ factoryId: string; version: number } | null>(null);
  useEffect(() => {
    if (factoryId === null) return;
    let live = true;
    void runsService
      .loadRuns({ id: workspaceId }, withFactory(NO_FILTERS, factoryId), { limit: 1 })
      .then((answer) => {
        if (!live || answer.kind !== 'listed') return;
        const factory = answer.list.facets.factories.find((listed) => listed.id === factoryId);
        if (factory) setLatest({ factoryId, version: factory.latestVersion });
      });
    return () => {
      live = false;
    };
  }, [workspaceId, factoryId]);
  return latest?.factoryId === factoryId ? latest.version : null;
}
