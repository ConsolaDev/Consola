import { type Phase, type RunStatus, type StepSummary, stepHasEnded } from './runs';
import { costInWords, durationInWords, workedFor } from './runWords';

/**
 * A step of an automation run, as its trace says it: the desktop's (`Automations/stepDetail.ts`),
 * for what the cell holds of a step. Every sentence a step's row and its open trace say is
 * here; the page only lays them out.
 */

/**
 * How a step went, as its row marks it. A step still `pending` once the run is over never came,
 * so it reads as not run; a status this build does not know reads the same way, never as an
 * outcome.
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

/** Whether a run is over: nothing in it works or waits any more. */
export function runIsOver(phase: Phase): boolean {
  return phase !== 'active' && phase !== 'needs-you';
}

export function stepTone(status: StepSummary['status'], runOver: boolean): StepTone {
  switch (status) {
    case 'completed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'queued':
    case 'waiting':
      return runOver ? 'not-run' : 'waiting';
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

/** A step opens by itself where the run broke or stands now, and stays open once it has. */
export function opensItself(step: Pick<StepSummary, 'status'>): boolean {
  return (
    step.status === 'failed' ||
    step.status === 'running' ||
    step.status === 'queued' ||
    step.status === 'waiting'
  );
}

/**
 * How long a step worked: to now while it works. Null before it starts, and for a step that ended
 * with no finish time, which has no clock to run on.
 */
export function stepWorkedFor(
  step: Pick<StepSummary, 'status' | 'startedAt' | 'finishedAt'>,
  now: number,
): number | null {
  if (stepHasEnded(step) && step.finishedAt === null) return null;
  return workedFor(step, now);
}

/** The step's outcome in a few words, with how long it took where it ran: its row's spoken name. */
export function stepOutcome(
  step: Pick<StepSummary, 'status'>,
  tone: StepTone,
  ms: number | null,
): string {
  const took = ms !== null ? durationInWords(ms) : null;
  switch (tone) {
    case 'passed':
      return took ? `Completed in ${took}` : 'Completed';
    case 'failed':
      return took ? `Failed after ${took}` : 'Failed';
    case 'running':
      return took ? `Running, ${took}` : 'Running';
    case 'waiting':
      return step.status === 'queued' ? 'Queued' : 'Waiting';
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

function turnsWords(turns: number): string {
  return `${turns} ${turns === 1 ? 'turn' : 'turns'}`;
}

/**
 * The facts at the end of a step's row, after its duration: an agent's turns and cost as the CLI
 * reported them (`3 turns · $0.12`), a command's exit (`exit 0`, `killed by SIGTERM`). Null when
 * nothing was reported: a cost never given is never shown as $0.
 */
export function rowFacts(step: StepSummary, now: number): string | null {
  const ms = stepWorkedFor(step, now);
  const parts: string[] = [];
  if (ms !== null) parts.push(durationInWords(ms));
  if (step.kind === 'agent') {
    if (step.turn?.turns != null) parts.push(turnsWords(step.turn.turns));
    const cost = costInWords(step.costUsd);
    if (cost) parts.push(cost);
  } else if (step.command) {
    if (step.command.signal) parts.push(`killed by ${step.command.signal}`);
    else if (step.command.exitCode !== null) parts.push(`exit ${step.command.exitCode}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** An earlier attempt's status in the words a person uses: one that did not run did not fail. */
function earlierWords(status: StepSummary['status']): string {
  return status === 'not-run' ? 'did not run' : status.replace(/-/g, ' ');
}

/**
 * Which attempt this is and how the earlier ones ended, in attempt order (`Attempt 3 · earlier:
 * 1 failed, 2 did not run`), then `reminded once` when the agent had to be reminded. Null for a
 * first, unreminded attempt.
 */
export function attemptsLine(
  step: Pick<StepSummary, 'attempt' | 'previous' | 'reminded'>,
): string | null {
  const parts: string[] = [];
  if (step.attempt > 1 || step.previous.length > 0) {
    let line = `Attempt ${step.attempt}`;
    if (step.previous.length > 0) {
      const listed = [...step.previous]
        .sort((a, b) => a.attempt - b.attempt)
        .map((earlier) => `${earlier.attempt} ${earlierWords(earlier.status)}`);
      line += ` · earlier: ${listed.join(', ')}`;
    }
    parts.push(line);
  }
  if (step.reminded) parts.push('reminded once');
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * An agent step's turns against its cap and its cost, as the CLI reported them:
 * `3 turns of at most 30 · $0.12`, each part only when known. After a reminder the turns are both
 * turns' and the cap held only the first, so the cap is left out (the attempts line says so).
 * Null for a command, and for an agent that reported neither.
 */
export function turnLine(step: StepSummary): string | null {
  if (step.kind !== 'agent') return null;
  const turns = step.turn?.turns ?? null;
  const maxTurns = step.reminded ? null : (step.turn?.maxTurns ?? null);
  const parts: string[] = [];
  if (turns !== null) {
    parts.push(
      maxTurns !== null ? `${turnsWords(turns)} of at most ${maxTurns}` : turnsWords(turns),
    );
  } else if (maxTurns !== null) {
    parts.push(`At most ${turnsWords(maxTurns)}`);
  }
  const cost = costInWords(step.costUsd);
  if (cost) parts.push(cost);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * What each earlier attempt cost and took, in attempt order: `Earlier attempts: 1 $0.01 in
 * 6 turns, 2 no cost reported`. Null when none reported a cost or turns.
 */
export function earlierCosts(step: Pick<StepSummary, 'previous'>): string | null {
  const previous = [...step.previous].sort((a, b) => a.attempt - b.attempt);
  if (!previous.some((earlier) => earlier.costUsd !== null || earlier.turns !== null)) return null;
  const listed = previous.map((earlier) => {
    const cost = costInWords(earlier.costUsd) ?? 'no cost reported';
    const turns = earlier.turns !== null ? ` in ${turnsWords(earlier.turns)}` : '';
    return `${earlier.attempt} ${cost}${turns}`;
  });
  return `Earlier attempts: ${listed.join(', ')}`;
}

/** How a command ended: `Exit code 0`, `Stopped by SIGTERM`, `Still running…`; null before. */
export function commandResult(step: Pick<StepSummary, 'status' | 'command'>): string | null {
  if (step.command?.signal) return `Stopped by ${step.command.signal}`;
  if (step.command && step.command.exitCode !== null) return `Exit code ${step.command.exitCode}`;
  if (step.status === 'running') return 'Still running…';
  return null;
}

/** Whether a command's result is a failure: a signal, or an exit code other than 0. */
export function commandFailed(command: StepSummary['command']): boolean {
  return Boolean(command && (command.signal || (command.exitCode ?? 0) !== 0));
}

/** A size in bytes as a person reads it: `512 B`, `4.2 KB`, `1.3 MB` (the desktop's). */
export function bytesInWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a command printed, by size: `4.2 KB on stdout, 120 B on stderr`, `nothing`; null when unknown. */
export function printedWords(command: StepSummary['command']): string | null {
  if (!command || (command.stdoutBytes === null && command.stderrBytes === null)) return null;
  const out = command.stdoutBytes ?? 0;
  const err = command.stderrBytes ?? 0;
  const parts: string[] = [];
  if (out > 0) parts.push(`${bytesInWords(out)} on stdout`);
  if (err > 0) parts.push(`${bytesInWords(err)} on stderr`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** A skip reason as the engine words a false `if:` (`if: <condition> is false`). */
const IF_FALSE = /^if: ([\s\S]+) is false$/;

/** The `if:` a step was skipped on, when that is why it was skipped; null for any other reason. */
export function skippedCondition(reason: string | null): string | null {
  const match = reason ? IF_FALSE.exec(reason) : null;
  return match ? match[1] : null;
}

/** Why a step the run never reached did not run, from how the run ended. */
export function notRunReason(
  status: RunStatus,
  steps: readonly Pick<StepSummary, 'id' | 'status'>[],
): string {
  if (status === 'rejected') return 'The run was turned down before it started.';
  const failed = steps.find((candidate) => candidate.status === 'failed');
  if (failed) return `The run stopped at ${failed.id} before reaching it.`;
  if (status === 'cancelled') return 'The run was cancelled before reaching it.';
  if (status === 'failed' || status === 'expired') return 'The run failed before reaching it.';
  return 'The run ended before reaching it.';
}

/** A value as a row shows it: on one line, cut short past `max` characters. */
function shortValue(value: string | number | boolean, max = 40): string {
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What an artifact is for, where its name says: the two every step may write. */
export function artifactNote(name: string, kind: StepSummary['kind']): string | null {
  if (name === 'handover') return 'what it handed to the steps after it';
  if (name === 'output' && kind === 'run') return 'its stdout, kept for the steps after it';
  return null;
}

/**
 * The last line a step printed that says something, cleaned of the terminal's codes and cut to
 * a row's length: what a running command shows under its name, as a CI log's live line does.
 */
export function lastLine(text: string, max = 160): string | null {
  const lines = cleanOutput(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.at(-1);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What a step did, in one line under its name: the outputs it set and what it wrote, or what it
 * printed; the error, word for word, when it failed; why it did not run; what a running command
 * printed last. Null where the row's outcome already says it all.
 */
export function stepSummary(
  step: StepSummary,
  run: { status: RunStatus; phase: Phase; steps: readonly Pick<StepSummary, 'id' | 'status'>[] },
): string | null {
  const tone = stepTone(step.status, runIsOver(run.phase));
  switch (tone) {
    case 'failed':
      return step.error ?? 'It failed without saying why.';
    case 'skipped': {
      const condition = skippedCondition(step.skipped);
      return condition ? `if: ${condition} was false` : (step.skipped ?? null);
    }
    case 'not-run':
      return notRunReason(run.status, run.steps);
    case 'reported':
      return 'A dry run: it was not run';
    case 'running': {
      if (step.kind === 'run') {
        return lastLine(step.output?.stdout ?? '') ?? lastLine(step.output?.stderr ?? '');
      }
      const turns = step.turn?.turns ?? null;
      return turns !== null ? `Working, ${turnsWords(turns)} so far` : 'Working';
    }
    case 'waiting':
    case 'pending':
      return null;
    case 'passed': {
      const parts: string[] = [];
      const outputs = Object.entries(step.outputs ?? {});
      if (outputs.length > 0) {
        parts.push(
          `set ${outputs.map(([name, value]) => `${name} = ${shortValue(value)}`).join(', ')}`,
        );
      }
      for (const artifact of step.artifacts) {
        const size = bytesInWords(artifact.bytes);
        if (artifact.name === 'handover') parts.push(`wrote its handover (${size})`);
        else if (artifact.name === 'output' && step.kind === 'run') {
          parts.push(`kept its stdout as output (${size})`);
        } else parts.push(`wrote ${artifact.name} (${size})`);
      }
      if (parts.length === 0 && step.kind === 'run') {
        const printed = printedWords(step.command);
        if (printed) parts.push(`printed ${printed}`);
      }
      if (parts.length === 0) return null;
      const line = parts.join(' · ');
      return line.charAt(0).toUpperCase() + line.slice(1);
    }
  }
}

/** `exit 3`, `killed by SIGTERM`, either with the last stderr line after `: `: a command's failure. */
const COMMAND_ENDED = /^(?:exit (\d+)|killed by (\S+))(?::\s*([\s\S]+))?$/;

/**
 * A step's failure in plain words, for the run's note: what happened, and the line it last wrote
 * to stderr when the error carries one.
 */
export function failureWords(error: string | null): { text: string; quote: string | null } {
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
  if (timedOut) {
    return {
      text: `Its command ran past its ${timedOut[1]} timeout and was stopped.`,
      quote: null,
    };
  }
  const sentence = error.charAt(0).toUpperCase() + error.slice(1);
  return { text: /[.!?]$/.test(sentence) ? sentence : `${sentence}.`, quote: null };
}

/** Whether a failure says no more than a command's own result and output do, so the trace need not repeat it. */
export function failureIsExit(error: string | null): boolean {
  return error !== null && COMMAND_ENDED.test(error);
}

/** How the run's steps went, counted for the trace's heading: `6 steps · 5 completed · 1 skipped`. */
export function stepCounts(
  steps: readonly Pick<StepSummary, 'status'>[],
  runOver: boolean,
): string {
  const counts = new Map<StepTone, number>();
  for (const step of steps) {
    const tone = stepTone(step.status, runOver);
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  const words: [StepTone, string][] = [
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

const BASE_TYPES: Record<string, string> = {
  string: 'text',
  text: 'text',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  bool: 'true or false',
};

/**
 * A declared output's type as a sentence says it: `text`, `a number`, `true or false`,
 * `one of approve, request-changes`. A type this build does not know is said as the cell gave it.
 */
export function outputTypeWords(type: string): string {
  const trimmed = type.trim();
  const oneOf = /^one of:?\s*(.+)$/i.exec(trimmed);
  if (oneOf) return `one of ${oneOf[1]}`;
  return BASE_TYPES[trimmed.toLowerCase()] ?? trimmed;
}

/** An output's value as the trace shows it: text as written, a number or a truth as such. */
export function outputValueWords(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

/** A limit of time as a step's definition sets it: `45s`, `10m`, `1h 30m`. */
export function limitWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** The file an agent is defined in: `agents/<name>.md`, unless the cell already gave a path. */
export function agentFile(agent: string): string {
  return agent.includes('/') || agent.endsWith('.md') ? agent : `agents/${agent}.md`;
}

/*
 * Output a command printed is someone else's text, written for a terminal: colours, cursor moves,
 * window titles, links, a progress bar redrawn with carriage returns. `cleanOutput` keeps what it
 * says and drops how a terminal would have drawn it, so nothing in it can move, recolour or
 * hide text on the page: every escape sequence (CSI, OSC, DCS and the rest, 7-bit and 8-bit), every
 * control character but a newline and a tab, and the characters that reorder text (bidirectional
 * overrides and isolates). A carriage return starts its line again, as a terminal's redraw does,
 * and a backspace takes back the character before it.
 */

/** OSC, DCS, SOS, PM and APC: a string, ended by BEL or ST, or by the end of the text. */
const ESC_STRING =
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
/** CSI: parameters, intermediates and a final byte. */
const ESC_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g;
/** Any other escape: intermediates, then one final character. */
const ESC_OTHER = /\u001b[ -/]*[0-~]?/g;
/** Characters that reorder text on screen: embeddings, overrides, isolates and marks. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

export function cleanOutput(text: string): string {
  const unescaped = text
    .replace(ESC_STRING, '')
    .replace(ESC_CSI, '')
    .replace(ESC_OTHER, '')
    .replace(BIDI, '');
  const lines: string[] = [];
  let line: string[] = [];
  for (let at = 0; at < unescaped.length; at++) {
    const char = unescaped[at];
    if (char === '\n') {
      lines.push(line.join(''));
      line = [];
    } else if (char === '\r') {
      // `\r\n` ends a line; a lone `\r` redraws it from its start.
      if (unescaped[at + 1] !== '\n') line = [];
    } else if (char === '\b') {
      line.pop();
    } else if (char === '\t' || !isControl(char)) {
      line.push(char);
    }
  }
  lines.push(line.join(''));
  return lines.join('\n');
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
