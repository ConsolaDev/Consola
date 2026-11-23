import { ArrowUpRight, ChevronRight, Hand, Workflow } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { messageForRunAnswer, NO_AUTOMATIONS_STARTED } from '../domain/runMessages';
import {
  isLive,
  type RunAnswer,
  type RunDetail,
  RUN_POLL_WAITING_MS,
  type RunSummary,
  runPollDelay,
} from '../domain/runs';
import { hashOfRun, type TracePlace } from '../domain/runsRoute';
import {
  childFactsWords,
  childStateWords,
  itemLabel,
  lookOf,
  statusWords,
} from '../domain/runWords';
import type { MyWorkspace } from '../domain/workspace';
import { runsService } from '../services/runs';
import { revealElement } from './reveal';
import { RunStatusIcon } from './RunStatusIcon';
import { StepTrace } from './StepTrace';
import { usePoll } from './usePoll';
import './RequestAutomations.css';

/** An automation that failed, works or waits opens by itself: where the request stands now. */
function opensItself(run: RunSummary): boolean {
  return isLive(run) || run.phase === 'failed';
}

/**
 * The automations a request's orchestrator started, in the order it started them, each numbered
 * so: its status, its automation, where it is (the step it is on, or how it ended), when it
 * started, how long it worked and what it cost. The page's own reads keep them live.
 *
 * A row opens in place onto that run's step trace (`StepTrace`, Steps and File included), read
 * from its own answer and read again while it can change; "Open run" goes to its own page. An
 * automation that failed, works or waits opens by itself; the person's choice wins over that.
 * Opening one puts it in the address (`run=<id>`), and `reveal` (the info panel's rows, or an
 * address that names one) opens it, scrolls to it and lights it once.
 */
export function RequestAutomations({
  detail,
  workspace,
  now,
  reveal,
  onOpen,
}: {
  detail: RunDetail;
  workspace: MyWorkspace;
  now: number;
  /** An automation to open and take the person to; a new `seq` asks again. */
  reveal: { run: string; seq: number } | null;
  /** The person opened an automation: the page puts it in the address. */
  onOpen: (runId: string) => void;
}) {
  const children = detail.children;
  const rows = useRef(new Map<string, HTMLLIElement>());
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const arriving = children
    .filter((child) => opensItself(child) && !opened.has(child.id))
    .map((child) => child.id);
  if (arriving.length > 0) setOpened(new Set([...opened, ...arriving]));
  const isOpen = (runId: string) =>
    chosen[runId] ?? (opened.has(runId) || arriving.includes(runId));

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `seq` is what asks again.
  useEffect(() => {
    if (!reveal || !children.some((child) => child.id === reveal.run)) return;
    setChosen((current) => ({ ...current, [reveal.run]: true }));
    requestAnimationFrame(() => revealElement(rows.current.get(reveal.run)));
  }, [reveal?.seq]);

  if (children.length === 0) {
    return (
      <div className="automations-empty">
        <span className="automations-empty-tile" aria-hidden="true">
          <Workflow size={18} />
        </span>
        <p>{NO_AUTOMATIONS_STARTED}</p>
      </div>
    );
  }

  return (
    <ol className="automations-list" aria-label="Automations the orchestrator started, in order">
      {children.map((child, index) => (
        <ChildRow
          key={child.id}
          rowRef={(element) => {
            if (element) rows.current.set(child.id, element);
            else rows.current.delete(child.id);
          }}
          number={index + 1}
          run={child}
          workspace={workspace}
          now={now}
          open={isOpen(child.id)}
          onToggle={() => {
            const opening = !isOpen(child.id);
            setChosen((current) => ({ ...current, [child.id]: opening }));
            if (opening) onOpen(child.id);
          }}
        />
      ))}
    </ol>
  );
}

/** One automation the request started: a row that opens in place onto its trace. */
function ChildRow({
  rowRef,
  number,
  run,
  workspace,
  now,
  open,
  onToggle,
}: {
  rowRef: (element: HTMLLIElement | null) => void;
  number: number;
  run: RunSummary;
  workspace: MyWorkspace;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const name = run.automation ?? run.title;
  const state = childStateWords(run);
  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="automation"
      data-look={lookOf(run)}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="automation-row"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
      >
        <span className="automation-number">
          <span aria-hidden="true">{number}</span>
          <span className="sr-only">Started {ordinal(number)}:</span>
        </span>
        <RunStatusIcon run={run} />
        <span className="automation-main">
          <span className="automation-name">
            <span className="automation-title">{name}</span>
            {/* Everything a request starts is an automation, so only a request it started is named as one. */}
            {run.kind === 'request' && <span className="automation-kind">Request</span>}
            {run.item && <span className="automation-item">{itemLabel(run.item)}</span>}
          </span>
          <span className="automation-state">{state}</span>
        </span>
        <span className="automation-facts">{childFactsWords(run, now)}</span>
        <ChevronRight size={14} className="automation-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={bodyId} className="automation-body">
          <ChildTrace run={run} workspace={workspace} now={now} />
        </div>
      )}
    </li>
  );
}

type ChildView =
  | { kind: 'loading' }
  | { kind: 'shown'; detail: RunDetail }
  | { kind: 'refused'; answer: Exclude<RunAnswer, { kind: 'found' }> };

/**
 * An automation's trace, inside its row: read from its own answer as the row opens, and read again
 * while it can change, as its own page reads it. Its Steps and File are its own, never the
 * page's address.
 */
function ChildTrace({
  run,
  workspace,
  now,
}: {
  run: RunSummary;
  workspace: MyWorkspace;
  now: number;
}) {
  const [view, setView] = useState<ChildView>({ kind: 'loading' });
  const [trace, setTrace] = useState<TracePlace>({ view: 'steps', step: null });
  const shown = useRef(view);
  shown.current = view;

  const readNow = usePoll(`${workspace.id} ${run.id}`, async (current) => {
    const answer = await runsService.loadRun(workspace, run.id);
    if (!current()) return null;
    if (answer.kind === 'found') {
      setView({ kind: 'shown', detail: answer.detail });
      return runPollDelay(answer.detail);
    }
    // A refresh that fails keeps what was read; only a first read says why.
    if (shown.current.kind === 'shown' && answer.kind !== 'not-found') return RUN_POLL_WAITING_MS;
    setView({ kind: 'refused', answer });
    return null;
  });

  const waits = view.kind === 'shown' && view.detail.approval && !view.detail.approval.answer;
  return (
    <>
      <div className="automation-body-head">
        {run.title !== (run.automation ?? run.title) && (
          <span className="automation-about">{run.title}</span>
        )}
        <a className="automation-open" href={hashOfRun(run.id)}>
          Open run
          <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </div>
      {waits && (
        <p className="automation-waits">
          <Hand size={14} aria-hidden="true" />
          {statusWords(run)}. Answer it on <a href={hashOfRun(run.id)}>its own page</a>.
        </p>
      )}
      {view.kind === 'loading' && <p className="automation-quiet">Reading its steps…</p>}
      {view.kind === 'refused' && (
        <div className="automation-quiet" role="alert">
          <p>{messageForRunAnswer(view.answer, workspace)}</p>
          {(view.answer.kind === 'pending' || view.answer.kind === 'unavailable') && (
            <button type="button" className="automation-retry" onClick={readNow}>
              Try again
            </button>
          )}
        </div>
      )}
      {view.kind === 'shown' && (
        <StepTrace detail={view.detail} now={now} place={trace} onPlace={setTrace} nested />
      )}
    </>
  );
}

/** `1st`, `2nd`, `3rd`, `4th`: a start's place, as a screen reader says it. */
function ordinal(number: number): string {
  const tens = number % 100;
  if (tens >= 11 && tens <= 13) return `${number}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] ?? 'th';
  return `${number}${suffix}`;
}
