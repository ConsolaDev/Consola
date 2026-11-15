import type { CommandFile, LogTail, StepRun, StepRunStatus } from '../../../shared/automations';

/** A value past this many characters is collapsed in a `<details>`. */
const LONG_VALUE = 120;

/** What one `env:` entry of a command shows: its name, the template as written, and the value it rendered. */
export interface VariableRow {
  name: string;
  template: string;
  value: string;
  /** Past 120 characters or spanning lines: collapsed rather than read inline. */
  long: boolean;
}

export function variableRows(command: CommandFile): VariableRow[] {
  return command.env.map(({ name, template, value }) => ({
    name,
    template,
    value,
    long: value.length > LONG_VALUE || value.includes('\n'),
  }));
}

/**
 * The step's heading: what it would have done when it only reported, else its
 * id. `dryRun` is the run's own flag; a step is reported only in a dry run, so
 * the status alone decides.
 */
export function stepHeading(record: StepRun, dryRun: boolean): string {
  void dryRun;
  return record.status === 'reported' ? 'Would have run' : record.id;
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
      const listed = [...previous].sort((a, b) => a.attempt - b.attempt).map((earlier) => `${earlier.attempt} ${earlierWords(earlier.status)}`);
      line += ` · earlier: ${listed.join(', ')}`;
    }
    parts.push(line);
  }
  if (record.reminded) parts.push('reminded once');
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** How long the step ran, in ms: to now while it runs. Null before it starts, or with no end. */
export function durationOf(record: StepRun, now: Date): number | null {
  if (!record.startedAt) return null;
  const start = Date.parse(record.startedAt);
  const end = record.finishedAt ? Date.parse(record.finishedAt) : record.status === 'running' ? now.getTime() : NaN;
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
export function visibleTail(initial: LogTail | undefined, full: LogTail | undefined): LogTail | undefined {
  return full && (!initial || initial.bytes === full.bytes) ? full : initial;
}
