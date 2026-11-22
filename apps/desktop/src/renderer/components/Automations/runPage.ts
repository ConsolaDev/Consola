import {
  isAgentRunPreview,
  isStepsRunPreview,
  type RunRecord,
  type StepRun,
  type StepRunStatus,
  type StepsRunPreview,
} from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';
import {
  clockTime,
  formatAgo,
  formatDuration,
  formatElapsed,
  rejectedAtGate,
  type RunFacts,
} from './presentation';

/**
 * What a run's own page shows, as a CI service shows one run of a pipeline:
 * the stages it went through and the one it stopped in, how long each took,
 * how it compares with the automation's other runs, and its steps on a
 * timeline. Everything here is read from the run record and its transcript.
 */

/** A run in one of these is over. The renderer's copy: factory-spec's own pulls in Node's crypto. */
const ENDED: ReadonlySet<RunFacts['status']> = new Set(['completed', 'failed', 'rejected']);

export type RunStageKey = 'trigger' | 'preview' | 'approval' | 'queue' | 'run' | 'notify' | 'step';

/**
 * How a run went through one stage, as a CI graph colours its jobs: through
 * it, broke there, turned down there, standing in it now, or never reached
 * it — `skipped` once the run is over, `pending` while it may still come.
 */
export type RunStageState =
  | 'passed'
  | 'failed'
  | 'stopped'
  | 'waiting'
  | 'queued'
  | 'running'
  | 'skipped'
  | 'pending'
  | 'reported';

export interface RunStage {
  key: RunStageKey;
  state: RunStageState;
  /** For a `step` stage: the step this node is, as the record has it. */
  step?: {
    id: string;
    kind: StepRun['kind'];
    status: StepRunStatus;
    skipped?: string;
    error?: string;
    attempt: number;
  };
  /** How long the run spent in it, when the record says; still counting while the run is in it. */
  ms: number | null;
}

/**
 * The stages a run has, in order, and how it went through each.
 *
 * Which stages: every run has its trigger. A tool run that does not just
 * run (`confirm`, `notify`) previews first. `confirm` waits for a person;
 * an agent run then waits for a slot; then it runs. `notify` only tells.
 *
 * Where it stopped is read from what the record has: `startedAt` is set
 * only once it worked, `approvedAt` once a person approved it, and a tool
 * run's `approval` once it asked. A run from before `approvedAt` was
 * recorded that was turned down or failed before starting is placed at its
 * approval when it asked for one.
 */
export function runStages(run: RunRecord, now: Date): RunStage[] {
  if (isStepsRunPreview(run.result)) return stepsRunStages(run, now);
  const agent = isAgentRunPreview(run.result);
  const keys: RunStageKey[] = ['trigger'];
  if (!agent && run.mode !== 'auto') keys.push('preview');
  if (run.mode === 'notify') {
    keys.push('notify');
  } else {
    if (run.mode === 'confirm') keys.push('approval');
    if (agent) keys.push('queue');
    keys.push('run');
  }

  const here = stopPoint(run, keys, agent);
  const at = keys.indexOf(here.key);
  const open = !ENDED.has(run.status);
  const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
  const created = time(run.createdAt);
  const approved = time(run.approvedAt);
  const started = time(run.startedAt);
  const finished = time(run.finishedAt);
  const nowMs = now.getTime();

  return keys.map((key, index) => {
    const state: RunStageState =
      index < at ? 'passed' : index === at ? here.state : open ? 'pending' : 'skipped';
    if (state === 'skipped' || state === 'pending') return { key, state, ms: null };
    const isHere = index === at;
    // Where the run is now, the stage runs to now; where it ended, to its end.
    const until = (otherwise: number) => (isHere ? (open ? nowMs : finished) : otherwise);
    let ms: number | null = null;
    if (key === 'preview') ms = isHere ? span(created, until(NaN)) : null;
    // A tool run starts the moment it is approved, so its start ends the wait for an older record too.
    if (key === 'approval') ms = span(created, until(firstOf(approved, agent ? NaN : started)));
    if (key === 'queue')
      ms = span(firstOf(approved, run.mode === 'confirm' ? NaN : created), until(started));
    if (key === 'run') ms = span(started, until(finished));
    return { key, state, ms };
  });
}

/**
 * A `steps:` run's stages: its trigger, its approval when it asked, then one
 * node per step in file order. A step's own status says where the run is, so
 * only a `pending` step reads the run: once the run is over it never came.
 */
function stepsRunStages(run: RunRecord, now: Date): RunStage[] {
  const open = !ENDED.has(run.status);
  const nowMs = now.getTime();
  const stages: RunStage[] = [{ key: 'trigger', state: 'passed', ms: null }];
  if (run.mode === 'confirm') {
    const waiting = run.status === 'needs-approval';
    // A run a person rejected at a gate ran first: its approval passed, whatever an old record says of it.
    const turnedDown = run.status === 'rejected' && !run.approvedAt && !rejectedAtGate(run);
    const created = Date.parse(run.createdAt);
    const until = waiting
      ? nowMs
      : turnedDown
        ? Date.parse(run.finishedAt ?? '')
        : firstOf(Date.parse(run.approvedAt ?? ''), Date.parse(run.startedAt ?? ''));
    stages.push({
      key: 'approval',
      state: waiting ? 'waiting' : turnedDown ? 'stopped' : 'passed',
      ms: span(created, until),
    });
  }
  for (const step of run.steps ?? []) {
    const state = stepStageState(step, open);
    const from = firstOf(Date.parse(step.queuedAt ?? ''), Date.parse(step.startedAt ?? ''));
    const live = step.status === 'running' || step.status === 'queued';
    const to = step.finishedAt ? Date.parse(step.finishedAt) : live ? nowMs : NaN;
    stages.push({
      key: 'step',
      state,
      ms: span(from, to),
      step: {
        id: step.id,
        kind: step.kind,
        status: step.status,
        ...(step.skipped ? { skipped: step.skipped } : {}),
        ...(step.error ? { error: step.error } : {}),
        attempt: step.attempt,
      },
    });
  }
  return stages;
}

function stepStageState(step: StepRun, open: boolean): RunStageState {
  // The gate a person rejected the run at: where it was stopped, as an approval turned down is.
  if (step.gate?.decision === 'reject') return 'stopped';
  switch (step.status) {
    case 'pending':
      return open ? 'pending' : 'skipped';
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'reported':
      return 'reported';
    case 'skipped':
    case 'not-run':
      return 'skipped';
    default:
      // Statuses only grow: one this build does not know is not drawn as an outcome,
      // and once the run is over it never came, like a pending step.
      return open ? 'pending' : 'skipped';
  }
}

/**
 * The step a failed run retries from, as the engine's `retryTargetOf` reads
 * it: the step it failed at (a failed step before the failed row of the loop
 * it is in), else a failed loop's row (out of rounds, or stopped between
 * them), else (it ended between steps, or before the first) the first it did
 * not run. The engine refuses any other id; `retryTarget.parity.test.ts`
 * keeps this copy the engine's (the renderer loads none of its runtime).
 */
export function retryTargetOf(steps: StepRun[]): StepRun | undefined {
  return (
    steps.find((step) => step.status === 'failed' && step.kind !== 'repeat') ??
    steps.find((step) => step.status === 'failed') ??
    steps.find((step) => step.status === 'not-run')
  );
}

/**
 * The step a run's page offers Retry from: a failed run's `retryTargetOf`,
 * only once it started, as the engine's `retry` allows. A run refused at
 * approval or turned away in line never started, so it is run again instead.
 */
export function runRetryTarget(run: RunRecord): StepRun | undefined {
  return run.status === 'failed' && run.startedAt ? retryTargetOf(run.steps ?? []) : undefined;
}

/**
 * Whether a command step was cut off mid-run: it recorded that it was about
 * to run (`intentAt`) and never recorded a result. It may or may not have
 * done its work, which is why retrying it warns first.
 */
export function isInterruptedCommand(step: StepRun): boolean {
  return (
    step.kind === 'run' &&
    step.status === 'failed' &&
    Boolean(step.command?.intentAt) &&
    step.command?.exitCode === undefined &&
    step.command?.signal === undefined
  );
}

/** The error of a command Consola stopped, word for word: the engine's `describeFailure` (`stepWords.parity.test.ts`). */
export const COMMAND_STOPPED = 'Stopped while running: it may have done its work';
/** How the error of a command its timeout ended begins: "timed out after 10m". */
export const COMMAND_TIMED_OUT = /^timed out after /;

/**
 * How a failed command step was ended while it ran, though it has a result:
 * Consola stopped it, its timeout ended it, or a signal killed it. Null for
 * any other step. The sibling of `isInterruptedCommand` (a command with no
 * result at all): either may have done its work, so retrying either warns.
 */
export function endedWhileRunning(step: StepRun): 'stopped' | 'timed-out' | 'killed' | null {
  if (step.kind !== 'run' || step.status !== 'failed') return null;
  if (step.error === COMMAND_STOPPED) return 'stopped';
  if (COMMAND_TIMED_OUT.test(step.error ?? '')) return 'timed-out';
  return step.command?.signal !== undefined ? 'killed' : null;
}

/** The retry warning for a command Consola quit on, word for word. */
const INTERRUPTED_WARNING =
  'Consola quit while this command ran; check the pull request first — it may already be posted.';

/**
 * What Retry warns before it retries a step that may have done its work, or
 * null when it retries at once: a command Consola quit on, word for word; a
 * command ended while it ran, saying how, and what to check first (the run's
 * item, if it has one).
 */
export function retryWarningOf(
  step: StepRun,
  item: { type?: 'pr' | 'issue' } | undefined,
): string | null {
  if (isInterruptedCommand(step)) return INTERRUPTED_WARNING;
  const ended = endedWhileRunning(step);
  if (!ended) return null;
  const how = { stopped: 'It was stopped', 'timed-out': 'It timed out', killed: 'It was killed' }[
    ended
  ];
  const check =
    item?.type === 'pr' ? 'the pull request' : item?.type === 'issue' ? 'the issue' : 'what it did';
  return `${how} while it ran and may have done its work; check ${check} first.`;
}

/** Whether the run page offers Stop: a running run, or a waiting one (at a gate, or out a retry). */
export function stopOffered(run: Pick<RunFacts, 'status'>): boolean {
  return run.status === 'running' || run.status === 'waiting';
}

/**
 * The lead's detail beside its label: `for 2m 5s` while it runs, its place
 * in line, `asked 5m ago` while it waits for approval or at a gate (from
 * when the gate asked), `retries at 10:42` while it waits out a retry (the
 * step's, or the whole run's); otherwise how long it took and when it ended.
 */
export function leadDetail(run: RunFacts, now: Date, place: number | undefined): string {
  if (run.status === 'running') return `for ${formatDuration(run, now) ?? '0s'}`;
  if (run.status === 'queued')
    return place !== undefined ? `${place} in line` : formatAgo(run.createdAt, now);
  if (run.status === 'needs-approval') return `asked ${formatAgo(run.createdAt, now)}`;
  if (run.status === 'waiting') {
    const waiting = run.steps?.find((step) => step.status === 'waiting');
    if (waiting?.gate) return `asked ${formatAgo(waiting.gate.askedAt, now)}`;
    const retryAt = waiting?.retryAt ?? run.retryAt;
    if (retryAt) return `retries at ${clockTime(retryAt)}`;
    return formatAgo(run.updatedAt, now);
  }
  const duration = run.startedAt ? formatDuration(run, now) : null;
  return [
    duration ? `${run.status === 'failed' ? 'after' : 'in'} ${duration}` : null,
    formatAgo(run.finishedAt ?? run.updatedAt, now),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** What a step that ran ended as: completed, failed or reported. */
const RAN: ReadonlySet<string> = new Set(['completed', 'failed', 'reported']);

/**
 * How a run a person rejected at a gate reads: `` rejected at `decide` by
 * you, after 2 steps ``, counting the agent and command steps that ran, in
 * their latest attempt or an earlier one. A rejected run reached nothing
 * past its gate, but a loop's steps come after the loop's own row and ran
 * in its earlier rounds, which a loop rejected at its exhaustion gate, or
 * at a gate inside it, counts (3-A code review S3). Null for any other run.
 */
export function rejectedWords(run: Pick<RunFacts, 'status' | 'steps'>): string | null {
  const gate = rejectedAtGate(run);
  if (gate === undefined) return null;
  const ran = (run.steps ?? []).filter(
    (step) =>
      (step.kind === 'agent' || step.kind === 'run') &&
      (RAN.has(step.status) || (step.previous ?? []).some((line) => RAN.has(line.status))),
  ).length;
  return `rejected at \`${gate}\` by you, after ${ran} ${ran === 1 ? 'step' : 'steps'}`;
}

/** One row of a steps run's trace: a step, or a loop's row with the rows of its steps. */
export type TraceRow =
  | { kind: 'step'; row: StepRun }
  | { kind: 'loop'; row: StepRun; inner: StepRun[]; round?: number; max?: number };

/**
 * The trace's rows, in record order: each top-level row, and a loop's row
 * holding the rows of its steps, which follow it. Which rows are its steps
 * is the run's preview's (`loops`, from `loopsOf`); a run without one (an
 * older record) takes the rows after it that carry a round.
 */
export function traceRows(
  run: Pick<RunFacts, 'steps'>,
  loops: Record<string, string[]>,
): TraceRow[] {
  const steps = run.steps ?? [];
  const rows: TraceRow[] = [];
  for (let at = 0; at < steps.length; at++) {
    const row = steps[at];
    if (row.kind !== 'repeat') {
      rows.push({ kind: 'step', row });
      continue;
    }
    const named = loops[row.id];
    const belongs = (step: StepRun) =>
      step.kind !== 'repeat' && (named ? named.includes(step.id) : step.round !== undefined);
    const inner: StepRun[] = [];
    while (at + 1 < steps.length && belongs(steps[at + 1])) inner.push(steps[++at]);
    rows.push({
      kind: 'loop',
      row,
      inner,
      ...(row.round !== undefined ? { round: row.round } : {}),
      ...(row.max !== undefined ? { max: row.max } : {}),
    });
  }
  return rows;
}

/**
 * Each round's execution of a step inside a loop, oldest first: its earlier
 * attempts (`previous`) and itself, each that ran in a round. An attempt a
 * retry gave in the same round is listed with that round.
 */
export function roundsOf(
  row: StepRun,
): Array<{ round: number; attempt: number; status: StepRunStatus }> {
  const executions = [...(row.previous ?? []), row]
    .filter((execution) => execution.round !== undefined)
    .map((execution) => ({
      round: execution.round as number,
      attempt: execution.attempt,
      status: execution.status,
    }));
  return executions.sort((a, b) => a.attempt - b.attempt);
}

/** By loop, the ids of its steps, from the run's preview: `{ polish: ['review', 'address'] }`. */
export function loopsOf(preview: Pick<StepsRunPreview, 'steps'>): Record<string, string[]> {
  const loops: Record<string, string[]> = {};
  for (const step of preview.steps) {
    if (step.loop === undefined) continue;
    loops[step.loop] = [...(loops[step.loop] ?? []), step.id];
  }
  return loops;
}

/** The stage the run is in now, or ended in, and how. */
function stopPoint(
  run: RunRecord,
  keys: RunStageKey[],
  agent: boolean,
): { key: RunStageKey; state: RunStageState } {
  const last = keys[keys.length - 1];
  const has = (key: RunStageKey) => keys.includes(key);
  switch (run.status) {
    case 'needs-approval':
      return { key: 'approval', state: 'waiting' };
    case 'waiting':
      // Only a steps run parks (at a gate or a retry), and its stages come from its steps;
      // a legacy run never waits, so this is the compiler's case.
      return { key: last, state: 'waiting' };
    case 'queued':
      return { key: has('queue') ? 'queue' : last, state: 'queued' };
    case 'running':
      return run.startedAt || !has('preview')
        ? { key: 'run', state: 'running' }
        : { key: 'preview', state: 'running' };
    case 'completed':
      // A preview with nothing to do finishes there; approval and the run are not needed.
      if (has('approval') && !agent && !run.startedAt) return { key: 'preview', state: 'passed' };
      return { key: last, state: 'passed' };
    case 'failed':
      if (run.startedAt || (!has('approval') && !has('preview') && !has('queue')))
        return { key: last, state: 'failed' };
      if (agent) {
        return run.approvedAt || !has('approval')
          ? { key: 'queue', state: 'failed' }
          : { key: 'approval', state: 'failed' };
      }
      // Asked, then refused when approved (the file changed meanwhile); else its preview failed.
      if (run.approval && has('approval')) return { key: 'approval', state: 'failed' };
      return { key: has('preview') ? 'preview' : last, state: 'failed' };
    case 'rejected':
      if (agent && (run.approvedAt || !has('approval'))) return { key: 'queue', state: 'stopped' };
      return { key: has('approval') ? 'approval' : last, state: 'stopped' };
  }
}

/** Whether a completed run stopped at its preview: there was nothing to approve or run. */
export function foundNothingToDo(run: RunRecord): boolean {
  return (
    run.status === 'completed' &&
    run.mode === 'confirm' &&
    !isAgentRunPreview(run.result) &&
    !run.startedAt
  );
}

function firstOf(...values: number[]): number {
  return values.find((value) => Number.isFinite(value)) ?? NaN;
}

function span(from: number, to: number): number | null {
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
}

/** How long a run worked: from its start to its end, or to now while it works. Null before it started. */
export function workedMs(run: RunFacts, now: Date): number | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt
    ? Date.parse(run.finishedAt)
    : run.status === 'running'
      ? now.getTime()
      : NaN;
  return span(Date.parse(run.startedAt), end);
}

/**
 * Something worth knowing about this run against the automation's others,
 * said only when true: a recovery, a streak of failures, a first failure
 * after a good run of passes, a personal best.
 */
export interface RunNote {
  tone: 'good' | 'bad' | 'neutral';
  text: string;
}

/** Below this many runs to compare with, "fastest" says nothing. */
const FASTEST_AFTER = 5;

/**
 * Notes for one run. `history` is the automation's runs, newest first, the
 * run itself among them; only those that worked to an end count.
 */
export function runNotes(run: RunFacts, history: RunFacts[]): RunNote[] {
  if (run.status !== 'completed' && run.status !== 'failed') return [];
  const ended = history.filter(
    (candidate) => candidate.status === 'completed' || candidate.status === 'failed',
  );
  const index = ended.findIndex((candidate) => candidate.id === run.id);
  if (index === -1) return [];
  const before = ended.slice(index + 1);
  const leading = (status: RunFacts['status']) => {
    const broken = before.findIndex((candidate) => candidate.status !== status);
    return broken === -1 ? before.length : broken;
  };
  const notes: RunNote[] = [];

  if (run.status === 'completed') {
    const failures = leading('failed');
    if (failures > 0) {
      notes.push({
        tone: 'good',
        text:
          failures === 1
            ? 'Passing again after a failure'
            : `Passing again after ${failures} failures`,
      });
    }
    // Ended runs only, so "now" never counts.
    const took = (candidate: RunFacts) => workedMs(candidate, new Date(0));
    const timed = ended.filter(
      (candidate) => candidate.status === 'completed' && took(candidate) !== null,
    );
    const mine = took(run);
    if (mine !== null && timed.length >= FASTEST_AFTER) {
      const fastest = timed.every(
        (candidate) => candidate.id === run.id || mine < (took(candidate) ?? Infinity),
      );
      if (fastest) notes.push({ tone: 'good', text: `Fastest of ${timed.length} runs` });
    }
  } else {
    const failures = leading('failed') + 1;
    if (failures >= 2) {
      notes.push({ tone: 'bad', text: `${failures} failures in a row` });
    } else {
      const passes = leading('completed');
      if (passes >= 3)
        notes.push({ tone: 'neutral', text: `First failure after ${passes} passing runs` });
    }
  }
  return notes;
}

/** Below this many other runs, there is no "usual" to compare with. */
const USUAL_AFTER = 3;

/**
 * This run's duration against the middle of the automation's others that
 * worked to an end: "2.4× its usual 1m 20s", "faster than its usual 1m 20s",
 * or just "usual 1m 20s". A running run compares as it goes.
 */
export function durationAgainstUsual(
  run: RunFacts,
  history: RunFacts[],
  now: Date,
): { text: string; tone: 'slow' | 'fast' | 'usual' } | null {
  const mine = workedMs(run, now);
  if (mine === null) return null;
  const others = history
    .filter(
      (candidate) =>
        candidate.id !== run.id &&
        (candidate.status === 'completed' || candidate.status === 'failed'),
    )
    .map((candidate) => workedMs(candidate, now))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  if (others.length < USUAL_AFTER) return null;
  const middle = Math.floor(others.length / 2);
  const median =
    others.length % 2 === 1 ? others[middle] : (others[middle - 1] + others[middle]) / 2;
  const usual = formatElapsed(median);
  // Under two seconds either way is the same run to a person.
  if (Math.abs(mine - median) < 2000 || median === 0)
    return { text: `usual ${usual}`, tone: 'usual' };
  const ratio = mine / median;
  if (ratio >= 1.5)
    return {
      text: `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× its usual ${usual}`,
      tone: 'slow',
    };
  if (ratio <= 0.67) return { text: `faster than its usual ${usual}`, tone: 'fast' };
  return { text: `usual ${usual}`, tone: 'usual' };
}

/** The runs either side of this one in its automation's history (newest first), to step through them. */
export function adjacentRuns(
  runId: string,
  history: RunFacts[],
): { newer: string | null; older: string | null } {
  const index = history.findIndex((candidate) => candidate.id === runId);
  if (index === -1) return { newer: null, older: null };
  return { newer: history[index - 1]?.id ?? null, older: history[index + 1]?.id ?? null };
}

/** The tools a run's steps called, most-called first, as "Read 12 · Bash 6". */
export function toolCounts(entries: ConversationEntry[]): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries)
    if (entry.kind === 'step') counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
  return [...counts]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

/**
 * How one step went, as a CI job's step list marks it: its result came back
 * (`passed`) or came back an error (`failed`); with no result, the last step
 * is still `running` in a running run and was `cut` off in a failed one.
 * Any other step without a result is `unknown`.
 */
export type StepState = 'passed' | 'failed' | 'running' | 'cut' | 'unknown';

export function stepState(
  entry: Extract<ConversationEntry, { kind: 'step' }>,
  isLastStep: boolean,
  runStatus: RunFacts['status'],
): StepState {
  if (entry.failed) return 'failed';
  if (entry.endedAt) return 'passed';
  if (isLastStep && runStatus === 'running') return 'running';
  if (isLastStep && runStatus === 'failed') return 'cut';
  return 'unknown';
}

/** The run's working time a step list draws its bars against, in epoch ms. */
export interface Timeline {
  start: number;
  end: number;
}

/**
 * From the run's start to its end — or to now while it runs — falling back
 * on the transcript's first and last timestamps. Null when there is nothing
 * to measure against.
 */
export function stepTimeline(
  run: RunFacts,
  entries: ConversationEntry[],
  now: Date,
): Timeline | null {
  const stamps = entries.flatMap((entry) => {
    const times = [entry.at, entry.kind === 'step' ? entry.endedAt : undefined];
    return times.flatMap((iso) =>
      iso && Number.isFinite(Date.parse(iso)) ? [Date.parse(iso)] : [],
    );
  });
  const start = firstOf(
    Date.parse(run.startedAt ?? ''),
    stamps.length > 0 ? Math.min(...stamps) : NaN,
  );
  const end = firstOf(
    Date.parse(run.finishedAt ?? ''),
    run.status === 'running' ? now.getTime() : NaN,
    stamps.length > 0 ? Math.max(...stamps) : NaN,
  );
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * Where a step sits on the timeline, as fractions of it, and how long it
 * took. A running step reaches to now; a step without an end shows as a
 * tick where it began.
 */
export function stepBar(
  entry: Extract<ConversationEntry, { kind: 'step' }>,
  state: StepState,
  timeline: Timeline,
  now: Date,
): { left: number; width: number; ms: number | null } | null {
  const at = Date.parse(entry.at ?? '');
  if (!Number.isFinite(at)) return null;
  const ended = entry.endedAt
    ? Date.parse(entry.endedAt)
    : state === 'running'
      ? now.getTime()
      : NaN;
  const ms = span(at, ended);
  const length = timeline.end - timeline.start;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const left = clamp((at - timeline.start) / length);
  const width = ms === null ? 0 : Math.min(1 - left, ms / length);
  return { left, width, ms };
}

/** The words of a run's trigger stage: what fired it, in a kicker, a title and when. */
export function triggerStageWords(
  run: RunRecord,
  askerName: string | undefined,
  schedule: string | undefined,
): { kicker: string; title: string; outcome: string } {
  const { trigger } = run;
  const time = new Date(trigger.at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (trigger.kind === 'cron') {
    const late = Date.parse(run.createdAt) - Date.parse(trigger.at);
    return {
      kicker: trigger.catchUp ? 'Schedule, caught up' : 'Schedule',
      title: schedule ?? 'On schedule',
      outcome:
        trigger.catchUp && late >= 1000
          ? `Due ${time} · ran ${formatElapsed(late)} late`
          : `Fired ${time}`,
    };
  }
  if (trigger.kind === 'event') {
    const label = isAgentRunPreview(run.result) ? run.result.item?.label : undefined;
    return { kicker: 'Inbox event', title: label ?? 'An item arrived', outcome: `Seen ${time}` };
  }
  if (trigger.kind === 'poll')
    return { kicker: 'Check', title: 'Found by its check', outcome: `Checked ${time}` };
  if (trigger.by === 'agent') {
    return {
      kicker: 'Agent request',
      title: askerName ? `Asked by ${askerName}` : 'Asked by an agent',
      outcome: `Asked ${time}`,
    };
  }
  return { kicker: 'Run now', title: 'Run by you', outcome: `Started ${time}` };
}
