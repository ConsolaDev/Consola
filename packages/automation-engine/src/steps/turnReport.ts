import type { StepRun } from '@consola/factory-spec';
import type { TurnInitView, TurnOutcome, TurnReportView, TurnResultView } from '../views';
import type { RunDefinition } from './definition';

/*
 * What a step turn's report means, as pure functions: whether the turn
 * failed and in what words, the reminder's cap, which servers its `init` must
 * show, and how its figures add to the step's record. The host parses the
 * CLI's stream; this reads only the views it hands over.
 */

/** The most of a kept line an error quotes. */
export const ERROR_LINE_MAX = 300;

/**
 * The CLI's text as an error quotes it: its own trailing full stops and
 * spaces dropped, so none is doubled, and cut at `ERROR_LINE_MAX` characters.
 */
function quoted(text: string): string {
  const said = text.trim().replace(/[.\s]+$/, '');
  return said.length > ERROR_LINE_MAX ? `${said.slice(0, ERROR_LINE_MAX)}…` : said;
}

/** Why an unattended turn did not finish, in the words every automation run uses; null when it exited cleanly. */
export function turnFailure(outcome: TurnOutcome): string | null {
  if (outcome.stopped) {
    // Stopped before it answered — by the person, the limit, or a
    // signal — whatever code the process exited with.
    return `It stopped before finishing: ${outcome.stopped.trim().replace(/[.\s]+$/, '')}.`;
  }
  if (outcome.exitCode === 0) return null;
  const said = outcome.lastLine?.trim().replace(/[.\s]+$/, '');
  return `It stopped before finishing (exit ${outcome.exitCode})${said ? `: ${said}` : ''}.`;
}

/** The last line the CLI printed outside its JSON, quoted; undefined when it printed none. */
function lastOtherLine(report: TurnReportView): string | undefined {
  for (let index = report.otherLines.length - 1; index >= 0; index--) {
    const line = quoted(report.otherLines[index]);
    if (line) return line;
  }
  return undefined;
}

/** What a result that did not succeed says: its text, else its API error, else its subtype. */
function resultFailure(result: TurnResultView): string {
  const text = result.text === undefined ? '' : quoted(result.text);
  if (text) return `It stopped before finishing: ${text}.`;
  const status = result.apiErrorStatus === undefined ? '' : quoted(String(result.apiErrorStatus));
  if (status) return `It stopped before finishing: API error ${status}.`;
  return `It stopped before finishing: the CLI reported ${quoted(result.subtype)}.`;
}

/**
 * A reporting turn's failure, first match wins; null when it succeeded. A
 * stop; the turn reaching its cap (`atTurnLimit`: no reminder, and what it
 * set is kept); `is_error`, whatever `subtype` says; a `subtype` that is not
 * `success`; no `result` line at all; a non-zero exit after a clean result.
 * What it quotes is the CLI's own: a result's text, else the last line it
 * printed outside its JSON, never Consola's lines in the pane (`lastLine`).
 * A failed `init` check comes before all of these, in its own words; the
 * caller applies it.
 */
export function reportedFailure(
  outcome: TurnOutcome & { report: TurnReportView },
): { error: string; atTurnLimit: boolean } | null {
  const failed = (error: string) => ({ error, atTurnLimit: false });
  if (outcome.stopped)
    return failed(turnFailure({ exitCode: outcome.exitCode, stopped: outcome.stopped })!);
  const { report, exitCode } = outcome;
  const { result } = report;
  if (result?.subtype === 'error_max_turns') {
    return {
      error:
        report.maxTurns === undefined
          ? 'It hit its turn limit before finishing.'
          : `It hit its limit of ${report.maxTurns} turns before finishing.`,
      atTurnLimit: true,
    };
  }
  if (result && (result.isError || result.subtype !== 'success'))
    return failed(resultFailure(result));
  const line = lastOtherLine(report);
  if (!result) {
    return failed(
      exitCode === 0
        ? `It ended without reporting how its turn went${line ? `: ${line}` : ''}.`
        : `It stopped before finishing (exit ${exitCode})${line ? `: ${line}` : ''}.`,
    );
  }
  if (exitCode !== 0) {
    // A clean result, then a failing exit: what it printed after, else what it answered.
    const said = line ?? (result.text === undefined ? '' : quoted(result.text));
    return failed(`It stopped before finishing (exit ${exitCode})${said ? `: ${said}` : ''}.`);
  }
  return null;
}

/** The reminder turn's cap: 1, and 2 per missing item, an output set counting as one and each document as one. */
export function reminderCap(missing: { outputs: string[]; artifacts: string[] }): number {
  return 1 + 2 * ((missing.outputs.length > 0 ? 1 : 0) + missing.artifacts.length);
}

/**
 * The servers a step's agent grants, which its turn's `init` must show
 * connected. None until agents name servers (slice 2-C).
 */
export function requiredServers(
  _definition: RunDefinition,
  _stepId: string,
): Array<{ name: string }> {
  return [];
}

/**
 * Why a turn's `init` fails its step, in the engine's words: the first
 * required server it did not load, or did not connect; null when every one is
 * there and connected. The CLI would run the turn without it.
 */
export function initProblem(
  required: Array<{ name: string }>,
  init: TurnInitView,
  harnessName: string,
): string | null {
  for (const { name } of required) {
    const server = init.servers.find((candidate) => candidate.name === name);
    if (!server)
      return `\`${name}\` was not loaded: it was removed from ${harnessName}, or it is blocked by its URL.`;
    if (server.status !== 'connected') {
      const where = init.signInHint ? `${harnessName} (${init.signInHint})` : harnessName;
      return `\`${name}\` was not connected (${server.status}). Sign in to it in ${where}, then retry this step.`;
    }
  }
  return null;
}

/**
 * The attempt's cost with one turn's report added. The CLI reports the
 * conversation's cost so far, and every turn of an attempt is one
 * conversation (a new session per attempt; its reminder and its resume after
 * a quit `--resume` it): so the turn's own cost is its total less what the
 * attempt has recorded, and the attempt's is then the total itself (canary
 * row 14, which found a resumed turn's `total_cost_usd` to be the running
 * total). A total below what the attempt recorded can only be a
 * conversation that started over, so it is the turn's own. A turn with no
 * result leaves no figure: a later turn's total holds whatever the CLI kept
 * of it.
 */
function attemptCost(
  recorded: number | undefined,
  reported: number | undefined,
): number | undefined {
  if (reported === undefined) return recorded;
  if (recorded === undefined || reported >= recorded) return reported;
  return recorded + reported;
}

/**
 * `record` with one reporting turn's figures added: its cost (see
 * `attemptCost`), its turns summed, the tools it was refused, the step's own
 * cap (`stepMaxTurns`), and the model its `init` named. A report with no
 * result adds nothing to `turn`.
 */
export function withTurnRecorded(
  record: StepRun,
  report: TurnReportView,
  stepMaxTurns: number | undefined,
): StepRun {
  const model = report.init?.model ?? record.model;
  const withModel: StepRun = model === undefined ? record : { ...record, model };
  const { result } = report;
  if (!result) return withModel;
  const before = record.turn ?? {};
  const costUsd = attemptCost(before.costUsd, result.costUsd);
  const turns = result.turns === undefined ? before.turns : (before.turns ?? 0) + result.turns;
  const deniedTools = [...(before.deniedTools ?? [])];
  for (const tool of result.deniedTools) if (!deniedTools.includes(tool)) deniedTools.push(tool);
  const turn: NonNullable<StepRun['turn']> = {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(stepMaxTurns !== undefined ? { maxTurns: stepMaxTurns } : {}),
    ...(deniedTools.length > 0 ? { deniedTools } : {}),
  };
  return Object.keys(turn).length > 0 ? { ...withModel, turn } : withModel;
}

/** Every step's `turn.costUsd` and every earlier attempt's `costUsd`, summed; undefined when none is set. */
export function runCostOf(steps: StepRun[]): number | undefined {
  let total: number | undefined;
  const add = (cost: number | undefined) => {
    if (cost !== undefined) total = (total ?? 0) + cost;
  };
  for (const step of steps) {
    add(step.turn?.costUsd);
    for (const earlier of step.previous ?? []) add(earlier.costUsd);
  }
  return total;
}
