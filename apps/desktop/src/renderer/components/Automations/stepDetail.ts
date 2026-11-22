import type {
  CommandFile,
  LogTail,
  RunRecord,
  StepRun,
  StepRunStatus,
} from '../../../shared/automations';
import { formatCostUsd } from '../../../shared/cost';
import { formatElapsed } from './presentation';

/**
 * A value past this many characters, or spanning lines, folds behind a
 * disclosure. Shorter ones read inline and wrap: a path is worth seeing.
 */
const LONG_VALUE = 300;

/** What one `env:` entry of a command shows: its name, the template as written, and the value it rendered. */
export interface VariableRow {
  name: string;
  template: string;
  value: string;
  /** Past 300 characters or spanning lines: folded rather than read inline. */
  long: boolean;
  /** The file wrote a template (`{{…}}`), so the value came from somewhere worth naming. */
  templated: boolean;
}

export function variableRows(command: CommandFile): VariableRow[] {
  return command.env.map(({ name, template, value }) => ({
    name,
    template,
    value,
    long: value.length > LONG_VALUE || value.includes('\n'),
    templated: template !== value,
  }));
}

/** An earlier attempt's status in the words a person uses: one that did not run did not fail. */
function earlierWords(status: StepRunStatus): string {
  return status === 'not-run' ? 'did not run' : status;
}

/**
 * Which attempt this is and how the earlier ones ended, in attempt order
 * (`Attempt 3 · earlier: 1 failed, 2 did not run`: attempt numbers, one by one), then `reminded once` when
 * the agent had to be reminded. Null for a first, unreminded attempt.
 */
export function attemptsLine(record: StepRun): string | null {
  const parts: string[] = [];
  const previous = record.previous ?? [];
  if (record.attempt > 1 || previous.length > 0) {
    let line = `Attempt ${record.attempt}`;
    if (previous.length > 0) {
      const listed = [...previous]
        .sort((a, b) => a.attempt - b.attempt)
        .map((earlier) => `${earlier.attempt} ${earlierWords(earlier.status)}`);
      line += ` · earlier: ${listed.join(', ')}`;
    }
    parts.push(line);
  }
  if (record.reminded) parts.push('reminded once');
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function turnsWords(turns: number): string {
  return `${turns} ${turns === 1 ? 'turn' : 'turns'}`;
}

/**
 * The step row's facts after its duration, as the CLI reported the latest
 * attempt's turns: `7 turns · $0.0412 est.`. Null for a command, and for a
 * turn that reported neither: a cost the CLI never gave is never shown as $0.
 */
export function turnFacts(step: StepRun): string | null {
  if (step.kind !== 'agent' || !step.turn) return null;
  const { turns, costUsd } = step.turn;
  const parts: string[] = [];
  if (turns !== undefined) parts.push(turnsWords(turns));
  if (costUsd !== undefined) parts.push(formatCostUsd(costUsd));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The step detail's turn line: the turns against the step's own cap, the
 * cost and the model the CLI reported, `7 turns of at most 30 · $0.0412
 * est. · claude-opus-5-5`, each part only when it is known. Null for a
 * command, and for an agent step that reported none of them.
 */
export function turnLine(step: StepRun): string | null {
  if (step.kind !== 'agent') return null;
  const { turns, costUsd, maxTurns } = step.turn ?? {};
  const parts: string[] = [];
  if (turns !== undefined)
    parts.push(
      maxTurns !== undefined ? `${turnsWords(turns)} of at most ${maxTurns}` : turnsWords(turns),
    );
  else if (maxTurns !== undefined) parts.push(`At most ${turnsWords(maxTurns)}`);
  if (costUsd !== undefined) parts.push(formatCostUsd(costUsd));
  if (step.model !== undefined) parts.push(step.model);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * What each earlier attempt cost, in attempt order: `Earlier attempts: 1
 * $0.0100 est., 2 no cost reported`. Null when none reported a cost.
 */
export function earlierCosts(step: StepRun): string | null {
  const previous = [...(step.previous ?? [])].sort((a, b) => a.attempt - b.attempt);
  if (!previous.some((earlier) => earlier.costUsd !== undefined)) return null;
  const listed = previous.map(
    (earlier) =>
      `${earlier.attempt} ${earlier.costUsd !== undefined ? formatCostUsd(earlier.costUsd) : 'no cost reported'}`,
  );
  return `Earlier attempts: ${listed.join(', ')}`;
}

/** The tools the latest attempt's turns were refused: `Denied: mcp__grafana__delete_dashboard, Read`. Null when none was. */
export function deniedLine(step: StepRun): string | null {
  const denied = step.turn?.deniedTools ?? [];
  return denied.length > 0 ? `Denied: ${denied.join(', ')}` : null;
}

/** How long the step ran, in ms: to now while it runs. Null before it starts, or with no end. */
export function durationOf(record: StepRun, now: Date): number | null {
  if (!record.startedAt) return null;
  const start = Date.parse(record.startedAt);
  const end = record.finishedAt
    ? Date.parse(record.finishedAt)
    : record.status === 'running'
      ? now.getTime()
      : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** A command's log file holds at most this much; mirrors the engine's `LOG_CAP_BYTES` (`steps/commandIO.ts`), which the renderer may not import. */
export const LOG_CAP_BYTES = 1024 * 1024;

/** Whether a stream produced more than its file holds. Decided per stream, from its own byte count. */
export function logWasCapped(wrote: number | undefined): boolean {
  return wrote !== undefined && wrote > LOG_CAP_BYTES;
}

/**
 * The tail to show: what Show all read, for as long as the file is the size it
 * was read at; else the latest tail. A refetch hands back a fresh object, so
 * identity is no signal; the size is.
 */
export function visibleTail(
  initial: LogTail | undefined,
  full: LogTail | undefined,
): LogTail | undefined {
  return full && (!initial || initial.bytes === full.bytes) ? full : initial;
}

/**
 * How a step went, as its row in the run's trace marks it. A step still
 * `pending` once the run is over never came, so it reads as not run; a
 * status this build does not know reads the same way, never as an outcome.
 */
export type StepTone =
  | 'passed'
  | 'failed'
  | 'running'
  | 'waiting'
  | 'pending'
  | 'skipped'
  | 'not-run'
  | 'reported';

/** A run in one of these is over. */
export function runIsOver(status: RunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'rejected';
}

export function stepTone(status: StepRunStatus, runOver: boolean): StepTone {
  switch (status) {
    case 'completed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'queued':
      return 'waiting';
    case 'skipped':
      return 'skipped';
    case 'reported':
      return 'reported';
    case 'not-run':
      return 'not-run';
    default:
      return runOver ? 'not-run' : 'pending';
  }
}

/**
 * The step's outcome in a few words, with how long it took where it ran:
 * what its row says, and its accessible name after the step's id.
 */
export function stepOutcome(tone: StepTone, ms: number | null): string {
  const took = ms !== null ? formatElapsed(ms) : null;
  switch (tone) {
    case 'passed':
      return took ? `Completed in ${took}` : 'Completed';
    case 'failed':
      return took ? `Failed after ${took}` : 'Failed';
    case 'running':
      return took ? `Running · ${took}` : 'Running';
    case 'waiting':
      return 'Waiting for a slot';
    case 'pending':
      return 'Not started';
    case 'skipped':
      return 'Skipped';
    case 'not-run':
      return 'Did not run';
    case 'reported':
      return 'Would have run';
  }
}

/** A skip reason as the engine words a false `if:` (`if: <condition> is false`), parsed back to the condition. */
const IF_FALSE = /^if: ([\s\S]+) is false$/;

/** The `if:` a step was skipped on, when that is why it was skipped; null for any other reason. */
export function skippedCondition(reason: string | undefined): string | null {
  const match = reason ? IF_FALSE.exec(reason) : null;
  return match ? match[1] : null;
}

/** `steps.<id>.<output>` in an expression: the values a condition read. */
const OUTPUT_REF = /\bsteps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\b/g;

/**
 * The outputs a condition read, each with the value the run recorded for it
 * (undefined when that step set none), in the order they appear, once each.
 */
export function conditionValues(
  condition: string,
  steps: StepRun[],
): Array<{ ref: string; step: string; value: string | number | boolean | undefined }> {
  const seen = new Set<string>();
  const values: Array<{ ref: string; step: string; value: string | number | boolean | undefined }> =
    [];
  for (const match of condition.matchAll(OUTPUT_REF)) {
    const [ref, stepId, name] = match;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const outputs = steps.find((candidate) => candidate.id === stepId)?.outputs;
    values.push({
      ref,
      step: stepId,
      value:
        outputs && Object.prototype.hasOwnProperty.call(outputs, name) ? outputs[name] : undefined,
    });
  }
  return values;
}

/** Why a step the run never reached did not run, from how the run ended. */
export function notRunReason(run: Pick<RunRecord, 'status' | 'steps'>): string {
  if (run.status === 'rejected') return 'The run was turned down before it started.';
  const failed = run.steps?.find((candidate) => candidate.status === 'failed');
  if (failed) return `The run stopped at ${failed.id} before reaching it.`;
  if (run.status === 'failed') return 'The run failed before reaching it.';
  return 'The run ended before reaching it.';
}

/** A value as a row shows it: on one line, cut short past `max` characters. */
function shortValue(value: string | number | boolean, max = 40): string {
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What an artifact is for, where its name says: the two every step may write. */
export function artifactNote(name: string, kind: StepRun['kind']): string | null {
  if (name === 'handover') return 'what it handed to the steps after it';
  if (name === 'output' && kind === 'run') return 'its stdout, kept for the steps after it';
  return null;
}

/**
 * What a step did, in one line under its name: the outputs it set and what
 * it wrote, or what it printed; the error, word for word, when it failed;
 * why it did not run. Null where the row's outcome already says it all.
 */
export function stepSummary(
  step: StepRun,
  run: Pick<RunRecord, 'status' | 'steps'>,
): string | null {
  const tone = stepTone(step.status, runIsOver(run.status));
  switch (tone) {
    case 'failed':
      return step.error ?? 'It failed without saying why.';
    case 'skipped': {
      const condition = skippedCondition(step.skipped);
      return condition ? `if: ${condition} was false` : (step.skipped ?? null);
    }
    case 'not-run':
      return notRunReason(run);
    case 'reported':
      return 'A dry run: it was not run';
    case 'running':
      return step.kind === 'agent' ? 'Working in a read-only session' : null;
    case 'waiting':
    case 'pending':
      return null;
    case 'passed': {
      const parts: string[] = [];
      const outputs = Object.entries(step.outputs ?? {});
      if (outputs.length > 0)
        parts.push(
          `set ${outputs.map(([name, value]) => `${name} = ${shortValue(value)}`).join(', ')}`,
        );
      for (const artifact of step.artifacts ?? []) {
        const size = formatBytes(artifact.bytes);
        if (artifact.name === 'handover') parts.push(`wrote its handover (${size})`);
        else if (artifact.name === 'output' && step.kind === 'run')
          parts.push(`kept its stdout as output (${size})`);
        else parts.push(`wrote ${artifact.name} (${size})`);
      }
      if (parts.length === 0 && step.kind === 'run') {
        const out = step.command?.stdoutBytes ?? 0;
        const err = step.command?.stderrBytes ?? 0;
        if (out > 0) parts.push(`printed ${formatBytes(out)}`);
        if (err > 0) parts.push(`${formatBytes(err)} on stderr`);
        if (out === 0 && err === 0 && step.command) parts.push('printed nothing');
      }
      if (parts.length === 0) return null;
      const line = parts.join(' · ');
      return line.charAt(0).toUpperCase() + line.slice(1);
    }
  }
}

/** `exit 3`, `killed by SIGTERM`, either with the last stderr line after `: `: how the engine words a command's failure. */
const COMMAND_ENDED = /^(?:exit (\d+)|killed by (\S+))(?:: ([\s\S]+))?$/;

/**
 * A step's failure in plain words, for the run's own note: what happened,
 * and the line it last wrote to stderr when the error carries one.
 */
export function failureWords(error: string | undefined): { text: string; quote: string | null } {
  if (!error) return { text: 'It failed without saying why.', quote: null };
  const ended = COMMAND_ENDED.exec(error);
  if (ended) {
    const [, code, signal, line] = ended;
    const how =
      code !== undefined
        ? `Its command exited with code ${code}`
        : `Its command was killed by ${signal}`;
    return line
      ? { text: `${how}. The last line it wrote to stderr:`, quote: line }
      : { text: `${how}.`, quote: null };
  }
  const timedOut = /^timed out after (.+)$/.exec(error);
  if (timedOut)
    return {
      text: `Its command ran past its ${timedOut[1]} timeout and was stopped.`,
      quote: null,
    };
  const sentence = error.charAt(0).toUpperCase() + error.slice(1);
  return { text: /[.!?]$/.test(sentence) ? sentence : `${sentence}.`, quote: null };
}

/**
 * What Retry from a step touches, against what Run again does: retry runs
 * that step again and the ones after it that never ran, as this run defined
 * them, while the steps before it keep what they did; Run again starts over
 * from the first step, with the file as it is now. Null for a step not in
 * the run.
 */
export function retryScope(
  steps: StepRun[],
  targetId: string,
): { later: string[]; earlier: string[] } | null {
  const at = steps.findIndex((step) => step.id === targetId);
  if (at === -1) return null;
  return {
    later: steps
      .slice(at + 1)
      .filter((step) => step.status === 'not-run' || step.status === 'pending')
      .map((step) => step.id),
    earlier: steps
      .slice(0, at)
      .filter((step) => step.status === 'completed')
      .map((step) => step.id),
  };
}

/**
 * Whether a failure says no more than a command's own trace does — its exit
 * code, and the stderr line it ends with — so the open trace need not
 * repeat it.
 */
export function failureIsExit(error: string | undefined): boolean {
  return error !== undefined && COMMAND_ENDED.test(error);
}

/** How the run's steps went, counted for the trace's heading: `6 steps · 5 completed · 1 skipped`. */
export function stepCounts(steps: StepRun[], runOver: boolean): string {
  const counts = new Map<StepTone, number>();
  for (const step of steps) {
    const tone = stepTone(step.status, runOver);
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  const words: Array<[StepTone, string]> = [
    ['passed', 'completed'],
    ['failed', 'failed'],
    ['running', 'running'],
    ['waiting', 'waiting'],
    ['reported', 'would have run'],
    ['skipped', 'skipped'],
    ['not-run', 'did not run'],
    ['pending', 'to come'],
  ];
  const parts = [`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`];
  for (const [tone, word] of words) {
    const count = counts.get(tone);
    if (count) parts.push(`${count} ${word}`);
  }
  return parts.join(' · ');
}
