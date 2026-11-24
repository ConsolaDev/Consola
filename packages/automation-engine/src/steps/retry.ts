import { flatSteps } from '@consola/factory-spec';
import type { Step, StepEntry, StepRun, StepRunStatus } from '@consola/factory-spec';
import { CALL_SETTLE_INTERRUPTED, INTERRUPTED_CALL } from './recover';

/*
 * What may start again by itself (slice 3, `on_failure`, Call 8), as pure
 * decisions from the record: only what cannot have acted. A read-only agent
 * whose agent names no MCP server, and a command safe to run in a dry run
 * (`dry_run: run`) that ran to a result, may retry; a command that may push or
 * post, an agent whose server may change things, and a gate a person answered
 * never do. A call (`uses:`, slice 5a) retries when nothing was sent, or when
 * it is safe in a dry run, but never once the tool reported an error or a quit
 * cut it off. A person's stop and a run over its budget retry nothing.
 */

/** The waits before a declared retry: 1, 5, then 15 minutes for every one after. */
export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];

/** The wait before declared retry number `used + 1`: the backoff's, or `override` when the host sets one (tests only, Call 7). */
export function retryDelayMs(used: number, override?: number): number {
  if (override !== undefined) return override;
  return RETRY_BACKOFF_MS[Math.min(Math.max(used, 0), RETRY_BACKOFF_MS.length - 1)];
}

/**
 * Whether a step that just failed retries by itself (Call 8). A `write`
 * agent on `host` never does: it may have done anything the person can
 * (slice 3-B). An `edit` agent, or a `write` one in a sandbox, may, since
 * the host resets the checkout to where the step started first. The agent's
 * `agentTools` and `agentIsolation` are absent for a read-only agent.
 */
export function stepMayRetry(input: {
  step: Step;
  record: StepRun;
  agentNamesServer: boolean;
  stoppedByPerson: boolean;
  overBudget: boolean;
  agentTools?: 'read-only' | 'edit' | 'write';
  agentIsolation?: 'host' | 'sandbox';
}): boolean {
  const { step, record } = input;
  if (step.kind === 'gate' || input.stoppedByPerson || input.overBudget) return false;
  if ((record.retries ?? 0) >= (step.onFailure?.retry ?? 0)) return false;
  if (step.kind === 'agent') {
    if (input.agentTools === 'write' && input.agentIsolation === 'host') return false;
    return !input.agentNamesServer;
  }
  if (step.kind === 'uses') {
    // The tool answered with an error: it did its work, or part of it.
    if (record.call?.isError) return false;
    // No intent recorded: nothing was sent, so it cannot have acted.
    if (record.call?.intentAt === undefined) return true;
    // Sent: it may have happened. Only a call safe in a dry run goes again, never one a quit cut off.
    const cutOff = record.error === INTERRUPTED_CALL || record.error === CALL_SETTLE_INTERRUPTED;
    return step.dryRun === 'run' && !cutOff;
  }
  // A command with a result ran to its end (a timeout ends in a signal); one with only intent may have done its work.
  const ended = record.command?.exitCode !== undefined || record.command?.signal !== undefined;
  return step.dryRun === 'run' && ended;
}

/** An earlier attempt's line that never ran anything: it did not start, or only a dry run reported it. */
const NEVER_STARTED: ReadonlySet<StepRunStatus> = new Set<StepRunStatus>([
  'not-run',
  'skipped',
  'pending',
  'reported',
]);

/**
 * Whether a row's step may have acted in any attempt: its own (a command's
 * recorded intent, an agent step's start, a gate's answer) or an earlier one
 * its `previous` keeps (which holds no intent and no start, so a line counts
 * as started unless it never ran, review S6). Loops are what make earlier
 * attempts: a command that ran in round 1 is a line of its round-2 record.
 */
function started(record: StepRun): boolean {
  const own =
    record.kind === 'run'
      ? record.command?.intentAt !== undefined
      : record.kind === 'uses'
        ? record.call?.intentAt !== undefined
        : record.kind === 'gate'
          ? record.gate?.decision !== undefined
          : record.startedAt !== undefined;
  return own || (record.previous ?? []).some((line) => !NEVER_STARTED.has(line.status));
}

/**
 * Whether a run that just failed starts again by itself: the entry's retry
 * is left, no one stopped it, it is within its budget, and nothing in it
 * could have acted: no command without `dry_run: run`, no agent step naming
 * a server, no write step (its record's `tools`, slice 3-B: its run's
 * checkout is not where it was), no call without `dry_run: run` that
 * recorded its intent (slice 5a), and no gate started in any attempt. A row the definition does not
 * name could have been anything, so it counts as one that acted.
 */
export function entryMayRetry(input: {
  declared: number;
  retried: number;
  entries: readonly StepEntry[];
  records: StepRun[];
  agentNamesServer: (stepId: string) => boolean;
  stoppedByPerson: boolean;
  overBudget: boolean;
}): boolean {
  if (input.stoppedByPerson || input.overBudget || input.retried >= input.declared) return false;
  const steps = new Map(flatSteps(input.entries).map(({ step }) => [step.id, step]));
  return input.records.every((record) => {
    if (record.kind === 'repeat' || !started(record)) return true;
    const step = steps.get(record.id);
    if (!step || step.kind === 'repeat' || step.kind === 'gate') return false;
    if (step.kind === 'agent')
      return record.tools === undefined && !input.agentNamesServer(step.id);
    return step.dryRun === 'run';
  });
}

/** A step whose declared retries are spent: its error, and how many times it ran. */
export function retriesSpentError(error: string, tries: number): string {
  return `${error} (tried ${tries} ${tries === 1 ? 'time' : 'times'})`;
}
