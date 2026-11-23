import type { PollTrigger } from '@consola/factory-spec';
import type { CommandSpec } from '../ports';
import { layerCommandEnv } from '../steps/commandIO';
import type { PolledItem } from './checkResult';

/*
 * When a poll entry's check is due, and what one leaves behind. Pure: the
 * service keeps one `CheckState` per automation, in memory only, starts the
 * commands through the host's `CommandPort`, and replaces a state with the
 * one these return.
 */

/** Checks running at once across every workspace: a lane of their own, apart from agent turns and `run:` steps. */
export const MAX_CONCURRENT_CHECKS = 2;
/** How far a run of failures stretches the wait, unless `every` is longer. */
export const MAX_BACKOFF_MS = 3_600_000;

/** One automation's checks since start-up. Nothing of it is persisted. */
export interface CheckState {
  /**
   * The check now running, and what its result must still match to count
   * (Call 16): the entry's version, the version allowed, and its secrets'
   * fingerprints when it names any (a rebinding meanwhile drops it).
   */
  running?: {
    version: string;
    acceptedVersion: string | undefined;
    startedAt: string;
    fingerprints?: Record<string, string>;
  };
  /** When the last check ended, as the schedule counts it. Absent until one ends, and again after Allow or a Check now that waits for a slot. */
  lastEndedAt?: string;
  /** Failed checks in a row. */
  failures: number;
  /** What the last check that counted came to: how many items, what fired, or why it failed. */
  outcome?:
    | { at: string; items: number; fired: number; skipped: number; baseline: boolean }
    | { at: string; error: string };
  /**
   * The last successful result, kept in memory only, and the entry's version
   * it was taken at: one taken at another version says nothing about this
   * version's items (another command may have printed it), so it is not
   * this version's latest (`latestResult`).
   */
  result?: { at: string; version: string; items: PolledItem[] };
}

/** When the next check is due: now when it never ran since start-up or Allow. */
export function nextCheckAt(state: CheckState, everyMs: number): number | 'now' {
  if (state.lastEndedAt === undefined) return 'now';
  return Date.parse(state.lastEndedAt) + waitAfter(state.failures, everyMs);
}

/** How long after a check ends the next is due: `every`, doubled per failure in a row, up to the larger of `every` and an hour. */
export function waitAfter(failures: number, everyMs: number): number {
  if (failures <= 0) return everyMs;
  return Math.min(everyMs * 2 ** failures, Math.max(everyMs, MAX_BACKOFF_MS));
}

/** After a check that ended at `at` with a result: the run of failures is over. Its result and outcome are the source's to record. */
export function afterSuccess(state: CheckState, at: string): CheckState {
  return { ...state, lastEndedAt: at, failures: 0 };
}

/** The latest successful result taken at `version`; undefined when there is none since start-up, or only one taken at another. */
export function latestResult(
  state: CheckState | undefined,
  version: string,
): PolledItem[] | undefined {
  return state?.result?.version === version ? state.result.items : undefined;
}

/** After a check that ended at `at` without one: one more failure in a row, and why. */
export function afterFailure(state: CheckState, at: string, error: string): CheckState {
  return { ...state, lastEndedAt: at, failures: state.failures + 1, outcome: { at, error } };
}

/** Due at once, whenever the last check ended. What it found, and its run of failures, are kept. */
export function dueNow(state: CheckState): CheckState {
  const { lastEndedAt: _ended, ...rest } = state;
  return rest;
}

/**
 * A check's command as the executor is handed it: in the workspace's folder,
 * from the login environment and the bound account's token, with only
 * `CONSOLA_AUTOMATION` added (no item exists yet, so there is no `env:`), and
 * git hooks off.
 */
export function checkSpec(input: {
  trigger: PollTrigger;
  automation: string;
  cwd: string;
  logs: { stdout: string; stderr: string };
  base: { env: NodeJS.ProcessEnv; secrets: readonly string[] };
  /** Its `secrets:`' values, each its own variable, read for this check alone. */
  secretValues?: Record<string, string>;
}): CommandSpec {
  const { trigger, logs, base } = input;
  return {
    command: trigger.run,
    cwd: input.cwd,
    env: layerCommandEnv(
      base.env,
      {},
      { CONSOLA_AUTOMATION: input.automation },
      input.secretValues,
    ),
    timeoutMs: trigger.timeoutMs,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
    secrets: [...base.secrets],
  };
}
