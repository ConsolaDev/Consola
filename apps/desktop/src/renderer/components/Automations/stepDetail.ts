import type { CommandFile, StepRun, StepRunStatus } from '../../../shared/automations';

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
 * (`Attempt 2 · earlier: 1 failed, 2 did not run`), then `reminded once` when
 * the agent had to be reminded. Null for a first, unreminded attempt.
 */
export function attemptsLine(record: StepRun): string | null {
  const parts: string[] = [];
  const previous = record.previous ?? [];
  if (record.attempt > 1 || previous.length > 0) {
    let line = `Attempt ${record.attempt}`;
    if (previous.length > 0) {
      const counts = new Map<string, number>();
      for (const earlier of [...previous].sort((a, b) => a.attempt - b.attempt)) {
        const words = earlierWords(earlier.status);
        counts.set(words, (counts.get(words) ?? 0) + 1);
      }
      line += ` · earlier: ${[...counts].map(([words, count]) => `${count} ${words}`).join(', ')}`;
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
